import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ReactNode } from "react";
import { SWRConfig } from "swr";
import { useProcessedRecordings, useRefreshProcessedRecordings } from "@/lib/hooks/useProcessedRecordings";
import { useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";
import * as z from "zod";

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

const mockServerEnv = vi.fn();
vi.mock("@/lib/hooks/useServerEnv", () => ({
  useServerEnv: () => mockServerEnv()
}));

const API_URL = "https://record.example.edu";

type AppSession = ReturnType<typeof useAppSession>;

const session = (getAccessToken: AppSession["getAccessToken"]): AppSession => ({
  authRequired: true,
  autoSignin: false,
  isAuthenticated: true,
  isLoading: false,
  isExpired: false,
  isStale: false,
  error: undefined,
  userName: "lecturer",
  getAccessToken,
  signout: async () => {},
  interactiveSignin: async () => {},
  reauthenticate: async () => {},
  expandSession: async () => "still-fresh"
});

const LISTING = {
  user: "8f14e45fceea167a",
  completed: [
    { name: "GVS_2025", size: 1024, totp: "0123456789" },
    { name: "PSU_2026", size: 2048, totp: "9876543210" }
  ],
  rendering: [ { name: "ABC_2026" } ],
  unprocessed: [ { name: "XYZ_2024" } ]
};

/**
 * SWR keeps one cache per provider, and it is global by default -- a listing fetched in
 * one test would be served from cache as the initial data of the next one, hiding whether
 * the hook fetched at all. A fresh Map per render isolates them.
 *
 * Note that anything which drives a revalidation by hand -- `mutate()` below -- has to run
 * inside act(): what settles at the end of it is React state, and React warns about the
 * update otherwise.
 */
function swrWrapper() {
  const Wrapper = ({ children }: Readonly<{ children: ReactNode }>) =>
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>;

  Wrapper.displayName = "SwrTestWrapper";
  return Wrapper;
}

function renderPreprocessedRecordings(
  {
    serverEnv = { apiUrl: API_URL } as ServerEnv,
    getAccessToken = (async () => "test-token") as AppSession["getAccessToken"]
  } = {}
) {
  mockServerEnv.mockReturnValue(serverEnv);
  mockUseAppSession.mockReturnValue(session(getAccessToken));

  return renderHook(useProcessedRecordings, { wrapper: swrWrapper() });
}

/**
 * A Response body can only be read once, so every one of these has to be built per call --
 * mockResolvedValue would hand the same instance to the second poll and turn it into a
 * "body stream already read" failure that looks exactly like a malformed listing.
 */
const respondWith = (make: () => Response) => fetchMock.mockImplementation(async () => make());

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the listing is fetched from the configured backend with the access token", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  expect(fetchMock).toHaveBeenCalledTimes(1);

  const [ url, request ] = fetchMock.mock.calls[0];

  expect(url).toBe(`${API_URL}/api/recordings`);
  expect(request.method).toBe("GET");
  // the listing is per-user, so it has to be authenticated -- unlike the download itself,
  // which carries a TOTP in the query string because a link cannot set a header
  expect((request.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
});

test("nothing is fetched when the deployment has no backend", async () => {
  const { result } = renderPreprocessedRecordings({ serverEnv: {} });

  // the null SWR key is what disables the poll; without it the hook would retry against
  // "undefined/api/recordings" every minute for the whole session
  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.data).toBeNull();
});

test("no request is made when there is no access token to send", async () => {
  const { result } = renderPreprocessedRecordings({ getAccessToken: async () => undefined });

  await waitFor(() => expect(result.current.isLoading).toBe(false));

  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.data).toBeNull();
  // not a failure, so no alert: this is the gap between the session going away and the
  // section noticing and unmounting
  expect(result.current.error).toBeUndefined();
});

