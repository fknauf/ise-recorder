import { beforeEach, expect, test, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserStorageSection } from "@/lib/components/BrowserStorageSection";
import { RecordingFileList } from "@/lib/utils/browserStorage";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { useActiveRecording } from "@/lib/hooks/useActiveRecording";
import { useBrowserStorage } from "@/lib/hooks/useBrowserStorage";
import { useReupload } from "@/lib/hooks/useReupload";
import { downloadFile, gatherRecordingsList } from "@/lib/utils/browserStorage";
import { ServerEnv } from "@/lib/utils/serverEnv";
import { AppStoreProvider, useAppStore } from "@/lib/hooks/useAppStore";
import { AppStoreState } from "@/lib/store/store";
import { useEffect } from "react";
import { ExpandedSection, SECTION_ID } from "./ExpandedSection";

vi.mock("@/lib/hooks/useActiveRecording");
vi.mock("@/lib/hooks/useBrowserStorage");
vi.mock("@/lib/hooks/useReupload");
vi.mock("@/lib/utils/browserStorage");

const mockServerEnv = vi.fn<() => ServerEnv>();
vi.mock("@/lib/hooks/useServerEnv", () => ({
  useServerEnv: () => mockServerEnv()
}));

// Only the two fields the card decides on. An anonymous deployment by default, which never
// needs a sign-in, so the tests that are not about the session are not affected by it.
const mockSession = vi.fn<() => { authRequired: boolean; isAuthenticated: boolean }>();
vi.mock("@/lib/components/SessionProvider", () => ({
  useAppSession: () => mockSession()
}));

// Progress of running re-uploads by recording name, as the store would hold it. What the
// upload does is useReupload's business, in useReupload.test.tsx; this fake only answers
// for one card at a time the way the hook does, and records which recording was sent.
let reuploadProgress = new Map<string, number>();
const reupload = vi.fn();

// Controls are found by test id rather than by label, so rewording a button does not break
// the tests that are about what it does. The download buttons are still checked for the
// file name and size they show, since that is content rather than wording.
const removeButton = (card: HTMLElement) => within(card).getByTestId("sr-btn-remove");
const reuploadButton = (card: HTMLElement) => within(card).getByTestId("sr-btn-reupload");
const uploadingIndicator = (card: HTMLElement) => within(card).getByTestId("sr-ind-uploading");
const downloadButtons = (card: HTMLElement) => within(card).getAllByTestId("sr-btn-download");

let store: AppStoreState;

/**
 * Hands the store out so a test can mark recordings as unstreamed. Published from an effect
 * rather than during render: assigning to a variable outside the component is a side effect,
 * and doing it in the render body is a lint error.
 */
function StoreHandle() {
  const state = useAppStore(s => s);

  useEffect(() => {
    store = state;
  }, [ state ]);

  return null;
}

/**
 * Render the section open, the way the home page's accordion holds it, under a real store.
 *
 * The store is where the section learns which recordings never made it to the backend.
 * Everything else comes from the hooks mocked above, so the store's serverEnv is never read.
 *
 * The provider looks at browser storage when it mounts, and the answer reaches the store
 * after render has returned. Waiting for it here keeps that update out of the tests, which
 * would otherwise see it land at some random point, outside act.
 */
async function renderSection(scale: "medium" | "large" = "medium") {
  render(
    <Provider theme={defaultTheme} scale={scale}>
      <AppStoreProvider serverEnv={{}}>
        <StoreHandle/>
        <ExpandedSection>
          <BrowserStorageSection id={SECTION_ID}/>
        </ExpandedSection>
      </AppStoreProvider>
    </Provider>
  );

  // the quota comes from the same look at storage, and is undefined until it has landed
  await waitFor(() => expect(store.quota).toBeDefined());
}

