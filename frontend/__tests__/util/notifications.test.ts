import { beforeEach, expect, test, vi } from "vitest";
import { ToastQueue } from "@adobe/react-spectrum";
import { showError, showSuccess } from "@/lib/utils/notifications";

// Everywhere else this module is mocked, so these are the only tests of what a toast says.
// They pin what goes into it, not how it is worded.

beforeEach(() => {
  vi.spyOn(ToastQueue, "negative").mockImplementation(() => () => {});
  vi.spyOn(ToastQueue, "positive").mockImplementation(() => () => {});
  vi.spyOn(ToastQueue, "neutral").mockImplementation(() => () => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const toastText = (toast: "negative" | "positive" | "neutral") => vi.mocked(ToastQueue[toast]).mock.calls[0][0];

test("an error toast names what failed and why", () => {
  showError("Failed to purge GVS_2025", new Error("HTTP 409: in use"));

  expect(ToastQueue.negative).toHaveBeenCalledOnce();
  expect(toastText("negative")).toContain("Failed to purge GVS_2025");
  expect(toastText("negative")).toContain("HTTP 409: in use");
});

test("something thrown that is not an Error still makes a readable toast", () => {
  // a string, or an abort reason -- whatever it is, the lecturer gets no "[object Object]"
  showError("Recording failed", { reason: "stop" });

  expect(toastText("negative")).toContain("Recording failed");
  expect(toastText("negative")).not.toMatch(/\[object|undefined/);
});

test("an error toast without an error is just the description", () => {
  showError("Nothing to upload for GVS_2025");

  expect(toastText("negative")).toBe("Nothing to upload for GVS_2025");
});

test("error and success toasts go away by themselves", () => {
  showError("Failed to purge GVS_2025", new Error("in use"));
  showSuccess("Purged GVS_2025");

  expect(vi.mocked(ToastQueue.negative).mock.calls[0][1]?.timeout).toBeGreaterThan(0);
  expect(vi.mocked(ToastQueue.positive).mock.calls[0][1]?.timeout).toBeGreaterThan(0);
});

