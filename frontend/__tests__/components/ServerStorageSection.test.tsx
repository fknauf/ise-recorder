import { expect, test, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { ServerStorageSection } from "@/lib/components/ServerStorageSection";
import { useProcessedRecordings } from "@/lib/hooks/useProcessedRecordings";
import { fetchProcessedRecordings, purgeRecording, schedulePostprocessing, ServerStorageRecording } from "@/lib/utils/serverStorage";
import { ApiError } from "@/lib/utils/apiFetch";
import { showError, showSuccess } from "@/lib/utils/notifications";
import { useAppSession } from "@/lib/components/SessionProvider";
import { ServerEnv } from "@/lib/utils/serverEnv";
import { SWRConfig } from "swr";
import * as z from "zod";
import { ExpandedSection, SECTION_ID } from "./ExpandedSection";

vi.mock("@/lib/hooks/useProcessedRecordings");
// the requests are mocked, but the URL builder is kept: which href the link carries is
// exactly what the download tests below are about
vi.mock("@/lib/utils/serverStorage", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/utils/serverStorage")>(),
  fetchProcessedRecordings: vi.fn(),
  schedulePostprocessing: vi.fn(),
  purgeRecording: vi.fn()
}));
vi.mock("@/lib/utils/notifications", () => ({
  // An explicit factory, not automocking: vi.mock() alone yields spies that still call
  // through, and real toasts outlive the test that raised them.
  showError: vi.fn(),
  showSuccess: vi.fn(),
  showMessage: vi.fn()
}));

// a rerender reads the recipient from the lecture form, which lives in the app store; a
// factory keeps the store out of these tests
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

// what the mocked hook hands the cards; the tests that run the real one pass `hook` instead
const rerender = vi.fn<ReturnType<typeof useProcessedRecordings>["rerender"]>();
const purge = vi.fn<ReturnType<typeof useProcessedRecordings>["purge"]>();

type Listing = ServerStorageRecording[];

/** The backend lists every recording in one array, whatever state it is in, sorted by name. */
const sorted = (listing: Listing) => listing.toSorted((a, b) => a.name.localeCompare(b.name));

const LISTING: Listing = [
  { state: "completed", name: "GVS_2025", size: 1.25 * MiB, downloadUrl: `downloads/${USER_DIGEST}/GVS_2025?totp=012345` },
  { state: "completed", name: "PSU_2026", size: 3.5 * MiB, downloadUrl: `downloads/${USER_DIGEST}/PSU_2026?totp=987654` }
];

/** The listing with one recording gone from it, whichever kind it is. */
const without = (listing: Listing, name: string): Listing => listing.filter(rec => rec.name !== name);

/** The listing with one recording turned into a rendering one, in the place it already had. */
const asRendering = (listing: Listing, name: string): Listing =>
  listing.map(rec => (rec.name === name ? { state: "rendering", name } : rec));

const rendering = (name: string): ServerStorageRecording => ({ state: "rendering", name });
const unprocessed = (name: string): ServerStorageRecording => ({ state: "unprocessed", name });

interface SectionOptions {
  serverEnv?: ServerEnv
  isAuthenticated?: boolean
  isExpired?: boolean | undefined
  /** What the mocked hook reports. Left out, the listing above; undefined, nothing yet. */
  data?: Listing | undefined
  error?: unknown
  /** In place of data and error: run this as the hook, e.g. the real one over its cache. */
  hook?: typeof useProcessedRecordings
}

function renderSection(options: SectionOptions = {}) {
  const {
    serverEnv = { apiUrl: API_URL } as ServerEnv,
    isAuthenticated = true,
    isExpired = false,
    error = undefined,
    hook
  } = options;
  // told apart from the default by presence, since undefined is itself a state to render
  const data = "data" in options ? options.data : LISTING;

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
    expandSession: async () => "can-stream"
  } satisfies AppSession);

  mockUseLecture.mockReturnValue({
    lectureTitle: "",
    lecturerEmail: LECTURER_EMAIL,
    setLectureTitle: vi.fn(),
    setLecturerEmail: vi.fn()
  });

  vi.mocked(schedulePostprocessing).mockReset();
  // what the backend answers an accepted rerender with: the recording's new state
  vi.mocked(schedulePostprocessing).mockImplementation(async (_destination, name) => ({ state: "rendering", name }));
  vi.mocked(purgeRecording).mockReset();
  rerender.mockReset();
  rerender.mockResolvedValue(undefined);
  purge.mockReset();
  purge.mockResolvedValue(undefined);

  if(hook !== undefined) {
    vi.mocked(useProcessedRecordings).mockImplementation(hook);
  } else {
    vi.mocked(useProcessedRecordings).mockReturnValue(
      { data, error, rerender, purge } as unknown as ReturnType<typeof useProcessedRecordings>
    );
  }

  // a cache per test, for the tests that run the real hook; the others never reach it
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <Provider theme={defaultTheme}>
        <ExpandedSection>
          <ServerStorageSection id={SECTION_ID}/>
        </ExpandedSection>
      </Provider>
    </SWRConfig>
  );
}