test("a fresh token is requested for every poll rather than captured once", async () => {
  // the listing refreshes on an interval for as long as the page is open, which outlives
  // any single access token
  const getAccessToken = vi.fn()
    .mockResolvedValueOnce("first-token")
    .mockResolvedValue("second-token");

  respondWith(() => jsonResponse(LISTING));

  const { result } = renderPreprocessedRecordings({ getAccessToken });

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  await act(async () => {
    await result.current.mutate();
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

  expect((fetchMock.mock.calls[1][1].headers as Record<string, string>).Authorization)
    .toBe("Bearer second-token");
});

// --- what a failure does ---------------------------------------------------
//
// The fetcher throws rather than resolving with null, so failures reach SWR's error state
// and the section can say what went wrong. Two consequences come with that and are pinned
// below: SWR keeps the last `data` alongside the error, so hiding the stale listing is the
// section's job and not the hook's; and refreshInterval is suspended while an error is
// cached, so the error-retry chain -- not the minute poll -- is what keeps trying.

test("re-rendering does not set off another request", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result, rerender } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.data).toEqual(LISTING));

  // The fetcher is built fresh on every render rather than memoised, which is fine because
  // SWR reads it through a ref at revalidation time -- and is what keeps the retry chain
  // on the current getAccessToken. It would not be fine if its identity reached the key.
  rerender();
  rerender();

  await act(async () => {});

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a rejected listing surfaces the status and the server's explanation", async () => {
  // what FastAPI answers an HTTPException with
  respondWith(() => jsonResponse({ detail: "Not authenticated" }, 401));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  // the section renders this straight into an alert, so it has to say which of "the
  // backend is down", "you are not allowed" and "it sent nonsense" actually happened
  expect(result.current.error).toBeInstanceOf(Error);
  expect(result.current.error.message).toContain("401");
  expect(result.current.error.message).toContain("Not authenticated");
});

test("a body that is not JSON is left out rather than put on screen", async () => {
  // a gateway between the browser and the backend answers in HTML, not in FastAPI's
  // shape. The status alone is the useful part; the page would fill the alert.
  respondWith(() => new Response(
    "<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html>",
    { status: 502, headers: { "Content-Type": "text/html" } }
  ));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error.message).toContain("502");
  expect(result.current.error.message).not.toContain("<");
});

// A JSON body is not necessarily a FastAPI body. Anything in front of the backend can
// answer JSON of its own shape, and reading `detail` off it without checking what came
// back puts "undefined" in front of the lecturer. FastAPI itself has a second shape too:
// a RequestValidationError's detail is an array of issue objects, which interpolates as
// "[object Object]". Requiring a string covers both.
test("a JSON body with no string detail is left out rather than stringified", async () => {
  respondWith(() => jsonResponse({ error: "upstream refused" }, 503));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error.message).toContain("503");
  expect(result.current.error.message).not.toContain("undefined");
});

