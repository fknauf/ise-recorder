import { ReactNode } from "react";
import { Accordion } from "@adobe/react-spectrum";

/** The id to give the section under test, so that ExpandedSection opens it. */
export const SECTION_ID = "section-under-test";

/**
 * Holds a recording section open, the way the home page's accordion does.
 *
 * On its own a section is a collapsed disclosure: its cards are in the DOM but hidden, so
 * role queries cannot see them and every "there is no such button" check passes whether
 * the button is there or not. Wrapping it here keeps the tests about the section's content
 * independent of how the page arranges and collapses it.
 */
export const ExpandedSection = ({ children }: Readonly<{ children: ReactNode }>) =>
  <Accordion defaultExpandedKeys={[ SECTION_ID ]}>
    {children}
  </Accordion>;
