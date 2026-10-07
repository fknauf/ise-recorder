import { afterAll, beforeEach, expect, test, vi } from "vitest";
import { SWRConfig } from "swr";
import { anAppSession } from "../helpers/session";
import { wipeOpfs } from "../helpers/opfs";
import { makeDevice } from "../helpers/media";
import { AppStoreProvider } from "@/lib/hooks/useAppStore";
import { Home } from "@/app/page";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { gatherRecordingsList } from "@/lib/utils/browserStorage";
import { useAppSession } from "@/lib/components/SessionProvider";

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

// These tests are about what the page does and what the uploader sends, not about the
// sign-in dance: the session the page sees is the mocked useAppSession below, so no OIDC
// library is involved -- except for useAutoSignin, which the page calls itself. That one
// counts its calls: whether the page runs it at all is the whole of the auto-signin gate,
// and the two tests at the bottom of this file assert on it.
const oidc = vi.hoisted(() => ({ autoSigninCalls: 0 }));

vi.mock("react-oidc-context", () => ({
  useAutoSignin: () => {
    oidc.autoSigninCalls += 1;
    return { isLoading: false, isAuthenticated: true, error: undefined };
  }
}));

type AppSession = ReturnType<typeof useAppSession>;

const anonymousSession = anAppSession({
  authRequired: false,
  isAuthenticated: false,
  userName: undefined,
  getAccessToken: async () => undefined
});

const authenticatedSession = anAppSession();

const cleanupBetweenTests = async () => {
  // react-spectrum queues toasts globally, outside the React tree, so they survive cleanup()
  // and reappear when the next test mounts a ToastContainer. Only one is shown at a time, so
  // a leftover would hide the next test's toast until its five second timeout elapsed.
  for(const closeButton of screen.queryAllByRole("button", { name: /clear|close|dismiss/i })) {
    fireEvent.click(closeButton);
  }

  localStorage.clear();
  await wipeOpfs();

  cleanup();
};

beforeEach(async () => {
  await cleanupBetweenTests();
  oidc.autoSigninCalls = 0;
});

afterAll(cleanupBetweenTests);

/**
 * Stands in for the backend: answers each request the way server.py does for its URL and
 * method. Every answer is a fresh Response, since a body can only be read once. A recording
 * whose render was requested shows up in the listing as rendering from then on.
 */
function fakeBackend() {
  const rendering: string[] = [];
  const recordingPath = /^\/api\/recordings\/([^/]+)/;

  return vi.fn(async (request: Request) => {
    const { pathname } = new URL(request.url);
    const recording = decodeURIComponent(recordingPath.exec(pathname)?.[1] ?? "");

    if(request.method === "PUT" && (/^\/api\/recordings\/[^/]+\/tracks\/[^/]+\/chunks\/\d+$/).test(pathname)) {
      return new Response(null, { status: 204 });
    } else if(request.method === "POST" && (/^\/api\/recordings\/[^/]+\/render$/).test(pathname)) {
      rendering.push(recording);
      return Response.json({ state: "rendering", name: recording }, { status: 202 });
    } else if(request.method === "GET" && pathname === "/api/recordings") {
      return Response.json(rendering.map(name => ({ state: "rendering", name })));
    } else if(request.method === "DELETE" && (/^\/api\/recordings\/[^/]+$/).test(pathname)) {
      return new Response(null, { status: 204 });
    }

    return Response.json({ detail: "Not Found" }, { status: 404 });
  });
}

/**
 * The page as the app mounts it, with an SWR cache of its own: SWR's default cache is global,
 * so without this a test would start out with whatever listing the one before it fetched.
 */
const page = () =>
  <Provider theme={defaultTheme}>
    <AppStoreProvider serverEnv={{ apiUrl: "http://localhost:5000/" }}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <Home/>
      </SWRConfig>
    </AppStoreProvider>
  </Provider>;

/** Just the page, for the tests that only care about what it decides to render. */
function renderHome(session: AppSession) {
  mockUseAppSession.mockReturnValue(session);

  render(page());
}

/**
 * Drives a complete recording through the UI: adds sources, fills in the lecture details,
 * records for two seconds, stops, and checks the resulting local files. Parameterized by the
 * session so the same session can be run for an unauthenticated deployment and
 * for one behind an OpenID provider.
 */