const cards = () => screen.queryAllByTestId("prec-card");

const names = (cardList: HTMLElement[]) =>
  cardList.map(card => within(card).getByText(/_20\d\d$/).textContent);

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
  // string is the whole of the authentication on this request. The backend hands over the
  // path, user directory and TOTP included, relative to its API root; the href is that
  // resolved against the configured backend, not rebuilt from the display name.
  expect(link).toHaveAttribute(
    "href",
    `${API_URL}/api/downloads/${USER_DIGEST}/GVS_2025?totp=012345`
  );
  // without this the browser navigates away from the recorder, which may be mid-recording
  expect(link).toHaveAttribute("download");
});

test("the download opens in a tab of its own", () => {
  // The download attribute is ignored for a backend on another origin, and the backend
  // answers a TOTP that has lapsed -- after a backend restart, say -- with a JSON error
  // rather than a file. In the recorder's own tab that error would replace the page; in a
  // tab of its own it leaves the recorder alone, and a successful download closes the tab.
  renderSection();

  expect(within(cards()[0]).getByRole("link")).toHaveAttribute("target", "_blank");
});

test("a non-ASCII recording name reaches the backend percent-encoded", () => {
  // SafeRecording accepts any Unicode letter, so this is what a German or Chinese lecture
  // title actually produces. The backend percent-encodes the name into the download path
  // it lists, decodes it on the way back and runs SafeRecording over it again, which the
  // round-trip test on the Python side pins from the other end. The link has to carry the
  // encoding through untouched.
  renderSection({
    data: [
      {
        state: "completed",
        name: "Übung_2025",
        size: MiB,
        downloadUrl: `downloads/${USER_DIGEST}/${encodeURIComponent("Übung_2025")}?totp=111111`
      }
    ]
  });

  const link = within(cards()[0]).getByRole("link") as HTMLAnchorElement;

  expect(new URL(link.href).pathname)
    .toBe(`/api/downloads/${USER_DIGEST}/${encodeURIComponent("Übung_2025")}`);
  expect(new URL(link.href).searchParams.get("totp")).toBe("111111");
});

test("an empty backend does not render the section", () => {
  renderSection({ data: [] });

  expect(screen.queryByText("Server-Side Processed Recordings")).not.toBeInTheDocument();
});

// --- recordings the backend is still rendering -----------------------------

const renderingCards = () => screen.queryAllByTestId("rendering-card");

const RENDERING_LISTING = sorted([ ...LISTING, rendering("ABC_2026"), rendering("XYZ_2026") ]);

/** Every card in the section, whichever kind, in the order they appear on the page. */
const allCards = () => screen.queryAllByTestId(/^(prec|rendering|unprocessed)-card$/);

test("a recording that is still rendering gets a card that says so", () => {
  renderSection({ data: [ rendering("ABC_2026") ] });

  expect(renderingCards()).toHaveLength(1);
  expect(within(renderingCards()[0]).getByText("ABC_2026")).toBeInTheDocument();
  expect(within(renderingCards()[0]).getByText("Rendering...")).toBeInTheDocument();
  expect(within(renderingCards()[0]).getByRole("progressbar")).toBeVisible();
  // not counted among the downloads
  expect(cards()).toHaveLength(0);
});

test("a recording that is still rendering offers no download", () => {
  // there is no file yet and no TOTP to put in the link, so anything clickable would 404
  renderSection({ data: [ rendering("ABC_2026") ] });

  expect(within(renderingCards()[0]).queryByRole("link")).toBeNull();
  expect(within(renderingCards()[0]).queryByRole("button")).toBeNull();
});

test("the rendering cards sit among the finished ones in the order the server lists them", () => {
  // the backend sorts by name whatever the state, and the section keeps to that rather than
  // grouping by kind -- so a card that starts or finishes rendering stays where it was
  renderSection({ data: RENDERING_LISTING });

  expect(cards()).toHaveLength(2);
  expect(renderingCards()).toHaveLength(2);

  // the two kinds carry different test ids, so the order between them is the DOM's
  expect(names(allCards())).toStrictEqual([ "ABC_2026", "GVS_2025", "PSU_2026", "XYZ_2026" ]);
  expect(allCards()[0]).toBe(renderingCards()[0]);
  expect(allCards()[3]).toBe(renderingCards()[1]);
});

