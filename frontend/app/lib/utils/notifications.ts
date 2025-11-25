import { ToastQueue } from "@adobe/react-spectrum";

export function showError(description: string, err: unknown) {
  const message = err instanceof Error ? err.message : 'unknown error';
  ToastQueue.negative(`${description}: ${message}`, { timeout: 5000 });
}

export function showSuccess(message: string) {
  ToastQueue.positive(message, { timeout: 5000 });
}
