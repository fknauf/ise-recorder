import { expect, test, vi } from "vitest";
import { anAppSession } from "../helpers/session";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { ServerStorageSection } from "@/lib/components/ServerStorageSection";
import { useServerStorage } from "@/lib/hooks/useServerStorage";
import { fetchRecordings, purgeRecording, schedulePostprocessing, ServerStorageRecording } from "@/lib/utils/serverStorage";
import { ApiError } from "@/lib/utils/apiFetch";
import { showError, showSuccess } from "@/lib/utils/notifications";
import { ServerEnv } from "@/lib/utils/serverEnv";
import { SWRConfig } from "swr";
import * as z from "zod";
import { ExpandedSection, SECTION_ID } from "../helpers/ExpandedSection";

vi.mock("@/lib/hooks/useServerStorage");
// the requests are mocked, but the URL builder is kept: which href the link carries is
// exactly what the download tests below are about
vi.mock("@/lib/utils/serverStorage", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/utils/serverStorage")>(),
  fetchRecordings: vi.fn(),
  schedulePostprocessing: vi.fn(),
  purgeRecording: vi.fn()
}));
vi.mock("@/lib/utils/notifications");

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

const MiB = 2 ** 20;
const LECTURER_EMAIL = "lecturer@example.edu";
const getAccessToken = async () => "test-token";

// what the mocked hook hands the cards; the tests that run the real one pass `hook` instead
const rerender = vi.fn<ReturnType<typeof useServerStorage>["rerender"]>();
const purge = vi.fn<ReturnType<typeof useServerStorage>["purge"]>();

type Listing = ServerStorageRecording[];

/** The backend lists every recording in one array, whatever state it is in, sorted by name. */
const sorted = (listing: Listing) => listing.toSorted((a, b) => a.name.localeCompare(b.name));

const LISTING: Listing = [
  { state: "completed", name: "GVS_2025", size: 1.25 * MiB, downloadUrl: `downloads/${USER_DIGEST}/GVS_2025?totp=012345` },
  { state: "completed", name: "PSU_2026", size: 3.5 * MiB, downloadUrl: `downloads/${USER_DIGEST}/PSU_2026?totp=987654` }
];

/** The listing with one recording gone from it, whichever kind it is. */
const without = (listing: Listing, name: string): Listing => listing.filter(rec => rec.name !== name);

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
  hook?: typeof useServerStorage
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

  mockUseAppSession.mockReturnValue(anAppSession({ isAuthenticated, isExpired, getAccessToken }));

  mockUseLecture.mockReturnValue({
    lectureTitle: "",
    lecturerEmail: LECTURER_EMAIL,
    setLectureTitle: vi.fn(),
    setLecturerEmail: vi.fn()
  });

  // what the backend answers an accepted rerender with: the recording's new state
  vi.mocked(schedulePostprocessing).mockImplementation(async (_destination, name) => ({ state: "rendering", name }));
  rerender.mockResolvedValue(undefined);
  purge.mockResolvedValue(undefined);

  if(hook !== undefined) {
    vi.mocked(useServerStorage).mockImplementation(hook);
  } else {
    vi.mocked(useServerStorage).mockReturnValue(
      { data, error, rerender, purge } as unknown as ReturnType<typeof useServerStorage>
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

const cards = () => screen.queryAllByTestId("ss-card-completed");

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

const renderingCards = () => screen.queryAllByTestId("ss-card-rendering");

const RENDERING_LISTING = sorted([ ...LISTING, rendering("ABC_2026"), rendering("XYZ_2026") ]);

/** Every card in the section, whichever kind, in the order they appear on the page. */
const allCards = () => screen.queryAllByTestId(/^ss-card-/);

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
  const actual = await vi.importActual<typeof import("@/lib/hooks/useServerStorage")>("@/lib/hooks/useServerStorage");

  vi.mocked(fetchRecordings).mockResolvedValue(listing);
  renderSection({ hook: actual.useServerStorage });
  // the backend only lists the recording without it once the purge is through, so a fetch
  // that merely happened to run earlier cannot pass for the one after it
  vi.mocked(purgeRecording).mockImplementation(async (_destination, name) => {
    vi.mocked(fetchRecordings).mockResolvedValue(without(listing, name));
  });

  await waitFor(() => expect(screen.getByText("Server-Side Processed Recordings")).toBeInTheDocument());
}

/** From here on the listing is not answered, so whatever is on screen is what the cache holds. */
const holdFurtherListings = () =>
  vi.mocked(fetchRecordings).mockReturnValue(new Promise(() => {}));

// --- rerendering a finished recording --------------------------------------

// Controls are found by test id rather than by label, so rewording or restyling a button --
// down to an icon with no text -- does not break the tests that are about what it does.
const rerenderButton = (card: HTMLElement) => within(card).getByTestId("ss-btn-rerender");
const purgeButton = (card: HTMLElement) => within(card).getByTestId("ss-btn-purge");

test("each finished recording offers a rerender", () => {
  renderSection();

  expect(cards()).toHaveLength(2);
  cards().forEach(card => expect(rerenderButton(card)).toBeEnabled());
});

test("a scheduled rerender is confirmed by name", async () => {
  renderSection();

  await userEvent.click(rerenderButton(cards()[1]));

  expect(rerender).toHaveBeenCalledExactlyOnceWith("PSU_2026");
  await waitFor(() => expect(showSuccess).toHaveBeenCalledExactlyOnceWith("Re-rendering scheduled for PSU_2026"));
  expect(showError).not.toHaveBeenCalled();
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
  vi.mocked(fetchRecordings).mockRejectedValue(new ApiError("HTTP 503: upstream unavailable", "http", 503, "upstream unavailable"));

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

const unprocessedCards = () => screen.queryAllByTestId("ss-card-unprocessed");

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
const confirmButton = () => within(dialog()).getByTestId("ss-btn-purgeconfirm");
const cancelButton = () => within(dialog()).getByTestId("ss-btn-purgecancel");

test("finished and failed recordings offer a purge, rendering ones do not", () => {
  renderSection({ data: UNPROCESSED_LISTING });

  cards().forEach(card => expect(purgeButton(card)).toBeEnabled());
  unprocessedCards().forEach(card => expect(purgeButton(card)).toBeEnabled());
  // deleting it would pull the chunks out from under the render; the backend refuses too
  expect(within(renderingCards()[0]).queryByTestId("ss-btn-purge")).toBeNull();
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
      vi.mocked(fetchRecordings).mockResolvedValue(without(LISTING, "GVS_2025"));
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