test("the cards are in the server's order even where that is not by name", () => {
  // the order is the backend's to decide; the section does not sort on its own account
  renderSection({ data: [ RENDERING_LISTING[3], RENDERING_LISTING[1], RENDERING_LISTING[0], RENDERING_LISTING[2] ] });

  expect(names(allCards())).toStrictEqual([ "XYZ_2026", "GVS_2025", "ABC_2026", "PSU_2026" ]);
});

test("a stale listing's rendering cards are withdrawn with the rest while the error is showing", () => {
  // a spinner for a job the section can no longer see the end of would spin indefinitely
  renderSection({ data: RENDERING_LISTING, error: new ApiError("HTTP 500", "http", 500) });

  expect(cards()).toHaveLength(0);
  expect(renderingCards()).toHaveLength(0);
});

// --- the real hook over a cache of its own ---------------------------------

/**
 * A rerender and a purge go through SWR's mutate -- the card moves at once, and moves back if
 * the backend refuses -- so the tests about that run the real hook over a cache of their own,
 * with only the requests beneath it faked. Resolves once the listing is on screen.
 *
 * A purge is answered the way the backend does: with nothing, after which the listing no
 * longer has the recording.
 */
async function renderSectionWithCache(listing: Listing = LISTING) {
  const actual = await vi.importActual<typeof import("@/lib/hooks/useProcessedRecordings")>("@/lib/hooks/useProcessedRecordings");

  vi.mocked(fetchProcessedRecordings).mockResolvedValue(listing);
  renderSection({ hook: actual.useProcessedRecordings });
  // the backend only lists the recording without it once the purge is through, so a fetch
  // that merely happened to run earlier cannot pass for the one after it
  vi.mocked(purgeRecording).mockImplementation(async (_destination, name) => {
    vi.mocked(fetchProcessedRecordings).mockResolvedValue(without(listing, name));
  });

  await waitFor(() => expect(screen.getByText("Server-Side Processed Recordings")).toBeInTheDocument());
}

/** From here on the listing is not answered, so whatever is on screen is what the cache holds. */
const holdFurtherListings = () =>
  vi.mocked(fetchProcessedRecordings).mockReturnValue(new Promise(() => {}));


// --- rerendering a finished recording --------------------------------------

// Controls are found by test id rather than by label, so rewording or restyling a button --
// down to an icon with no text -- does not break the tests that are about what it does.
const rerenderButton = (card: HTMLElement) => within(card).getByTestId("prec-btn-rerender");
const purgeButton = (card: HTMLElement) => within(card).getByTestId("prec-btn-purge");

test("each finished recording offers a rerender", () => {
  renderSection();

  expect(cards()).toHaveLength(2);
  cards().forEach(card => expect(rerenderButton(card)).toBeEnabled());
});

test("a rerender schedules a job for that recording with the form's recipient", async () => {
  await renderSectionWithCache();

  await userEvent.click(rerenderButton(cards()[1]));

  // the recipient is whatever the lecture form holds now, not whoever got the first
  // report: the backend keeps no record of that
  expect(schedulePostprocessing).toHaveBeenCalledExactlyOnceWith(
    { apiUrl: API_URL, getAccessToken },
    "PSU_2026",
    LECTURER_EMAIL,
    // nothing to abort it with: somebody is sitting in front of the button, and the card is
    // locked only for as long as this one request takes
    undefined
  );
});

test("a rerendered card turns into a rendering one before the backend has answered", async () => {
  await renderSectionWithCache();
  holdFurtherListings();
  vi.mocked(schedulePostprocessing).mockReturnValue(new Promise(() => {}));

  await userEvent.click(rerenderButton(cards()[0]));

  // the lecturer sees the press land at once, and has no second button to press
  await waitFor(() => expect(names(renderingCards())).toStrictEqual([ "GVS_2025" ]));
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);
});

test("a scheduled rerender is confirmed by name", async () => {
  renderSection();

  await userEvent.click(rerenderButton(cards()[1]));

  expect(rerender).toHaveBeenCalledExactlyOnceWith("PSU_2026");
  await waitFor(() => expect(showSuccess).toHaveBeenCalledExactlyOnceWith("Re-rendering scheduled for PSU_2026"));
  expect(showError).not.toHaveBeenCalled();
});

