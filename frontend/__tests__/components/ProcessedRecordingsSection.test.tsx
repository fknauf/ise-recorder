import { expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { PreprocessedRecordingsSection } from "@/lib/components/ProcessedRecordingsSection";
import { useProcessedRecordings, useRefreshProcessedRecordings } from "@/lib/hooks/useProcessedRecordings";
import { purgeRecording, schedulePostprocessing } from "@/lib/utils/serverStorage";
import { useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";
import * as z from "zod";

vi.mock("@/lib/hooks/useProcessedRecordings");
// the requests are mocked, but the URL builder is kept: which href the link carries is
// exactly what the download tests below are about
vi.mock("@/lib/utils/serverStorage", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/utils/serverStorage")>(),
  schedulePostprocessing: vi.fn(),
  purgeRecording: vi.fn()
}));

// the rerender button reads the recipient from the lecture form, which lives in the app
// store; a factory keeps the store out of these tests
const mockUseLecture = vi.fn();
vi.mock("@/lib/hooks/useLecture", () => ({
  useLecture: () => mockUseLecture()
}));

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
const LECTURER_EMAIL = "lecturer@example.edu";
const getAccessToken = async () => "test-token";
const refreshProcessedRecordings = vi.fn();

const LISTING = {
  user: USER_DIGEST,
  completed: [
    { name: "GVS_2025", size: 1.25 * MiB, totp: "0123456789" },
    { name: "PSU_2026", size: 3.5 * MiB, totp: "9876543210" }
  ],
  rendering: [] as { name: string }[],
  unprocessed: [] as { name: string }[]
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
    getAccessToken,
    signout: async () => {},
    interactiveSignin: async () => {},
    reauthenticate: async () => {},
    expandSession: async () => "still-fresh"
  } satisfies AppSession);

  mockUseLecture.mockReturnValue({
    lectureTitle: "",
    lecturerEmail: LECTURER_EMAIL,
    setLectureTitle: vi.fn(),
    setLecturerEmail: vi.fn()
  });

  refreshProcessedRecordings.mockReset();
  refreshProcessedRecordings.mockResolvedValue(undefined);
  vi.mocked(useRefreshProcessedRecordings).mockReturnValue(refreshProcessedRecordings);
  vi.mocked(schedulePostprocessing).mockReset();
  vi.mocked(schedulePostprocessing).mockResolvedValue(true);
  vi.mocked(purgeRecording).mockReset();
  vi.mocked(purgeRecording).mockResolvedValue(undefined);

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
  // title actually produces. The name is percent-encoded into the path, and the backend
  // decodes it and runs SafeRecording over it again, which the round-trip test on the
  // Python side pins from the other end.
  renderSection({
    data: { user: USER_DIGEST, completed: [ { name: "Übung_2025", size: MiB, totp: "1111111111" } ], rendering: [], unprocessed: [] }
  });

  const link = within(cards()[0]).getByRole("link") as HTMLAnchorElement;

  expect(new URL(link.href).pathname)
    .toBe(`/api/recordings/${USER_DIGEST}/${encodeURIComponent("Übung_2025")}`);
  expect(new URL(link.href).searchParams.get("totp")).toBe("1111111111");
});

test("an empty backend renders the section without any cards", () => {
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [], unprocessed: [] } });

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
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [ { name: "ABC_2026" } ], unprocessed: [] } });

  expect(renderingCards()).toHaveLength(1);
  expect(within(renderingCards()[0]).getByText("ABC_2026")).toBeInTheDocument();
  expect(within(renderingCards()[0]).getByText("Rendering...")).toBeInTheDocument();
  expect(within(renderingCards()[0]).getByRole("progressbar", { name: "Rendering" })).toBeInTheDocument();
  // not counted among the downloads
  expect(cards()).toHaveLength(0);
});

test("a recording that is still rendering offers no download", () => {
  // there is no file yet and no TOTP to put in the link, so anything clickable would 404
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [ { name: "ABC_2026" } ], unprocessed: [] } });

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

// --- rerendering a finished recording --------------------------------------

const rerenderButton = (card: HTMLElement) => within(card).getByRole("button", { name: /Rerender/ });

test("each finished recording offers a rerender", () => {
  renderSection();

  expect(cards()).toHaveLength(2);
  cards().forEach(card => expect(rerenderButton(card)).toBeEnabled());
});

test("a rerender schedules a job for that recording with the form's recipient", async () => {
  renderSection();

  await userEvent.click(rerenderButton(cards()[1]));

  // the recipient is whatever the lecture form holds now, not whoever got the first
  // report: the backend keeps no record of that
  expect(schedulePostprocessing).toHaveBeenCalledExactlyOnceWith(
    { apiUrl: API_URL, streamingImpeded: false, getAccessToken },
    "PSU_2026",
    LECTURER_EMAIL,
    // somebody is sitting in front of the button and can press it again; a retry loop
    // would only leave them looking at a disabled button for no visible reason
    expect.objectContaining({ retries: 0 })
  );
});

