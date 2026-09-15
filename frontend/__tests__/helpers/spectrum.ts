import { screen, within } from "@testing-library/react";

/**
 * Helpers for reaching S2 controls from the data-testid the component sets on them.
 *
 * S2 forwards data-* attributes to an outer wrapper element rather than to the control itself.
 * A Switch, for instance, renders
 *
 *     <div data-testid="..." data-disabled="true"><label><input role="switch"/>...</label></div>
 *
 * so the element the testid names is a plain div: clicking it does not reach the input, and
 * toBeDisabled() fails on it because a div is never disabled -- it carries data-disabled instead.
 * Spectrum v3 put the testid on the control, which is why the assertions used to work directly.
 *
 * Going through the ARIA role keeps the tests pointed at the thing the user actually operates,
 * and means they stop caring where S2 chooses to hang the attribute.
 */
export const getSwitch = (testId: string) =>
  within(screen.getByTestId(testId)).getByRole("switch");

export const findSwitch = async (testId: string) =>
  within(await screen.findByTestId(testId)).getByRole("switch");