test("a scheduled rerender fetches the listing again rather than trusting its own guess", async () => {
  // anything else that changed on the backend in the meantime comes along with it
  await renderSectionWithCache();

  const after = sorted([ ...asRendering(LISTING, "GVS_2025"), rendering("NEW_2026") ]);

  // the backend only answers with the new listing once the job is accepted, so a fetch
  // that merely happened to run earlier cannot pass for the one after the rerender
  vi.mocked(schedulePostprocessing).mockImplementation(async (_destination, name) => {
    vi.mocked(fetchProcessedRecordings).mockResolvedValue(after);
    return { state: "rendering", name };
  });

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(names(renderingCards())).toStrictEqual([ "GVS_2025", "NEW_2026" ]));
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);
});

test("the rerendered card stays a rendering one while the listing is fetched again", async () => {
  // the job is accepted, but the listing that shows it rendering is not in yet; the card
  // must not come back with its button in that window, or a second press schedules a
  // duplicate
  await renderSectionWithCache();
  holdFurtherListings();

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(showSuccess).toHaveBeenCalledOnce());
  expect(names(renderingCards())).toStrictEqual([ "GVS_2025" ]);
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);
  expect(schedulePostprocessing).toHaveBeenCalledOnce();
});

test("a refused rerender puts the card back and says why", async () => {
  await renderSectionWithCache();
  // so that nothing but the rollback can bring the card back
  holdFurtherListings();
  vi.mocked(schedulePostprocessing).mockRejectedValue(new ApiError("HTTP 409: already rendering", "http", 409, "already rendering"));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(showError).toHaveBeenCalledOnce());
  expect(showError).toHaveBeenCalledWith(
    "Unable to schedule re-rendering for GVS_2025",
    expect.objectContaining({ message: expect.stringContaining("already rendering") })
  );
  expect(showSuccess).not.toHaveBeenCalled();
  expect(names(cards())).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
  expect(renderingCards()).toHaveLength(0);
  // and it can be pressed again
  expect(rerenderButton(cards()[0])).toBeEnabled();
});

test("a refused rerender still fetches the listing again", async () => {
  // A refusal usually means the listing was out of date -- the recording is rendering
  // already, or gone -- so fetching it again is what brings the card up to date.
  await renderSectionWithCache();

  const after = asRendering(LISTING, "GVS_2025");

  vi.mocked(schedulePostprocessing).mockImplementation(async () => {
    vi.mocked(fetchProcessedRecordings).mockResolvedValue(after);
    throw new ApiError("HTTP 409: already rendering", "http", 409, "already rendering");
  });

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(names(renderingCards())).toStrictEqual([ "GVS_2025" ]));
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);
});

test("a rerender that blows up unexpectedly puts the card back and says why", async () => {
  // schedulePostprocessing turns every failure it knows of into an ApiError, so something
  // else being thrown is the case nobody planned for -- and a card stuck as rendering until
  // reload is the worst way for it to show
  await renderSectionWithCache();
  holdFurtherListings();
  vi.mocked(schedulePostprocessing).mockRejectedValue(new Error("boom"));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(showError).toHaveBeenCalledOnce());
  expect(showError).toHaveBeenCalledWith(expect.stringContaining("GVS_2025"), expect.objectContaining({ message: "boom" }));
  expect(names(cards())).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
  expect(rerenderButton(cards()[0])).toBeEnabled();
});

test("a listing that fails to come back after a rerender is reported in place of the recordings", async () => {
  await renderSectionWithCache();
  vi.mocked(fetchProcessedRecordings).mockRejectedValue(new ApiError("HTTP 503: upstream unavailable", "http", 503, "upstream unavailable"));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(within(screen.getByRole("alert")).getByText(/upstream unavailable/)).toBeInTheDocument();
  expect(cards()).toHaveLength(0);
  expect(renderingCards()).toHaveLength(0);
});

test("a card is locked while its rerender is in flight", async () => {
  // Otherwise an impatient second press schedules a duplicate: the backend drops it, but the
  // lecturer gets two confirmations for one rerender. Purging it meanwhile would pull the
  // recording out from under the job that is being scheduled for it.
  let answer: () => void = () => {};

  renderSection();

  rerender.mockReturnValue(new Promise<undefined>(resolve => {
    answer = () => resolve(undefined);
  }));

  await userEvent.click(rerenderButton(cards()[0]));

  expect(rerenderButton(cards()[0])).toBeDisabled();
  expect(purgeButton(cards()[0])).toBeDisabled();
  // only the pressed card is busy
  expect(rerenderButton(cards()[1])).toBeEnabled();
  expect(purgeButton(cards()[1])).toBeEnabled();

  await userEvent.click(rerenderButton(cards()[0]));
  expect(rerender).toHaveBeenCalledOnce();

  answer();

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
  expect(purgeButton(cards()[0])).toBeEnabled();
});

