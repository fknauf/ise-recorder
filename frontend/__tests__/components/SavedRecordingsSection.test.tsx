import { expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SavedRecordingsSection } from "@/app/lib/components/SavedRecordingsSection";
import { RecordingFileList } from "@/app/lib/utils/browserStorage";
import userEvent from "@testing-library/user-event";

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

  const user = userEvent.setup();
  const onRemove = vi.fn();
  const onDownload = vi.fn();

  render(
    <SavedRecordingsSection
      recordings={recordings}
      onRemove={onRemove}
      onDownload={onDownload}
    />
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
  render(
    <SavedRecordingsSection
      recordings={[]}
      onRemove={()=>{}}
      onDownload={() => {}}
    />
  );

  const srCards = await screen.queryAllByTestId("sr-card");

  expect(srCards.length).toBe(0);
});
