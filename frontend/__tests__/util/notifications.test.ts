import { beforeEach, expect, test, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { showError, showMessage, showSuccess } from "@/lib/utils/notifications";

// Everywhere else this module is mocked, so these are the only tests of what a toast says.
// They pin what goes into it, not how it is worded.

beforeEach(() => {
  vi.spyOn(notifications, "show").mockImplementation(() => "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

const shown = (call = 0) => vi.mocked(notifications.show).mock.calls[call][0];

test("an error toast names what failed and why", () => {
  showError("Failed to purge GVS_2025", new Error("HTTP 409: in use"));

  expect(notifications.show).toHaveBeenCalledOnce();
  expect(shown().message).toContain("Failed to purge GVS_2025");
  expect(shown().message).toContain("HTTP 409: in use");
});

test("something thrown that is not an Error still makes a readable toast", () => {
  // a string, or an abort reason -- whatever it is, the lecturer gets no "[object Object]"
  showError("Recording failed", { reason: "stop" });

  expect(shown().message).toContain("Recording failed");
  expect(shown().message).not.toMatch(/\[object|undefined/);
});

test("an error toast without an error is just the description", () => {
  showError("Nothing to upload for GVS_2025");

  expect(shown().message).toBe("Nothing to upload for GVS_2025");
});

test("every kind of toast goes away by itself", () => {
  showError("Failed to purge GVS_2025", new Error("in use"));
  showSuccess("Purged GVS_2025");
  showMessage("Postprocessing scheduled for GVS_2025");

  // false would keep it up until it is clicked away
  for(const call of [ 0, 1, 2 ]) {
    expect(shown(call).autoClose).toBeGreaterThan(0);
  }
});

test("errors, successes and plain messages look different from each other", () => {
  // the lecturer tells them apart at a glance, before reading them
  showError("Failed to purge GVS_2025");
  showSuccess("Purged GVS_2025");
  showMessage("Postprocessing scheduled for GVS_2025");

  expect(new Set([ shown(0).color, shown(1).color, shown(2).color ]).size).toBe(3);
});