beforeEach(() => {
  // the list of unstreamed recordings is persisted
  localStorage.clear();
  // the provider looks at browser storage when it mounts. The store keeps only unstreamed
  // recordings that are still in the browser, so a test that marks some has to list them here.
  navigator.storage.estimate = vi.fn().mockResolvedValue({ quota: 10 * 2 ** 30, usage: 0 });
  vi.mocked(gatherRecordingsList).mockResolvedValue([]);

  // no backend by default: the tests below that predate the re-upload count buttons, and
  // a deployment without a server offers nothing to upload to
  mockServerEnv.mockReturnValue({});
  mockSession.mockReturnValue({ authRequired: false, isAuthenticated: false });
  reuploadProgress = new Map();
  reupload.mockReset();
  vi.mocked(useReupload).mockImplementation(recordingName => ({
    isUploading: reuploadProgress.has(recordingName),
    progress: reuploadProgress.get(recordingName),
    reupload: async () => reupload(recordingName)
  }));
});

test("SavedRecordingsSection displays recordings and reacts to clicks", async () => {
  const MiB = 2 ** 20;

  const recordings: RecordingFileList[] = [
    {
      name: "FOO_2025-12-11T213822.748Z",
      files: [
        {
          name: "stream.webm",
          size: 1.23 * MiB
        }
      ]
    },
    {
      name: "BAR_2025-12-11T214230.418Z",
      files: [
        {
          name: "stream.webm",
          size: 2.34 * MiB
        },
        {
          name: "overlay.webm",
          size: 3.45 * MiB
        },
        {
          name: "audio-0.webm",
          size: undefined
        }
      ]
    }
  ];

  const onRemove = vi.fn();
  const onDownload = vi.mocked(downloadFile);

  vi.mocked(useActiveRecording).mockReturnValue({
    state: "idle"
  });

  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: recordings,
    removeSavedRecording: onRemove
  });

  const user = userEvent.setup();

  await renderSection();

  const srCards = await screen.findAllByTestId("sr-card");

  expect(srCards.length).toBe(2);

  expect(srCards[0]).toHaveTextContent("FOO_2025-12-11T213822.748Z");
  expect(srCards[1]).toHaveTextContent("BAR_2025-12-11T214230.418Z");

  // one download per file and a remove button, and nothing else: no backend, no re-upload
  expect(within(srCards[0]).getAllByRole("button")).toHaveLength(2);
  const fooDownloads = downloadButtons(srCards[0]);
  expect(fooDownloads).toHaveLength(1);
  expect(fooDownloads[0]).toHaveTextContent("stream.webm (1.23 MiB)");

  await user.click(fooDownloads[0]);
  expect(onDownload).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z", "stream.webm");
  await user.click(removeButton(srCards[0]));
  expect(onRemove).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z");

  expect(within(srCards[1]).getAllByRole("button")).toHaveLength(4);
  const barDownloads = downloadButtons(srCards[1]);
  expect(barDownloads).toHaveLength(3);
  expect(barDownloads[0]).toHaveTextContent("stream.webm (2.34 MiB)");
  expect(barDownloads[1]).toHaveTextContent("overlay.webm (3.45 MiB)");
  expect(barDownloads[2]).toHaveTextContent("audio-0.webm");

  await user.click(barDownloads[0]);
  expect(onDownload).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "stream.webm");
  await user.click(barDownloads[1]);
  expect(onDownload).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "overlay.webm");
  await user.click(barDownloads[2]);
  expect(onDownload).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "audio-0.webm");
  await user.click(removeButton(srCards[1]));
  expect(onRemove).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z");
});

test("SavedRecordingsSection is empty when there are no recordings", async () => {
  vi.mocked(useActiveRecording).mockReturnValue({
    state: "idle"
  });

  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: [],
    removeSavedRecording: vi.fn()
  });

  await renderSection();

  const srCards = await screen.queryAllByTestId("sr-card");

  expect(srCards.length).toBe(0);
});