test("a card is unlocked again after a refused rerender", async () => {
  let refuse: () => void = () => {};

  renderSection();

  rerender.mockReturnValue(new Promise((_resolve, reject) => {
    refuse = () => reject(new ApiError("HTTP 409: already rendering", "http", 409, "already rendering"));
  }));

  await userEvent.click(rerenderButton(cards()[0]));
  expect(purgeButton(cards()[0])).toBeDisabled();

  refuse();

  await waitFor(() => expect(rerenderButton(cards()[0])).toBeEnabled());
  expect(purgeButton(cards()[0])).toBeEnabled();
  expect(showError).toHaveBeenCalledExactlyOnceWith("Unable to schedule re-rendering for GVS_2025", expect.any(Error));
});

// --- recordings whose postprocessing never produced anything ---------------

const unprocessedCards = () => screen.queryAllByTestId("unprocessed-card");

const UNPROCESSED_LISTING = sorted([ ...LISTING, rendering("ABC_2026"), unprocessed("OLD_2024"), unprocessed("XYZ_2025") ]);

test("a recording whose postprocessing failed gets a card that says so", () => {
  renderSection({ data: [ unprocessed("OLD_2024") ] });

  expect(unprocessedCards()).toHaveLength(1);
  expect(within(unprocessedCards()[0]).getByText("OLD_2024")).toBeInTheDocument();
  expect(within(unprocessedCards()[0]).getByText("Postprocessing failed.")).toBeInTheDocument();
  // counted as neither of the other two kinds
  expect(cards()).toHaveLength(0);
  expect(renderingCards()).toHaveLength(0);
});

test("a recording whose postprocessing failed offers a rerender but no download", () => {
  // there is no file to download; rendering it again is the only thing to offer
  renderSection({ data: [ unprocessed("OLD_2024") ] });

  expect(within(unprocessedCards()[0]).queryByRole("link")).toBeNull();
  expect(rerenderButton(unprocessedCards()[0])).toBeEnabled();
});

test("a rerender of a failed recording schedules a job for it and turns the card into a rendering one", async () => {
  await renderSectionWithCache(UNPROCESSED_LISTING);
  holdFurtherListings();

  await userEvent.click(rerenderButton(unprocessedCards()[1]));

  expect(schedulePostprocessing).toHaveBeenCalledExactlyOnceWith(
    { apiUrl: API_URL, getAccessToken },
    "XYZ_2025",
    LECTURER_EMAIL,
    undefined
  );
  // in the place it already had, which is where the backend lists it by name
  await waitFor(() => expect(names(renderingCards())).toStrictEqual([ "ABC_2026", "XYZ_2025" ]));
  expect(names(allCards())).toStrictEqual([ "ABC_2026", "GVS_2025", "OLD_2024", "PSU_2026", "XYZ_2025" ]);
  expect(names(unprocessedCards())).toStrictEqual([ "OLD_2024" ]);
  expect(showSuccess).toHaveBeenCalledExactlyOnceWith("Re-rendering scheduled for XYZ_2025");
});

test("a refused rerender of a failed recording puts its card back", async () => {
  await renderSectionWithCache(UNPROCESSED_LISTING);
  holdFurtherListings();
  vi.mocked(schedulePostprocessing).mockRejectedValue(new ApiError("HTTP 404", "http", 404));

  await userEvent.click(rerenderButton(unprocessedCards()[0]));

  await waitFor(() => expect(showError).toHaveBeenCalledOnce());
  expect(names(unprocessedCards())).toStrictEqual([ "OLD_2024", "XYZ_2025" ]);
  expect(names(renderingCards())).toStrictEqual([ "ABC_2026" ]);
});

test("a failed recording's card is locked while its rerender is in flight", async () => {
  let answer: () => void = () => {};

  renderSection({ data: UNPROCESSED_LISTING });

  rerender.mockReturnValue(new Promise<undefined>(resolve => {
    answer = () => resolve(undefined);
  }));

  await userEvent.click(rerenderButton(unprocessedCards()[0]));

  expect(rerenderButton(unprocessedCards()[0])).toBeDisabled();
  expect(purgeButton(unprocessedCards()[0])).toBeDisabled();
  // the busy state is per card, not shared with the finished ones
  expect(rerenderButton(unprocessedCards()[1])).toBeEnabled();
  expect(purgeButton(unprocessedCards()[1])).toBeEnabled();
  expect(rerenderButton(cards()[0])).toBeEnabled();
  expect(purgeButton(cards()[0])).toBeEnabled();

  answer();

  await waitFor(() => expect(rerenderButton(unprocessedCards()[0])).toBeEnabled());
  expect(purgeButton(unprocessedCards()[0])).toBeEnabled();
});

