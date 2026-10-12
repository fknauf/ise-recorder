"use client";

import { notifications, NotificationData } from "@mantine/notifications";
import { XIcon, CheckIcon, InfoIcon } from "@phosphor-icons/react";

const defaultNotification: Partial<NotificationData> = {
  autoClose: 5000,
  withBorder: true
};

export function showError(description: string, err?: unknown) {
  const common: Partial<NotificationData> = {
    ...defaultNotification,
    color: "error",
    icon: <XIcon/>,
    title: "Error"
  };

  if(err !== undefined) {
    const message = err instanceof Error ? err.message : "unknown error";

    console.log(description, err);
    notifications.show({ ...common, message: `${description}: ${message}` });
  } else {
    notifications.show({ ...common, message: description });
  }
}

export function showSuccess(message: string) {
  notifications.show({
    ...defaultNotification,
    color: "success",
    icon: <CheckIcon/>,
    title: "Success",
    message
  });
}

export function showMessage(message: string) {
  notifications.show({
    ...defaultNotification,
    color: "neutral",
    icon: <InfoIcon/>,
    title: "Notice",
    message
  });
}