test("SavedRecordingsSection disables buttons for the active recording", async () => {
  const MiB = 2 ** 20;

  const recordings: RecordingFileList[] = [
    {
      name: "FOO_2025-12-11T213822.748Z",
      files: [
        {
          name: "stream.webm",
          size: 1.23 * MiB
        }
      ]
    },
    {
      name: "BAR_2025-12-11T214230.418Z",
      files: [
        {
          name: "stream.webm",
          size: 2.34 * MiB
        },
        {
          name: "overlay.webm",
          size: 3.45 * MiB
        },
        {
          name: "audio-0.webm",
          size: undefined
        }
      ]
    }
  ];

  const onRemove = vi.fn();
  const onDownload = vi.mocked(downloadFile);

  vi.mocked(useActiveRecording).mockReturnValue({
    state: "recording",
    name: "BAR_2025-12-11T214230.418Z",
    stop: vi.fn()
  });

  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: recordings,
    removeSavedRecording: onRemove
  });

  const user = userEvent.setup();

  await renderSection();

  const srCards = await screen.findAllByTestId("sr-card");

  expect(srCards.length).toBe(2);

  expect(srCards[0]).toHaveTextContent("FOO_2025-12-11T213822.748Z");
  expect(srCards[1]).toHaveTextContent("BAR_2025-12-11T214230.418Z");

  const fooDownloads = downloadButtons(srCards[0]);
  expect(fooDownloads).toHaveLength(1);
  expect(fooDownloads[0]).toBeEnabled();
  expect(removeButton(srCards[0])).toBeEnabled();

  await user.click(fooDownloads[0]);
  expect(onDownload).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z", "stream.webm");
  await user.click(removeButton(srCards[0]));
  expect(onRemove).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z");

  const barDownloads = downloadButtons(srCards[1]);
  expect(barDownloads).toHaveLength(3);
  for(const download of barDownloads) {
    expect(download).toBeDisabled();
  }
  expect(removeButton(srCards[1])).toBeDisabled();

  onDownload.mockClear();
  onRemove.mockClear();

  for(const download of barDownloads) {
    await user.click(download);
  }
  expect(onDownload).not.toHaveBeenCalled();
  await user.click(removeButton(srCards[1]));
  expect(onRemove).not.toHaveBeenCalled();
});

// --- manual re-upload ------------------------------------------------------
//
// For a recording whose live upload did not make it to the server, the local copy can be
// sent again. What the upload itself does is useReupload's business, in useReupload.test.tsx;
// this is where the button appears and when it can be pressed.

const TWO_RECORDINGS: RecordingFileList[] = [
  { name: "FOO_2025-12-11T213822.748Z", files: [ { name: "stream.webm", size: 2 ** 20 } ] },
  { name: "BAR_2025-12-11T214230.418Z", files: [ { name: "stream.webm", size: 2 ** 20 } ] }
];

async function renderWithBackend(
  activeRecording: ReturnType<typeof useActiveRecording> = { state: "idle" },
  removeSavedRecording: (name: string) => Promise<void> = vi.fn(),
  scale: "medium" | "large" = "medium"
) {
  mockServerEnv.mockReturnValue({ apiUrl: "https://record.example.edu" });
  vi.mocked(useActiveRecording).mockReturnValue(activeRecording);
  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: TWO_RECORDINGS,
    removeSavedRecording
  });
  vi.mocked(gatherRecordingsList).mockResolvedValue(TWO_RECORDINGS);

  await renderSection(scale);

  return screen.getAllByTestId("sr-card");
}

test("with a backend, every saved recording can be re-uploaded", async () => {
  const cards = await renderWithBackend();

  await userEvent.click(reuploadButton(cards[1]));

  expect(reupload).toHaveBeenCalledExactlyOnceWith("BAR_2025-12-11T214230.418Z");
  expect(reuploadButton(cards[0])).toBeEnabled();
});

test("without a backend, nothing is offered for re-upload", async () => {
  vi.mocked(useActiveRecording).mockReturnValue({ state: "idle" });
  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: TWO_RECORDINGS,
    removeSavedRecording: vi.fn()
  });

  await renderSection();

  expect(screen.queryByTestId("sr-btn-reupload")).toBeNull();
});