test("a malformed listing is a failure rather than something to render", async () => {
  // size as a string is what a backend change would most plausibly produce, and it would
  // otherwise reach the MiB formatter as NaN
  respondWith(() => jsonResponse({ user: "u", completed: [ { name: "x", size: "1024", totp: "1" } ], rendering: [], unprocessed: [] }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  // the section branches on this type to prettify it, so letting zod's own error through
  // rather than rewrapping it is part of the contract
  expect(result.current.error).toBeInstanceOf(z.ZodError);
  expect(result.current.data).toBeNull();
});

test("a backend that cannot be reached at all fails the same way", async () => {
  // fetch() rejects rather than resolving when the request never got an answer -- backend
  // down, DNS, CORS, the machine offline. That path is not wrapped, so what makes it
  // behave like the others is that none of them are caught either.
  fetchMock.mockRejectedValue(new TypeError("NetworkError when attempting to fetch resource."));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(TypeError);
});

test("a failed poll leaves the previous listing in the cache for the section to suppress", async () => {
  respondWith(() => jsonResponse(LISTING));

  const { result } = renderPreprocessedRecordings();

  // read `error` before the failure, not only after it: SWR tracks which fields the caller
  // touches and skips the re-render when an untouched one changes, so waiting on `error`
  // for the first time after the fact would wait forever
  await waitFor(() => expect(result.current.data).toEqual(LISTING));
  expect(result.current.error).toBeUndefined();

  respondWith(() => new Response("nope", { status: 500 }));

  await act(async () => {
    await result.current.mutate().catch(() => null);
  });

  await waitFor(() => expect(result.current.error).toBeDefined());

  // SWR holds the last good data through an error. Every TOTP in it is good for one
  // interval, so a section that rendered `data` without checking `error` would go on
  // offering links that have already stopped working.
  expect(result.current.data).toEqual(LISTING);
});

test("a recovered poll clears the error so the minute refresh resumes", async () => {
  respondWith(() => new Response("nope", { status: 500 }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  respondWith(() => jsonResponse(LISTING));

  await act(async () => {
    await result.current.mutate();
  });

  // refreshInterval skips revalidation entirely while an error is cached, so clearing it
  // is what hands the polling back from the retry chain to the interval
  await waitFor(() => expect(result.current.error).toBeUndefined());
  expect(result.current.data).toEqual(LISTING);
});

// --- the listing's shape ---------------------------------------------------

test("a listing in the old shape of /api/completed is refused rather than half-rendered", async () => {
  // what a backend that has not been updated alongside the frontend answers: `recordings`
  // in place of `completed`, and no `rendering` at all
  respondWith(() => jsonResponse({ user: "u", recordings: [ { name: "x", size: 1024, totp: "1" } ] }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(z.ZodError);
});

test("a listing without the rendering entries is refused", async () => {
  respondWith(() => jsonResponse({ user: "u", completed: [], unprocessed: [] }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(z.ZodError);
});

test("a listing without the unprocessed entries is refused", async () => {
  // what a backend from before failed renders were listed answers
  respondWith(() => jsonResponse({ user: "u", completed: [], rendering: [] }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(z.ZodError);
});

test("an unprocessed entry without a name is refused", async () => {
  // the name is what the Rerender button posts back as the job's recording
  respondWith(() => jsonResponse({ user: "u", completed: [], rendering: [], unprocessed: [ {} ] }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(z.ZodError);
});

test("a rendering entry without a name is refused", async () => {
  respondWith(() => jsonResponse({ user: "u", completed: [], rendering: [ {} ], unprocessed: [] }));

  const { result } = renderPreprocessedRecordings();

  await waitFor(() => expect(result.current.error).toBeDefined());

  expect(result.current.error).toBeInstanceOf(z.ZodError);
});

// --- refreshing from outside the section -----------------------------------
//
// useRefreshProcessedRecordings is what the recorder calls once a recording is finished.
// It goes through the mutate of the nearest SWRConfig, so it has to reach the same cache
// the listing lives in -- here the fresh-Map wrapper's, which the global mutate would miss.

test("a refresh fetches the listing again without waiting for the poll", async () => {
  mockServerEnv.mockReturnValue({ apiUrl: API_URL });
  mockUseAppSession.mockReturnValue(session(async () => "test-token"));

  const after = { ...LISTING, rendering: [ ...LISTING.rendering, { name: "NEW_2026" } ] };

  respondWith(() => jsonResponse(LISTING));

  const { result } = renderHook(
    () => ({ listing: useProcessedRecordings(), refresh: useRefreshProcessedRecordings() }),
    { wrapper: swrWrapper() }
  );

  await waitFor(() => expect(result.current.listing.data).toEqual(LISTING));

  respondWith(() => jsonResponse(after));

  await act(async () => {
    await result.current.refresh();
  });

  await waitFor(() => expect(result.current.listing.data).toEqual(after));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a refresh from outside the listing's cache does not reach it", async () => {
  // the counterpart of the above: the refresh is scoped to its SWRConfig. A recorder
  // mounted under a different cache than the section would refresh nothing, which is
  // what the e2e test guards against for the real page.
  mockServerEnv.mockReturnValue({ apiUrl: API_URL });
  mockUseAppSession.mockReturnValue(session(async () => "test-token"));

  respondWith(() => jsonResponse(LISTING));

  const listing = renderHook(useProcessedRecordings, { wrapper: swrWrapper() });
  const elsewhere = renderHook(useRefreshProcessedRecordings, { wrapper: swrWrapper() });

  await waitFor(() => expect(listing.result.current.data).toEqual(LISTING));

  await act(async () => {
    await elsewhere.result.current();
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
});
