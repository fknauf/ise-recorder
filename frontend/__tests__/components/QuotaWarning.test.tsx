import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuotaWarning } from "@/app/lib/components/QuotaWarning";
import { defaultTheme, Provider } from "@adobe/react-spectrum";
import { useBrowserStorage } from "@/app/lib/hooks/useBrowserStorage";

vi.mock("@/app/lib/hooks/useBrowserStorage");

test("QuotaWarning shows up if quota is critical", async () => {
  const GiB = 2 ** 30;
  const quota = 10 * GiB;
  const usage = 9 * GiB + 1;

  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: quota,
    usage: usage,
    savedRecordings: [],
    removeSavedRecording: vi.fn()
  });

  render(
    <Provider theme={defaultTheme}>
      <QuotaWarning thresholdBytes={2 ** 30}/>
    </Provider>
  );

  await screen.findByRole("alert");

  expect(screen.getByRole("alert")).toHaveTextContent("Browser storage running low: 9216 MiB of 10240 MiB used.");
});

test("QuotaWarning doesn't show up if quota is not critical", async () => {
  const GiB = 2 ** 30;
  const quota = 10 * GiB;
  const usage = 9 * GiB;

  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: quota,
    usage: usage,
    savedRecordings: [],
    removeSavedRecording: vi.fn()
  });

  render(
    <Provider theme={defaultTheme}>
      <QuotaWarning thresholdBytes={2 ** 30}/>
    </Provider>
  );

  const quotaWarning = screen.queryByRole("alert");
  expect(quotaWarning).toBeNull();
});

test("QuotaWarning doesn't show up if quota is unknown", async () => {
  // this happens on first render or if OPFS is not supported. It's important that it doesn't
  // appear on first render because otherwise the user sees a flashing warning that's gone before
  // he can read it.
  vi.mocked(useBrowserStorage).mockReturnValue({
    quota: undefined,
    usage: undefined,
    savedRecordings: [],
    removeSavedRecording: vi.fn()
  });

  render(
    <Provider theme={defaultTheme}>
      <QuotaWarning thresholdBytes={2 ** 30}/>
    </Provider>
  );

  const quotaWarning = screen.queryByRole("alert");
  expect(quotaWarning).toBeNull();
});