async function recordAStream(session: AppSession, lectureTitle: string) {
  window.fetch = fakeBackend() as unknown as typeof window.fetch;

  let x = 0;

  const animate = (canvas: HTMLCanvasElement | null) => {
    if(canvas === null) {
      return;
    }

    const renderFunction = () => {
      const ctx = canvas.getContext("2d");

      if(ctx === null) {
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();

      x = (x + 1) % canvas.width;
    };

    const timer = setInterval(renderFunction, 1000 / 30);
    return () => clearInterval(timer);
  };

  mockUseAppSession.mockReturnValue(session);

  const tree = render(
    <>
      {page()}
      <canvas width={384} height={216} data-testid="display-src" ref={animate}/>
      <canvas width={384} height={216} data-testid="video-src" ref={animate}/>
    </>
  );

  const mockDevices: MediaDeviceInfo[] = [
    makeDevice("aaa", "AAA", "videoinput", "Webcam Model T"),
    makeDevice("bbb", "BBB", "audioinput", "Webcam Microphone")
  ];

  const displaySrc = await screen.findByTestId("display-src") as HTMLCanvasElement;
  const displayStream = displaySrc.captureStream();

  const videoSrc = await screen.findByTestId("video-src") as HTMLCanvasElement;
  const videoStream = videoSrc.captureStream();

  const audioCtx = new AudioContext();
  const oscillator = audioCtx.createOscillator();
  const audioDest = audioCtx.createMediaStreamDestination();
  oscillator.connect(audioDest);

  // necessary to keep playwright-chromium from capturing an empty stream for stream.webm (to
  // which this audio stream will be connected), but also breaks the test there the first time
  // running because audioCtx.resume() never resolves. The test runs to completion the second
  // time when npm run test is in watch mode.
  //
  // The reasons for this are rather unclear, possibly related to chromium's notion of media
  // engagement index wrt whether autoplay is allowed/automatically enabled for the audio context.
  // I haven't found a way to make this work from the get-go so far, so for the moment we accept
  // that this test will sometimes produce an empty stream for stream.webm on chromium and skip
  // the file size > 0 test below.
  //
  // oscillator.start()
  // await act(() => audioCtx.resume());

  const audioStream = audioDest.stream;
  const mediaStream = new MediaStream([ ...videoStream.getTracks(), ...audioStream.getTracks() ]);

  expect(mediaStream.getAudioTracks().length).toBe(1);
  expect(mediaStream.getVideoTracks().length).toBe(1);

  let permState = "prompt";

  navigator.permissions.query = vi.fn().mockImplementation(async () => ({ state: permState }));
  navigator.mediaDevices.enumerateDevices = vi.fn().mockResolvedValue(mockDevices);
  navigator.mediaDevices.getDisplayMedia = vi.fn().mockResolvedValue(displayStream);
  navigator.mediaDevices.getUserMedia = vi.fn().mockImplementation(async () => {
    permState = "granted";
    return mediaStream;
  });

  const user = userEvent.setup();

  await user.click(tree.getByText("Add Screen/Window"));
  await user.click(tree.getByText("Add Video Source"));

  const previews = await screen.findAllByTestId(/^preview-/);

  expect(previews.length).toBe(3);
  expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);

  await user.click(tree.getByLabelText("Lecture Title"));
  await user.type(tree.getByLabelText("Lecture Title"), lectureTitle);
  await user.click(tree.getByLabelText("e-Mail"));
  await user.type(tree.getByLabelText("e-Mail"), "speaker@example.com");

  vi.setSystemTime("2025-12-21T12:34:56.789Z");
  const recordingName = `${lectureTitle}_2025-12-21T12.34.56.789Z`;

  await user.click(tree.getByText("Start Recording"));

  await waitFor(() => {
    expect(tree.getByText("Stop Recording")).toBeInTheDocument();
    expect(tree.getByText("Stop Recording")).not.toBeDisabled();
  });

  await act(() => new Promise(resolve => setTimeout(resolve, 2000)));
  await user.click(tree.getByText("Stop Recording"));

  await waitFor(() => {
    expect(tree.getByText("Start Recording")).toBeInTheDocument();
  });

  // wait for the "postprocessing scheduled" toast displayed as part of the end-of-recording
  // sequence. Without this the test framework will intermittently complain about things not
  // being run inside act -- not because we actually run things here that would require act,
  // but because react-spectrum's toast queue does. We're not waiting for the toast to disappear
  // here, so if the test later becomes long-running after this point (more than 5 seconds), the
  // complaints might pop up again.
  // Only one toast is shown at a time. cleanupBetweenTests dismisses leftovers, but that
  // races with the toast animation, so allow for waiting out a previous toast's 5s timeout.
  //
  // Found as a toast naming the recording rather than by its wording: the name is also on
  // the recording's card, and the wording is free to change.
  await screen.findByRole("alertdialog", { name: new RegExp(recordingName) }, { timeout: 8000 });

  // When signed in, the end of the recording also refreshes the server-side listing without
  // waiting for it. Its answer now includes the new recording, so the server storage section
  // re-renders whenever that answer arrives -- outside act unless something waits for it here.
  if(session.isAuthenticated) {
    await screen.findByTestId("ss-card-rendering");
  }

  const recordings = await gatherRecordingsList();

  expect(recordings.length).toBe(1);
  expect(recordings[0].name).toBe(recordingName);
  expect(recordings[0].files.length).toBe(2);
  expect(recordings[0].files[0].name).toBe("overlay.webm");
  expect(recordings[0].files[0].size).toBeGreaterThan(0);
  expect(recordings[0].files[1].name).toBe("stream.webm");
  // Flaky on chromium, see comment above on audioCtx.resume().
  // expect(recordings[0].files[1].size).toBeGreaterThan(0);
  return recordingName;
}

