import { beforeEach, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SavedRecordingsSection } from "@/lib/components/SavedRecordingsSection";
import { RecordingFileList } from "@/lib/utils/browserStorage";
import userEvent from "@testing-library/user-event";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { useActiveRecording } from "@/lib/hooks/useActiveRecording";
import { useBrowserStorage, useReuploadSavedRecording } from "@/lib/hooks/useBrowserStorage";
import { downloadFile } from "@/lib/utils/browserStorage";
import { ServerEnv } from "@/lib/utils/serverEnv";

vi.mock("@/lib/hooks/useActiveRecording");
vi.mock("@/lib/hooks/useBrowserStorage");
vi.mock("@/lib/utils/browserStorage");

// The section reads the progress of running re-uploads from the store. Only that one field
// is faked; the rest of the module stays real for whoever else imports it.
let reuploadProgress = new Map<string, number>();
vi.mock("@/lib/hooks/useAppStore", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/hooks/useAppStore")>(),
  useAppStore: function<T>(selector: (state: { reuploadProgress: Map<string, number> }) => T) {
    return selector({ reuploadProgress });
  }
}));

const mockServerEnv = vi.fn<() => ServerEnv>();
vi.mock("@/lib/hooks/useServerEnv", () => ({
  useServerEnv: () => mockServerEnv()
}));

const reupload = vi.fn();

beforeEach(() => {
  // no backend by default: the tests below that predate the re-upload count buttons, and
  // a deployment without a server offers nothing to upload to
  mockServerEnv.mockReturnValue({});
  reuploadProgress = new Map();
  reupload.mockReset();
  vi.mocked(useReuploadSavedRecording).mockReturnValue(reupload);
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

  render(
    <Provider theme={defaultTheme}>
      <SavedRecordingsSection/>
    </Provider>
  );

  const srCards = await screen.findAllByTestId("sr-card");

  expect(srCards.length).toBe(2);

  expect(srCards[0]).toHaveTextContent("FOO_2025-12-11T213822.748Z");
  expect(srCards[1]).toHaveTextContent("BAR_2025-12-11T214230.418Z");

  const fooButtons = await within(srCards[0]).findAllByRole("button");
  expect(fooButtons.length).toBe(2);
  expect(fooButtons[0]).toHaveTextContent("Download stream.webm (1.23 MiB)");
  expect(fooButtons[1]).toHaveTextContent("Remove");

  await user.click(fooButtons[0]);
  expect(onDownload).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z", "stream.webm");
  await user.click(fooButtons[1]);
  expect(onRemove).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z");

  const barButtons = await within(srCards[1]).findAllByRole("button");
  expect(barButtons.length).toBe(4);
  expect(barButtons[0]).toHaveTextContent("Download stream.webm (2.34 MiB)");
  expect(barButtons[1]).toHaveTextContent("Download overlay.webm (3.45 MiB)");
  expect(barButtons[2]).toHaveTextContent("Download audio-0.webm");
  expect(barButtons[3]).toHaveTextContent("Remove");

  await user.click(barButtons[0]);
  expect(onDownload).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "stream.webm");
  await user.click(barButtons[1]);
  expect(onDownload).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "overlay.webm");
  await user.click(barButtons[2]);
  expect(onDownload).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "audio-0.webm");
  await user.click(barButtons[3]);
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

  render(
    <Provider theme={defaultTheme}>
      <SavedRecordingsSection/>
    </Provider>
  );

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
    stop: vi.fn(),
    streamingImpeded: false
  });

  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: recordings,
    removeSavedRecording: onRemove
  });

  const user = userEvent.setup();

  render(
    <Provider theme={defaultTheme}>
      <SavedRecordingsSection/>
    </Provider>
  );

  const srCards = await screen.findAllByTestId("sr-card");

  expect(srCards.length).toBe(2);

  expect(srCards[0]).toHaveTextContent("FOO_2025-12-11T213822.748Z");
  expect(srCards[1]).toHaveTextContent("BAR_2025-12-11T214230.418Z");

  const fooButtons = await within(srCards[0]).findAllByRole("button");
  expect(fooButtons.length).toBe(2);
  expect(fooButtons[0]).toHaveTextContent("Download stream.webm (1.23 MiB)");
  expect(fooButtons[0]).not.toBeDisabled();
  expect(fooButtons[1]).toHaveTextContent("Remove");
  expect(fooButtons[1]).not.toBeDisabled();

  await user.click(fooButtons[0]);
  expect(onDownload).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z", "stream.webm");
  await user.click(fooButtons[1]);
  expect(onRemove).toHaveBeenLastCalledWith("FOO_2025-12-11T213822.748Z");

  const barButtons = await within(srCards[1]).findAllByRole("button");
  expect(barButtons.length).toBe(4);
  expect(barButtons[0]).toHaveTextContent("Download stream.webm (2.34 MiB)");
  expect(barButtons[0]).toBeDisabled();
  expect(barButtons[1]).toHaveTextContent("Download overlay.webm (3.45 MiB)");
  expect(barButtons[1]).toBeDisabled();
  expect(barButtons[2]).toHaveTextContent("Download audio-0.webm");
  expect(barButtons[2]).toBeDisabled();
  expect(barButtons[3]).toHaveTextContent("Remove");
  expect(barButtons[3]).toBeDisabled();

  onDownload.mockClear();
  onRemove.mockClear();

  await user.click(barButtons[0]);
  await user.click(barButtons[1]);
  await user.click(barButtons[2]);
  expect(onDownload).not.toHaveBeenCalled();
  await user.click(barButtons[3]);
  expect(onRemove).not.toHaveBeenCalled();
});

