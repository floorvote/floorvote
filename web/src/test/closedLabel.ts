import { expect } from 'vitest'

// The priority and position dropdowns draw their closed prompt ("Set priority", "New · Set priority", "Set position")
// as a label layered over the select, because the select itself holds the real empty choice ("No priority", "Not set").
// The label is marked data-closed-label and exists only while the control has no value.

const labelFor = (select: HTMLElement) => select.parentElement?.querySelector('[data-closed-label]') ?? null

/** The closed prompt drawn over an empty select, or null when the control has a value. */
export const closedLabelOf = (select: HTMLElement): string | null => labelFor(select)?.textContent ?? null

/** An empty control: the prompt reads `text`, and the select itself sits on its real empty choice. */
export function expectClosedLabel(select: HTMLElement, text: string) {
  expect(closedLabelOf(select)).toBe(text)
}

/** A control with a value: no prompt layered over it. */
export function expectNoClosedLabel(select: HTMLElement) {
  expect(closedLabelOf(select)).toBeNull()
}