test("the recording that is being made cannot be re-uploaded", async () => {
  // its files are still being written, so the upload would send half a recording
  const cards = await renderWithBackend({ state: "recording", name: "BAR_2025-12-11T214230.418Z", stop: vi.fn() });

  expect(reuploadButton(cards[1])).toBeDisabled();
  expect(reuploadButton(cards[0])).toBeEnabled();
});

test("nothing can be re-uploaded while signed out of a deployment that requires sign-in", async () => {
  // the server would turn every chunk away, so the button could only lead to an error
  mockSession.mockReturnValue({ authRequired: true, isAuthenticated: false });

  const cards = await renderWithBackend();

  for(const card of cards) {
    expect(reuploadButton(card)).toBeDisabled();
    await userEvent.click(reuploadButton(card));
  }
  expect(reupload).not.toHaveBeenCalled();
});

test("a signed-in user can re-upload in a deployment that requires sign-in", async () => {
  mockSession.mockReturnValue({ authRequired: true, isAuthenticated: true });

  const cards = await renderWithBackend();

  await userEvent.click(reuploadButton(cards[0]));
  expect(reupload).toHaveBeenCalledExactlyOnceWith("FOO_2025-12-11T213822.748Z");
});

// While its re-upload runs, a card shows the progress in place of the buttons that act on
// the local copy, so there is nothing to press twice and nothing to remove from under it.

test("a recording cannot be re-uploaded again while its re-upload is running", async () => {
  // a second press would upload into the same directory the first one is writing to, and
  // schedule a second job for it
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 0 ] ]);

  const cards = await renderWithBackend();

  expect(within(cards[1]).queryByTestId("sr-btn-reupload")).toBeNull();
  expect(uploadingIndicator(cards[1])).toBeVisible();

  // only that recording: the others can go up in the meantime
  await userEvent.click(reuploadButton(cards[0]));
  expect(reupload).toHaveBeenCalledExactlyOnceWith("FOO_2025-12-11T213822.748Z");
});

test("a running re-upload shows how far it has got", async () => {
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);

  const cards = await renderWithBackend();

  expect(within(uploadingIndicator(cards[1])).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  expect(within(cards[0]).queryByTestId("sr-ind-uploading")).toBeNull();
});

test("a recording cannot be removed while its re-upload is running", async () => {
  // the upload reads the local files as it goes, so they have to outlive it
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);
  const onRemove = vi.fn();

  const cards = await renderWithBackend({ state: "idle" }, onRemove);

  expect(within(cards[1]).queryByTestId("sr-btn-remove")).toBeNull();

  // only that recording: the others can be removed in the meantime
  await userEvent.click(removeButton(cards[0]));
  expect(onRemove).toHaveBeenCalledExactlyOnceWith("FOO_2025-12-11T213822.748Z");
});

test("the downloads stay available while a re-upload is running", async () => {
  // they read the same local files the upload does, which is harmless
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);

  const cards = await renderWithBackend();

  const [ download ] = downloadButtons(cards[1]);
  expect(download).toBeEnabled();
  await userEvent.click(download);
  expect(downloadFile).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "stream.webm");
});

test.each([ "medium", "large" ] as const)("a card keeps its height while its re-upload runs (%s scale)", async scale => {
  // the progress takes the place of two buttons, and a card that shrank and grew around it
  // would shift every card after it in the row. The two recordings have one file each and
  // names of the same length, so the only difference between the cards is the upload.
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);

  const [ idle, uploading ] = await renderWithBackend({ state: "idle" }, vi.fn(), scale);

  // the card's content rather than the card: the section lays cards out in a row that
  // stretches each to the tallest, which would make any two cards side by side agree
  const contentHeight = (card: HTMLElement) => (card.firstElementChild as HTMLElement).getBoundingClientRect().height;
  expect(contentHeight(uploading)).toBe(contentHeight(idle));
});