test("the failed cards sit among the others in the order the server lists them", () => {
  renderSection({ data: UNPROCESSED_LISTING });

  expect(unprocessedCards()).toHaveLength(2);
  expect(within(unprocessedCards()[0]).getByText("OLD_2024")).toBeInTheDocument();
  expect(within(unprocessedCards()[1]).getByText("XYZ_2025")).toBeInTheDocument();

  // not gathered at the end: each is where its name puts it in the backend's listing
  expect(names(allCards())).toStrictEqual([ "ABC_2026", "GVS_2025", "OLD_2024", "PSU_2026", "XYZ_2025" ]);
  expect(allCards()[2]).toBe(unprocessedCards()[0]);
  expect(allCards()[4]).toBe(unprocessedCards()[1]);
});

test("a stale listing's failed cards are withdrawn with the rest while the error is showing", () => {
  // the Rerender button would post against a listing the section can no longer vouch for
  renderSection({ data: UNPROCESSED_LISTING, error: new ApiError("HTTP 500", "http", 500) });

  expect(unprocessedCards()).toHaveLength(0);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

// --- purging ----------------------------------------------------------------
//
// Deleting a recording cannot be undone, so the button only opens a dialog, and nothing is
// sent until the lecturer confirms in it. The request itself is purgeRecording's business,
// in serverStorage.test.ts; what the dialog does with the listing around it is below.

const dialog = () => screen.getByRole("dialog");
const confirmButton = () => within(dialog()).getByTestId("pd-btn-purge");
const cancelButton = () => within(dialog()).getByTestId("pd-btn-cancel");

test("finished and failed recordings offer a purge, rendering ones do not", () => {
  renderSection({ data: UNPROCESSED_LISTING });

  cards().forEach(card => expect(purgeButton(card)).toBeEnabled());
  unprocessedCards().forEach(card => expect(purgeButton(card)).toBeEnabled());
  // deleting it would pull the chunks out from under the render; the backend refuses too
  expect(within(renderingCards()[0]).queryByTestId("prec-btn-purge")).toBeNull();
});

test("the purge button asks first and sends nothing", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[1]));

  // the dialog names the recording, so the lecturer can tell which one they are about to lose
  expect(within(dialog()).getByText(/PSU_2026/)).toBeInTheDocument();
  expect(within(dialog()).getByText(/cannot be undone/)).toBeInTheDocument();
  expect(purge).not.toHaveBeenCalled();
});

test("the dialog starts on Cancel, so a stray Enter keeps the recording", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[0]));

  await waitFor(() => expect(cancelButton()).toHaveFocus());

  await userEvent.keyboard("{Enter}");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purge).not.toHaveBeenCalled();
});

test("cancelling closes the dialog and sends nothing", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(cancelButton());

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purge).not.toHaveBeenCalled();
});

test("escape closes the dialog and sends nothing", async () => {
  renderSection();

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purge).not.toHaveBeenCalled();
});

test("confirming purges that one recording, says so and closes the dialog", async () => {
  await renderSectionWithCache();

  await userEvent.click(purgeButton(cards()[1]));
  await userEvent.click(confirmButton());

  expect(purgeRecording).toHaveBeenCalledExactlyOnceWith({ apiUrl: API_URL, getAccessToken }, "PSU_2026");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(showSuccess).toHaveBeenCalledExactlyOnceWith("Purged PSU_2026");
  expect(showError).not.toHaveBeenCalled();
});

test("a failed recording can be purged the same way", async () => {
  await renderSectionWithCache(UNPROCESSED_LISTING);

  await userEvent.click(purgeButton(unprocessedCards()[0]));
  await userEvent.click(confirmButton());

  expect(purgeRecording).toHaveBeenCalledExactlyOnceWith({ apiUrl: API_URL, getAccessToken }, "OLD_2024");
});

test("the dialog closes as soon as the purge is confirmed", async () => {
  // the card is gone the moment it is confirmed, so a dialog left up over a listing that has
  // already changed would only be in the way; the outcome arrives as a toast
  await renderSectionWithCache();

  vi.mocked(purgeRecording).mockReturnValue(new Promise(() => {}));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(purgeRecording).toHaveBeenCalledOnce();
  expect(showSuccess).not.toHaveBeenCalled();
  expect(showError).not.toHaveBeenCalled();
});

