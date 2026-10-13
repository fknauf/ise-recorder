// Mantine's components are styled from this sheet, which the root layout loads for the app.
// Without it they still render, but at whatever size the browser gives them unstyled, so any
// test that looks at layout would be measuring something the app never shows.
import "@mantine/core/styles.css";

import { ReactNode } from "react";
import { Card, MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";

/**
 * The providers the root layout puts around every page, for components rendered on their own.
 *
 * Mantine's components refuse to render without a MantineProvider above them, and the confirm
 * dialogs are opened through the modals manager, which only does anything under a
 * ModalsProvider. Notifications are left out: the home page mounts its own container, and
 * everywhere else the notifications module is mocked.
 */
export const MantineTestProvider = ({ children }: Readonly<{ children: ReactNode }>) =>
  <MantineProvider>
    <ModalsProvider>
      {children}
    </ModalsProvider>
  </MantineProvider>;

/**
 * The previews draw into a Card.Section, which only renders inside the Card that PreviewSection
 * gives every preview. Usable as a testing-library wrapper, so rerender keeps the card.
 */
export const InPreviewCard = ({ children }: Readonly<{ children: ReactNode }>) =>
  <MantineTestProvider>
    <Card>
      {children}
    </Card>
  </MantineTestProvider>;
