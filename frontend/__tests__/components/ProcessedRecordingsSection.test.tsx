import { expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { PreprocessedRecordingsSection } from "@/lib/components/ProcessedRecordingsSection";
import { useProcessedRecordings } from "@/lib/hooks/useProcessedRecordings";
import { useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";
import * as z from "zod";

vi.mock("@/lib/hooks/useProcessedRecordings");

const mockUseAppSession = vi.fn();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockUseAppSession()
}));

const mockServerEnv = vi.fn();
vi.mock("@/lib/hooks/useServerEnv", () => ({
  useServerEnv: () => mockServerEnv()
}));

const API_URL = "https://record.example.edu";
const USER_DIGEST = "8f14e45fceea167a";

type AppSession = ReturnType<typeof useAppSession>;

const MiB = 2 ** 20;

const LISTING = {
  user: USER_DIGEST,
  completed: [
    { name: "GVS_2025", size: 1.25 * MiB, totp: "0123456789" },
    { name: "PSU_2026", size: 3.5 * MiB, totp: "9876543210" }
  ],
  rendering: [] as { name: string }[]
};

function renderSection(
  {
    serverEnv = { apiUrl: API_URL } as ServerEnv,
    isAuthenticated = true,
    isExpired = false as boolean | undefined,
    data = LISTING as typeof LISTING | null,
    error = undefined as unknown
  } = {}
) {
  mockServerEnv.mockReturnValue(serverEnv);

  mockUseAppSession.mockReturnValue({
    authRequired: true,
    autoSignin: false,
    isAuthenticated,
    isLoading: false,
    isExpired,
    isStale: false,
    error: undefined,
    userName: "lecturer",
    getAccessToken: async () => "test-token",
    signout: async () => {},
    interactiveSignin: async () => {},
    reauthenticate: async () => {},
    expandSession: async () => "still-fresh"
  } satisfies AppSession);

  vi.mocked(useProcessedRecordings).mockReturnValue(
    { data, error } as ReturnType<typeof useProcessedRecordings>
  );

  render(
    <Provider theme={defaultTheme}>
      <PreprocessedRecordingsSection/>
    </Provider>
  );
}

const cards = () => screen.queryAllByTestId("prec-card");

test("each processed recording gets a card with its name and size", () => {
  renderSection();

  expect(cards()).toHaveLength(2);

  expect(within(cards()[0]).getByText("GVS_2025")).toBeInTheDocument();
  expect(within(cards()[0]).getByText("Download (1.25 MiB)")).toBeInTheDocument();
  expect(within(cards()[1]).getByText("PSU_2026")).toBeInTheDocument();
  expect(within(cards()[1]).getByText("Download (3.50 MiB)")).toBeInTheDocument();
});

test("the download link carries the user, the recording and its TOTP", () => {
  renderSection();

  const link = within(cards()[0]).getByRole("link");

  // A link cannot set an Authorization header, so the one-time password in the query
  // string is the whole of the authentication on this request. The href has to name the
  // user directory the backend resolves under, not the display name.
  expect(link).toHaveAttribute(
    "href",
    `${API_URL}/api/recordings/${USER_DIGEST}/GVS_2025?totp=0123456789`
  );
  // without this the browser navigates away from the recorder, which may be mid-recording
  expect(link).toHaveAttribute("download");
});

test("a non-ASCII recording name reaches the backend percent-encoded", () => {
  // SafeRecording accepts any Unicode letter, so this is what a German or Chinese lecture
  // title actually produces. The href is built by interpolation rather than through
  // encodeURIComponent, so what makes this work is the browser encoding the path on its
  // way out -- and the backend decoding it and running SafeRecording over it again, which
  // the round-trip test on the Python side pins from the other end.
  renderSection({
    data: { user: USER_DIGEST, completed: [ { name: "Übung_2025", size: MiB, totp: "1111111111" } ], rendering: [] }
  });

  const link = within(cards()[0]).getByRole("link") as HTMLAnchorElement;

  expect(new URL(link.href).pathname)
    .toBe(`/api/recordings/${USER_DIGEST}/${encodeURIComponent("Übung_2025")}`);
  expect(new URL(link.href).searchParams.get("totp")).toBe("1111111111");
});

test("an empty backend renders the section without any cards", () => {
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [] } });

  expect(screen.getByText("Server-Side Processed Recordings")).toBeInTheDocument();
  expect(cards()).toHaveLength(0);
});

// --- recordings the backend is still rendering -----------------------------

const renderingCards = () => screen.queryAllByTestId("rendering-card");

const RENDERING_LISTING = {
  ...LISTING,
  rendering: [ { name: "ABC_2026" }, { name: "XYZ_2026" } ]
};

