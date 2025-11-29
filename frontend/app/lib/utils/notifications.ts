import { ToastQueue } from "@adobe/react-spectrum";

export function showError(description: string, err?: unknown) {
  if(err !== undefined) {
    const message = err instanceof Error ? err.message : 'unknown error';

    console.log(description, err);
    ToastQueue.negative(`${description}: ${message}`, { timeout: 5000 });
  } else {
    ToastQueue.negative(description, { timeout: 5000 });
  }
}

export function showSuccess(message: string) {
  ToastQueue.positive(message, { timeout: 5000 });
}