// --- manual re-upload ------------------------------------------------------
//
// For a recording whose live upload did not make it to the server, the local copy can be
// sent again. What the upload itself does is useReuploadSavedRecording's business, in
// useBrowserStorage.test.tsx; this is where the button appears and when it can be pressed.

const TWO_RECORDINGS: RecordingFileList[] = [
  { name: "FOO_2025-12-11T213822.748Z", files: [ { name: "stream.webm", size: 2 ** 20 } ] },
  { name: "BAR_2025-12-11T214230.418Z", files: [ { name: "stream.webm", size: 2 ** 20 } ] }
];

function renderWithBackend(
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

  render(
    <Provider theme={defaultTheme} scale={scale}>
      <SavedRecordingsSection/>
    </Provider>
  );

  return screen.getAllByTestId("sr-card");
}

const reuploadButton = (card: HTMLElement) => within(card).getByRole("button", { name: /Re-upload manually/ });

test("with a backend, every saved recording can be re-uploaded", async () => {
  const cards = renderWithBackend();

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

  render(
    <Provider theme={defaultTheme}>
      <SavedRecordingsSection/>
    </Provider>
  );

  expect(screen.queryByRole("button", { name: /Re-upload manually/ })).toBeNull();
});

test("the recording that is being made cannot be re-uploaded", () => {
  // its files are still being written, so the upload would send half a recording
  const cards = renderWithBackend({ state: "recording", name: "BAR_2025-12-11T214230.418Z", stop: vi.fn(), streamingImpeded: true });

  expect(reuploadButton(cards[1])).toBeDisabled();
  expect(reuploadButton(cards[0])).toBeEnabled();
});

// While its re-upload runs, a card shows the progress in place of the buttons that act on
// the local copy, so there is nothing to press twice and nothing to remove from under it.

const removeButton = (card: HTMLElement) => within(card).getByRole("button", { name: /Remove/ });

test("a recording cannot be re-uploaded again while its re-upload is running", async () => {
  // a second press would upload into the same directory the first one is writing to, and
  // schedule a second job for it
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 0 ] ]);

  const cards = renderWithBackend();

  expect(within(cards[1]).queryByRole("button", { name: /Re-upload manually/ })).toBeNull();
  expect(cards[1]).toHaveTextContent("Uploading...");

  // only that recording: the others can go up in the meantime
  await userEvent.click(reuploadButton(cards[0]));
  expect(reupload).toHaveBeenCalledExactlyOnceWith("FOO_2025-12-11T213822.748Z");
});

test("a running re-upload shows how far it has got", () => {
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);

  const cards = renderWithBackend();

  expect(within(cards[1]).getByRole("progressbar", { name: "Uploading" })).toHaveAttribute("aria-valuenow", "42");
  expect(within(cards[0]).queryByRole("progressbar")).toBeNull();
});

test("a recording cannot be removed while its re-upload is running", async () => {
  // the upload reads the local files as it goes, so they have to outlive it
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);
  const onRemove = vi.fn();

  const cards = renderWithBackend({ state: "idle" }, onRemove);

  expect(within(cards[1]).queryByRole("button", { name: /Remove/ })).toBeNull();

  // only that recording: the others can be removed in the meantime
  await userEvent.click(removeButton(cards[0]));
  expect(onRemove).toHaveBeenCalledExactlyOnceWith("FOO_2025-12-11T213822.748Z");
});

test("the downloads stay available while a re-upload is running", async () => {
  // they read the same local files the upload does, which is harmless
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);

  const cards = renderWithBackend();

  const download = within(cards[1]).getByRole("button", { name: /Download stream.webm/ });
  expect(download).toBeEnabled();
  await userEvent.click(download);
  expect(downloadFile).toHaveBeenLastCalledWith("BAR_2025-12-11T214230.418Z", "stream.webm");
});

test.each([ "medium", "large" ] as const)("a card keeps its height while its re-upload runs (%s scale)", scale => {
  // the progress takes the place of two buttons, and a card that shrank and grew around it
  // would shift every card after it in the row. The two recordings have one file each and
  // names of the same length, so the only difference between the cards is the upload.
  reuploadProgress = new Map([ [ "BAR_2025-12-11T214230.418Z", 42 ] ]);

  const [ idle, uploading ] = renderWithBackend({ state: "idle" }, vi.fn(), scale);

  // the card's content rather than the card: the section lays cards out in a row that
  // stretches each to the tallest, which would make any two cards side by side agree
  const contentHeight = (card: HTMLElement) => (card.firstElementChild as HTMLElement).getBoundingClientRect().height;
  expect(contentHeight(uploading)).toBe(contentHeight(idle));
});