test("a scheduled rerender refreshes the listing so the card turns into a rendering one", async () => {
  renderSection();

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(refreshProcessedRecordings).toHaveBeenCalledOnce());
});

test("a rerender the backend refused leaves the listing alone and the button usable", async () => {
  // schedulePostprocessing has already told the lecturer why; there is nothing new to fetch
  renderSection();
  vi.mocked(schedulePostprocessing).mockResolvedValue(false);

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
  expect(refreshProcessedRecordings).not.toHaveBeenCalled();
});

test("the rerender button is disabled while the job request is in flight", async () => {
  // otherwise an impatient second press schedules a duplicate: the backend drops it, but
  // the lecturer gets two confirmations for one rerender
  let answer: (scheduled: boolean) => void = () => {};

  renderSection();

  vi.mocked(schedulePostprocessing).mockReturnValue(new Promise(resolve => {
    answer = resolve;
  }));

  await userEvent.click(rerenderButton(cards()[0]));

  expect(rerenderButton(cards()[0])).toBeDisabled();
  // only the pressed card is busy
  expect(rerenderButton(cards()[1])).toBeEnabled();

  await userEvent.click(rerenderButton(cards()[0]));
  expect(schedulePostprocessing).toHaveBeenCalledOnce();

  answer(false);

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
});

test("the rerender button stays disabled until the refreshed listing is in", async () => {
  // the refresh is what turns the card into a rendering one; re-enabling the button before
  // it lands leaves a window for a duplicate press on a card that is about to go away
  let refreshed: () => void = () => {};

  renderSection();

  refreshProcessedRecordings.mockReturnValue(new Promise<void>(resolve => {
    refreshed = resolve;
  }));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(refreshProcessedRecordings).toHaveBeenCalledOnce());
  expect(rerenderButton(cards()[0])).toBeDisabled();

  refreshed();

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
});

test("a rerender that blows up unexpectedly still gives the button back", async () => {
  // schedulePostprocessing reports its own failures rather than throwing, so this is the
  // case nobody planned for -- and a button stuck disabled until reload is the worst way
  // for it to show
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  renderSection();
  vi.mocked(schedulePostprocessing).mockRejectedValue(new Error("boom"));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
  expect(refreshProcessedRecordings).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("GVS_2025"), expect.any(Error));

  warn.mockRestore();
});

test("a refresh that blows up unexpectedly still gives the button back", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  renderSection();
  refreshProcessedRecordings.mockRejectedValue(new Error("boom"));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
  expect(warn).toHaveBeenCalled();

  warn.mockRestore();
});

// --- recordings whose postprocessing never produced anything ---------------

const unprocessedCards = () => screen.queryAllByTestId("unprocessed-card");

const UNPROCESSED_LISTING = {
  ...LISTING,
  rendering: [ { name: "ABC_2026" } ],
  unprocessed: [ { name: "OLD_2024" }, { name: "XYZ_2025" } ]
};

test("a recording whose postprocessing failed gets a card that says so", () => {
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [], unprocessed: [ { name: "OLD_2024" } ] } });

  expect(unprocessedCards()).toHaveLength(1);
  expect(within(unprocessedCards()[0]).getByText("OLD_2024")).toBeInTheDocument();
  expect(within(unprocessedCards()[0]).getByText("Postprocessing failed.")).toBeInTheDocument();
  // counted as neither of the other two kinds
  expect(cards()).toHaveLength(0);
  expect(renderingCards()).toHaveLength(0);
});

test("a recording whose postprocessing failed offers a rerender but no download", () => {
  // there is no file to download; rendering it again is the only thing to offer
  renderSection({ data: { user: USER_DIGEST, completed: [], rendering: [], unprocessed: [ { name: "OLD_2024" } ] } });

  expect(within(unprocessedCards()[0]).queryByRole("link")).toBeNull();
  expect(rerenderButton(unprocessedCards()[0])).toBeEnabled();
});

test("a rerender of a failed recording schedules a job for it and refreshes the listing", async () => {
  renderSection({ data: UNPROCESSED_LISTING });

  await userEvent.click(rerenderButton(unprocessedCards()[1]));

  expect(schedulePostprocessing).toHaveBeenCalledExactlyOnceWith(
    { apiUrl: API_URL, streamingImpeded: false, getAccessToken },
    "XYZ_2025",
    LECTURER_EMAIL,
    expect.objectContaining({ retries: 0 })
  );
  // the refresh is what turns the failed card into a rendering one
  await waitFor(() => expect(refreshProcessedRecordings).toHaveBeenCalledOnce());
});