// --- deleting a recording that never reached the backend -------------------
//
// When a recording's live upload broke off, the copy in the browser may be the only one, and
// deleting it loses the lecture. The section asks first for those recordings, and only for
// those: deleting a recording that did reach the backend goes through without a question, as
// in the tests above.

const dialog = () => screen.getByRole("dialog");
const confirmButton = () => within(dialog()).getByTestId("sr-dd-btn-delete");
const cancelButton = () => within(dialog()).getByTestId("sr-dd-btn-cancel");

/** renderWithBackend, with these recordings marked as not streamed to the backend. */
async function renderWithUnstreamed(unstreamed: string[], removeSavedRecording = vi.fn()) {
  const cards = await renderWithBackend({ state: "idle" }, removeSavedRecording);

  act(() => {
    for(const name of unstreamed) {
      store.markUnstreamed(name);
    }
  });

  return cards;
}

test("deleting a recording that never reached the backend asks first and deletes nothing", async () => {
  const onRemove = vi.fn();
  const cards = await renderWithUnstreamed([ "BAR_2025-12-11T214230.418Z" ], onRemove);

  await userEvent.click(removeButton(cards[1]));

  // the dialog names the recording, so the lecturer can tell which one they are about to lose
  expect(within(dialog()).getByText(/BAR_2025-12-11T214230.418Z/)).toBeInTheDocument();
  expect(onRemove).not.toHaveBeenCalled();
});

test("confirming deletes that one recording and closes the dialog", async () => {
  const onRemove = vi.fn();
  const cards = await renderWithUnstreamed([ "FOO_2025-12-11T213822.748Z", "BAR_2025-12-11T214230.418Z" ], onRemove);

  await userEvent.click(removeButton(cards[1]));
  await userEvent.click(confirmButton());

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onRemove).toHaveBeenCalledExactlyOnceWith("BAR_2025-12-11T214230.418Z");
});

test("the dialog starts on Cancel, so a stray Enter keeps the recording", async () => {
  const onRemove = vi.fn();
  const cards = await renderWithUnstreamed([ "BAR_2025-12-11T214230.418Z" ], onRemove);

  await userEvent.click(removeButton(cards[1]));
  await waitFor(() => expect(cancelButton()).toHaveFocus());
  await userEvent.keyboard("{Enter}");

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onRemove).not.toHaveBeenCalled();
});

test.each([
  [ "cancelling", () => userEvent.click(cancelButton()) ],
  [ "escape", () => userEvent.keyboard("{Escape}") ]
])("%s closes the dialog, deletes nothing, and the next delete asks again", async (_, backOut) => {
  const onRemove = vi.fn();
  const cards = await renderWithUnstreamed([ "BAR_2025-12-11T214230.418Z" ], onRemove);

  await userEvent.click(removeButton(cards[1]));
  await backOut();

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(onRemove).not.toHaveBeenCalled();

  // backing out once is not an answer for next time
  await userEvent.click(removeButton(cards[1]));
  expect(within(dialog()).getByText(/BAR_2025-12-11T214230.418Z/)).toBeInTheDocument();
  expect(onRemove).not.toHaveBeenCalled();
});

test("recordings that did reach the backend are still deleted without a question", async () => {
  // the question is about that one recording, not about every card next to it
  const onRemove = vi.fn();
  const cards = await renderWithUnstreamed([ "BAR_2025-12-11T214230.418Z" ], onRemove);

  await userEvent.click(removeButton(cards[0]));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onRemove).toHaveBeenCalledExactlyOnceWith("FOO_2025-12-11T213822.748Z");
});

test("a recording that has since been re-uploaded is deleted without a question", async () => {
  // the backend has it now, so the browser's copy is no longer the only one
  const onRemove = vi.fn();
  const cards = await renderWithUnstreamed([ "BAR_2025-12-11T214230.418Z" ], onRemove);

  act(() => store.signalManualUploadFinished("BAR_2025-12-11T214230.418Z", true));
  await userEvent.click(removeButton(cards[1]));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onRemove).toHaveBeenCalledExactlyOnceWith("BAR_2025-12-11T214230.418Z");
});