/** Every request the page sent, in order. apiFetch sends each as a single Request. */
const requests = () =>
  vi.mocked(window.fetch).mock.calls.map(([ request ]) => request as Request);

/**
 * How many requests went to one endpoint. Counted per endpoint rather than in total: how many
 * chunks a recording is sent in depends on how long it ran, which a busy machine stretches.
 * Each chunk has a URL of its own, so those are matched by pattern.
 */
const requestsTo = (url: string | RegExp) =>
  requests().filter(request => (typeof url === "string" ? request.url === url : url.test(request.url))).length;

const chunkUrl = (recordingName: string) =>
  new RegExp(`^http://localhost:5000/api/recordings/${RegExp.escape(recordingName)}/tracks/[^/]+/chunks/\\d+$`);

const renderUrl = (recordingName: string) => `http://localhost:5000/api/recordings/${recordingName}/render`;

test("e2e recording a stream works", async () => {
  const recordingName = await recordAStream(anonymousSession, "FOO_101");

  // one job for one recording; a second would render it twice
  expect(requestsTo(renderUrl(recordingName))).toBe(1);
  expect(requestsTo(chunkUrl(recordingName))).toBeGreaterThan(0);
  // not signed in, so there is no listing to fetch
  expect(requestsTo("http://localhost:5000/api/recordings")).toBe(0);

  const chunks = requests().filter(request => chunkUrl(recordingName).test(request.url));
  expect(chunks.every(chunk => chunk.method === "PUT")).toBe(true);
  // between them rather than each: a track's last chunk, or all of stream.webm on chromium
  // (see recordAStream), can be empty
  expect((await Promise.all(chunks.map(chunk => chunk.blob()))).reduce((acc, blob) => acc + blob.size, 0)).toBeGreaterThan(0);

  // the recording is named by the URL; the body only says who gets the report
  const job = requests().find(request => request.url === renderUrl(recordingName))!;
  expect(job.method).toBe("POST");
  expect(job.headers.get("Content-Type")).toBe("application/json");
  expect(await job.json()).toStrictEqual({ recipient: "speaker@example.com" });
});

test("e2e recording a stream sends the access token to the server", async () => {
  const recordingName = await recordAStream(authenticatedSession, "BAR_202");

  expect(requestsTo(renderUrl(recordingName))).toBe(1);
  expect(requestsTo(chunkUrl(recordingName))).toBeGreaterThan(0);

  // the listing is fetched once when the section mounts and once more when the recording
  // finishes, so the new lecture shows up as rendering without waiting for the minute poll.
  // At least twice rather than exactly: SWR also refetches when the window regains focus.
  expect(requestsTo("http://localhost:5000/api/recordings")).toBeGreaterThanOrEqual(2);

  const urls = requests().map(request => request.url);

  // after the job, not merely somewhere: a refresh before it would find nothing rendering
  expect(urls.lastIndexOf("http://localhost:5000/api/recordings"))
    .toBeGreaterThan(urls.indexOf(renderUrl(recordingName)));

  const listing = requests().find(request => request.url === "http://localhost:5000/api/recordings")!;
  expect(listing.method).toBe("GET");
  expect(listing.headers.get("Accept")).toBe("application/json");
  expect(listing.headers.get("Authorization")).toBe("Bearer test-token");

  const chunks = requests().filter(request => chunkUrl(recordingName).test(request.url));
  expect(chunks.every(chunk => chunk.method === "PUT")).toBe(true);
  expect(chunks.every(chunk => chunk.headers.get("Authorization") === "Bearer test-token")).toBe(true);
  expect((await Promise.all(chunks.map(chunk => chunk.blob()))).reduce((acc, blob) => acc + blob.size, 0)).toBeGreaterThan(0);

  const job = requests().find(request => request.url === renderUrl(recordingName))!;
  expect(job.method).toBe("POST");
  expect(job.headers.get("Content-Type")).toBe("application/json");
  expect(job.headers.get("Authorization")).toBe("Bearer test-token");
  expect(await job.json()).toStrictEqual({ recipient: "speaker@example.com" });
});

// --- the auto sign-in gate -------------------------------------------------

test("the page signs in automatically when the session says to", async () => {
  renderHome({ ...authenticatedSession, autoSignin: true });

  await screen.findByText("Start Recording");

  expect(oidc.autoSigninCalls).toBeGreaterThan(0);
});

test("the page stops signing in automatically once the user has signed out", async () => {
  // Sign-out is local only: the provider's SSO cookie is untouched, so useAutoSignin
  // would redirect straight back in and the button would appear to do nothing. The token
  // source turns its autoSignin flag off for the rest of the session, and this gate is
  // what makes that mean anything -- reading env.oidcAutoSignin here instead would
  // reinstate the loop.
  renderHome({ ...authenticatedSession, autoSignin: false });

  await screen.findByText("Start Recording");

  expect(oidc.autoSigninCalls).toBe(0);
});