test("a failed recording's rerender button is disabled while the job request is in flight", async () => {
  let answer: (scheduled: boolean) => void = () => {};

  renderSection({ data: UNPROCESSED_LISTING });

  vi.mocked(schedulePostprocessing).mockReturnValue(new Promise(resolve => {
    answer = resolve;
  }));

  await userEvent.click(rerenderButton(unprocessedCards()[0]));

  expect(rerenderButton(unprocessedCards()[0])).toBeDisabled();
  // the busy state is per card, not shared with the finished ones
  expect(rerenderButton(unprocessedCards()[1])).toBeEnabled();
  expect(rerenderButton(cards()[0])).toBeEnabled();

  answer(false);

  await waitFor(() => expect(rerenderButton(unprocessedCards()[0])).toBeEnabled());
  expect(refreshProcessedRecordings).not.toHaveBeenCalled();
});

test("the failed cards come after the finished and the rendering ones", () => {
  renderSection({ data: UNPROCESSED_LISTING });

  expect(unprocessedCards()).toHaveLength(2);
  expect(within(unprocessedCards()[0]).getByText("OLD_2024")).toBeInTheDocument();
  expect(within(unprocessedCards()[1]).getByText("XYZ_2025")).toBeInTheDocument();

  const follows = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  expect(follows(cards()[1], renderingCards()[0])).toBe(true);
  expect(follows(renderingCards()[0], unprocessedCards()[0])).toBe(true);
});

test("a stale listing's failed cards are withdrawn with the rest while the error is showing", () => {
  // the Rerender button would post against a listing the section can no longer vouch for
  renderSection({ data: UNPROCESSED_LISTING, error: new Error("server responded 500, ") });

  expect(unprocessedCards()).toHaveLength(0);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

// --- purging ----------------------------------------------------------------
//
// Deleting a recording cannot be undone, so the button only opens a dialog, and nothing is
// sent until the lecturer confirms in it. What the request does once it is sent is
// purgeRecording's business, in serverStorage.test.ts.

const purgeButton = (card: HTMLElement) => within(card).getByRole("button", { name: /Purge/ });
const dialog = () => screen.getByRole("dialog");
const confirmButton = () => within(dialog()).getByRole("button", { name: "Purge" });
const cancelButton = () => within(dialog()).getByRole("button", { name: "Cancel" });

test("finished and failed recordings offer a purge, rendering ones do not", () => {
  renderSection({ data: UNPROCESSED_LISTING });

  cards().forEach(card => expect(purgeButton(card)).toBeInTheDocument());
  unprocessedCards().forEach(card => expect(purgeButton(card)).toBeInTheDocument());
  // deleting it would pull the chunks out from under the render; the backend refuses too
  expect(within(renderingCards()[0]).queryByRole("button", { name: /Purge/ })).toBeNull();
});

test("the purge button asks first and sends nothing", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[1]));

  // the dialog names the recording, so the lecturer can tell which one they are about to lose
  expect(within(dialog()).getByRole("heading", { name: /PSU_2026/ })).toBeInTheDocument();
  expect(within(dialog()).getByText(/can not be undone/)).toBeInTheDocument();
  expect(purgeRecording).not.toHaveBeenCalled();
});

test("the dialog starts on Cancel, so a stray Enter keeps the recording", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[0]));

  await waitFor(() => expect(cancelButton()).toHaveFocus());

  await userEvent.keyboard("{Enter}");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purgeRecording).not.toHaveBeenCalled();
});

test("cancelling closes the dialog and sends nothing", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(cancelButton());

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purgeRecording).not.toHaveBeenCalled();
});

test("escape closes the dialog and sends nothing", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purgeRecording).not.toHaveBeenCalled();
});

test("confirming purges that one recording and refreshes through the section's cache", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[1]));
  await userEvent.click(confirmButton());

  expect(purgeRecording).toHaveBeenCalledExactlyOnceWith(API_URL, "PSU_2026", getAccessToken, refreshProcessedRecordings);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a failed recording can be purged the same way", async () => {
  renderSection({ data: UNPROCESSED_LISTING });

  await userEvent.click(purgeButton(unprocessedCards()[0]));
  await userEvent.click(confirmButton());

  expect(purgeRecording).toHaveBeenCalledExactlyOnceWith(API_URL, "OLD_2024", getAccessToken, refreshProcessedRecordings);
});

test("the dialog stays open and locked while the purge is in flight", async () => {
  // a second press would send a second DELETE, and Cancel would promise something it can
  // no longer deliver once the first one is on its way
  let done: () => void = () => {};

  renderSection();

  vi.mocked(purgeRecording).mockReturnValue(new Promise<void>(resolve => {
    done = resolve;
  }));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());

  expect(confirmButton()).toBeDisabled();
  expect(cancelButton()).toBeDisabled();

  await userEvent.click(confirmButton());
  expect(purgeRecording).toHaveBeenCalledOnce();

  done();

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
