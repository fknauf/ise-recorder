import { ReactNode } from "react";
import { Accordion } from "@mantine/core";

/** The id to give the section under test, so that ExpandedSection opens it. */
export const SECTION_ID = "section-under-test";

/**
 * Holds a recording section open, the way the home page's accordion does.
 *
 * A section is an accordion item and cannot render outside an accordion at all, and inside a
 * closed one its cards are hidden, so role queries cannot see them and every "there is no such
 * button" check passes whether the button is there or not. Wrapping it here keeps the tests
 * about the section's content independent of how the page arranges and collapses it.
 */
export const ExpandedSection = ({ children }: Readonly<{ children: ReactNode }>) =>
  <Accordion multiple defaultValue={[ SECTION_ID ]}>
    {children}
  </Accordion>;