test("a recording that is still rendering gets a card that says so", () => {
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [ { name: "ABC_2026" } ] } });

  expect(renderingCards()).toHaveLength(1);
  expect(within(renderingCards()[0]).getByText("ABC_2026")).toBeInTheDocument();
  expect(within(renderingCards()[0]).getByText("Rendering...")).toBeInTheDocument();
  expect(within(renderingCards()[0]).getByRole("progressbar", { name: "Rendering" })).toBeInTheDocument();
  // not counted among the downloads
  expect(cards()).toHaveLength(0);
});

test("a recording that is still rendering offers no download", () => {
  // there is no file yet and no TOTP to put in the link, so anything clickable would 404
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [ { name: "ABC_2026" } ] } });

  expect(within(renderingCards()[0]).queryByRole("link")).toBeNull();
  expect(within(renderingCards()[0]).queryByRole("button")).toBeNull();
});

test("the rendering cards follow the finished ones", () => {
  renderSection({ data: RENDERING_LISTING });

  expect(cards()).toHaveLength(2);
  expect(renderingCards()).toHaveLength(2);

  expect(within(renderingCards()[0]).getByText("ABC_2026")).toBeInTheDocument();
  expect(within(renderingCards()[1]).getByText("XYZ_2026")).toBeInTheDocument();

  // the two kinds carry different test ids, so the order between them is the DOM's
  const lastFinished = cards()[1];
  const firstRendering = renderingCards()[0];

  expect(lastFinished.compareDocumentPosition(firstRendering) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();
});

test("a stale listing's rendering cards are withdrawn with the rest while the error is showing", () => {
  // a spinner for a job the section can no longer see the end of would spin indefinitely
  renderSection({ data: RENDERING_LISTING, error: new Error("server responded 500, ") });

  expect(cards()).toHaveLength(0);
  expect(renderingCards()).toHaveLength(0);
});

test("nothing is rendered before the first listing arrives", () => {
  renderSection({ data: null });

  expect(screen.queryByText("Server-Side Processed Recordings")).toBeNull();
});

// The section is gated on the session rather than on the deployment: the backend refuses
// both endpoints outright when it runs without authentication, and refuses the listing
// without a valid token, so offering the links in those states only produces errors.

test("a deployment without a backend offers no downloads", () => {
  renderSection({ serverEnv: {} });

  expect(screen.queryByText("Server-Side Processed Recordings")).toBeNull();
});

test("a signed-out user is offered no downloads", () => {
  renderSection({ isAuthenticated: false });

  expect(screen.queryByText("Server-Side Processed Recordings")).toBeNull();
});

test("an expired session is offered no downloads", () => {
  renderSection({ isExpired: true });

  expect(screen.queryByText("Server-Side Processed Recordings")).toBeNull();
});

// --- a backend that is not answering ---------------------------------------
//
// The hook lets failures through to SWR rather than swallowing them, so that the lecturer
// is told why the list is missing instead of being shown an empty backend. The section is
// what turns that into something on screen.

test("a failed listing is reported in place of the recordings", () => {
  renderSection({ error: new Error("server responded 503, upstream unavailable") });

  const alert = screen.getByRole("alert");

  expect(within(alert).getByText(/Error fetching list of processed recordings/)).toBeInTheDocument();
  // the message carries the status and the server's own explanation, which is the
  // difference between "try again later" and "tell the admin"
  expect(within(alert).getByText(/server responded 503, upstream unavailable/)).toBeInTheDocument();
});

test("the section keeps its heading while it is failing", () => {
  renderSection({ error: new Error("boom") });

  // otherwise the alert floats without saying which part of the page is broken
  expect(screen.getByText("Server-Side Processed Recordings")).toBeInTheDocument();
});

test("a stale listing is withdrawn while the error is showing", () => {
  // SWR holds the last good data through a failure, and every TOTP in it is good for one
  // interval. Rendering both would offer download links that have already stopped working.
  renderSection({ data: LISTING, error: new Error("server responded 500, ") });

  expect(cards()).toHaveLength(0);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

test("a backend that sent nonsense is reported in words rather than as a JSON dump", () => {
  // A ZodError's own message is the stringified issue array, several lines of JSON. It is
  // an Error, so an instanceof check alone would put that straight on screen.
  const schema = z.object({ completed: z.array(z.object({ size: z.number() })) });
  const error = schema.safeParse({ completed: [ { size: "1024" } ] }).error;

  renderSection({ error });

  const alert = screen.getByRole("alert");

  expect(within(alert).getByText(/expected number, received string/)).toBeInTheDocument();
  expect(within(alert).getByText(/completed\[0\].size/)).toBeInTheDocument();
  // the raw message would have brought the whole issue array with it
  expect(alert.textContent).not.toContain('"code"');
});

test("a failure with no message still says something", () => {
  // SWR passes the thrown value through untouched, and a fetcher can be made to reject
  // with something that is not an Error at all
  renderSection({ error: "not an error object" });

  expect(within(screen.getByRole("alert")).getByText(/Unknown error/)).toBeInTheDocument();
});