test("a purge that succeeds after the dialog closed still says so", async () => {
  let done: () => void = () => {};

  await renderSectionWithCache();

  vi.mocked(purgeRecording).mockReturnValue(new Promise(resolve => {
    done = () => {
      vi.mocked(fetchProcessedRecordings).mockResolvedValue(without(LISTING, "GVS_2025"));
      resolve();
    };
  }));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  done();

  await waitFor(() => expect(showSuccess).toHaveBeenCalledExactlyOnceWith("Purged GVS_2025"));
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);
});

test("a purge that is refused after the dialog closed puts the card back and says why", async () => {
  let refuse: () => void = () => {};
  const refusal = new ApiError("HTTP 409: GVS_2025 is currently being rendered.", "http", 409, "GVS_2025 is currently being rendered.");

  await renderSectionWithCache();
  holdFurtherListings();

  vi.mocked(purgeRecording).mockReturnValue(new Promise((_resolve, reject) => {
    refuse = () => reject(refusal);
  }));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);

  refuse();

  await waitFor(() => expect(showError).toHaveBeenCalledExactlyOnceWith("Failed to purge GVS_2025", refusal));
  expect(names(cards())).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
  expect(showSuccess).not.toHaveBeenCalled();
});

test("another recording can be purged while the first purge is still in flight", async () => {
  // with the dialog gone at once, nothing holds the lecturer back from the next card
  await renderSectionWithCache();

  vi.mocked(purgeRecording).mockReturnValue(new Promise(() => {}));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());
  await waitFor(() => expect(names(cards())).toStrictEqual([ "PSU_2026" ]));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(cards()).toHaveLength(0));
  expect(vi.mocked(purgeRecording).mock.calls.map(([ , name ]) => name)).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
});

test("a rerender while a purge is in flight does not bring the purged card back", async () => {
  // each optimistic update has to start from what is on screen, not from the last listing
  // the backend confirmed -- which still has the recording that is being purged
  await renderSectionWithCache();
  holdFurtherListings();

  vi.mocked(purgeRecording).mockReturnValue(new Promise(() => {}));
  vi.mocked(schedulePostprocessing).mockReturnValue(new Promise(() => {}));

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());
  await waitFor(() => expect(names(cards())).toStrictEqual([ "PSU_2026" ]));

  await userEvent.click(rerenderButton(cards()[0]));

  await waitFor(() => expect(names(renderingCards())).toContain("PSU_2026"));
  expect(names(cards())).toStrictEqual([]);
});

test("the purged card leaves the listing while the request is in flight, and only that one", async () => {
  // the lecturer has confirmed; the card staying up until the backend answers would look
  // like the press did nothing
  await renderSectionWithCache(UNPROCESSED_LISTING);

  vi.mocked(purgeRecording).mockReturnValue(new Promise(() => {}));

  await userEvent.click(purgeButton(cards()[1]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(names(cards())).toStrictEqual([ "GVS_2025" ]));
  // the other two kinds are filtered by name too, and keep their places
  expect(names(renderingCards())).toStrictEqual([ "ABC_2026" ]);
  expect(names(unprocessedCards())).toStrictEqual([ "OLD_2024", "XYZ_2025" ]);
  expect(names(allCards())).toStrictEqual([ "ABC_2026", "GVS_2025", "OLD_2024", "XYZ_2025" ]);
});

test("a failed recording's card leaves the listing the same way", async () => {
  await renderSectionWithCache(UNPROCESSED_LISTING);

  vi.mocked(purgeRecording).mockReturnValue(new Promise(() => {}));

  await userEvent.click(purgeButton(unprocessedCards()[0]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(names(unprocessedCards())).toStrictEqual([ "XYZ_2025" ]));
  expect(names(cards())).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
  expect(names(renderingCards())).toStrictEqual([ "ABC_2026" ]);
});

test("a refused purge puts the card back and says why", async () => {
  await renderSectionWithCache();
  // so that nothing but the rollback can bring the card back
  holdFurtherListings();

  const refusal = new ApiError(
    "HTTP 409: Recording PSU_2026 is in use and currently not purgeable",
    "http",
    409,
    "Recording PSU_2026 is in use and currently not purgeable"
  );
  vi.mocked(purgeRecording).mockRejectedValue(refusal);

  await userEvent.click(purgeButton(cards()[1]));
  await userEvent.click(confirmButton());

  // the dialog is not left hanging on a refusal either
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(names(cards())).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
  expect(showError).toHaveBeenCalledExactlyOnceWith("Failed to purge PSU_2026", refusal);
  expect(showSuccess).not.toHaveBeenCalled();
});

test("a purge the backend cannot be reached for puts the card back and says so", async () => {
  await renderSectionWithCache();
  holdFurtherListings();

  const unreachable = new ApiError(
    "Network error: NetworkError when attempting to fetch resource.",
    "network",
    undefined,
    undefined,
    { cause: new TypeError("NetworkError when attempting to fetch resource.") }
  );
  vi.mocked(purgeRecording).mockRejectedValue(unreachable);

  await userEvent.click(purgeButton(cards()[1]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(names(cards())).toStrictEqual([ "GVS_2025", "PSU_2026" ]);
  expect(showError).toHaveBeenCalledExactlyOnceWith("Failed to purge PSU_2026", unreachable);
});

test("a purge fetches the listing again rather than trusting its own guess", async () => {
  // the backend answers a purge with nothing, so anything else that changed on it in the
  // meantime only comes along with the listing fetched after it
  await renderSectionWithCache();

  const after = sorted([ ...without(LISTING, "PSU_2026"), rendering("NEW_2026") ]);

  vi.mocked(purgeRecording).mockImplementation(async () => {
    vi.mocked(fetchProcessedRecordings).mockResolvedValue(after);
  });
  vi.mocked(fetchProcessedRecordings).mockClear();

  await userEvent.click(purgeButton(cards()[1]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(names(renderingCards())).toStrictEqual([ "NEW_2026" ]));
  expect(names(cards())).toStrictEqual([ "GVS_2025" ]);
  expect(fetchProcessedRecordings).toHaveBeenCalledOnce();
});

test("the purged card stays gone while the listing is fetched again", async () => {
  // the purge is through, but the listing that no longer has it is not in yet; the card
  // must not come back with its buttons in that window
  await renderSectionWithCache();
  holdFurtherListings();

  await userEvent.click(purgeButton(cards()[0]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(showSuccess).toHaveBeenCalledExactlyOnceWith("Purged GVS_2025"));
  expect(names(cards())).toStrictEqual([ "PSU_2026" ]);
  expect(purgeRecording).toHaveBeenCalledOnce();
});

test("nothing is rendered before the first listing arrives", () => {
  renderSection({ data: undefined });

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
  renderSection({ error: new ApiError("HTTP 503: upstream unavailable", "http", 503, "upstream unavailable") });

  const alert = screen.getByRole("alert");

  expect(within(alert).getByText(/Error fetching list of processed recordings/)).toBeInTheDocument();
  // the message carries the status and the server's own explanation, which is the
  // difference between "try again later" and "tell the admin"
  expect(within(alert).getByText(/HTTP 503: upstream unavailable/)).toBeInTheDocument();
});

test("the section keeps its heading while it is failing", () => {
  renderSection({ error: new Error("boom") });

  // otherwise the alert floats without saying which part of the page is broken
  expect(screen.getByText("Server-Side Processed Recordings")).toBeInTheDocument();
});

test("a stale listing is withdrawn while the error is showing", () => {
  // SWR holds the last good data through a failure, and every TOTP in it is good for one
  // interval. Rendering both would offer download links that have already stopped working.
  renderSection({ data: LISTING, error: new ApiError("HTTP 500", "http", 500) });

  expect(cards()).toHaveLength(0);
  expect(screen.getByRole("alert")).toBeInTheDocument();
});

test("a backend that sent nonsense is reported in words rather than as a JSON dump", () => {
  // A ZodError's own message is the stringified issue array, several lines of JSON, and the
  // ApiError it arrives wrapped in takes that message over. It is an Error, so an
  // instanceof check alone would put that straight on screen.
  const schema = z.array(z.object({ name: z.string(), size: z.number() }));
  const issues = schema.safeParse([ { name: "GVS_2025", size: "1024" } ]).error;
  const error = new ApiError(issues?.message ?? "", "invalid-response", 200, undefined, { cause: issues });

  renderSection({ error });

  const alert = screen.getByRole("alert");

  expect(within(alert).getByText(/expected number, received string/)).toBeInTheDocument();
  expect(within(alert).getByText(/\[0\]\.size/)).toBeInTheDocument();
  // the raw message would have brought the whole issue array with it
  expect(alert.textContent).not.toContain('"code"');
});

test("a failure with no message still says something", () => {
  // SWR passes the thrown value through untouched, and a fetcher can be made to reject
  // with something that is not an Error at all
  renderSection({ error: "not an error object" });

  expect(within(screen.getByRole("alert")).getByText(/unknown error/i)).toBeInTheDocument();
});
