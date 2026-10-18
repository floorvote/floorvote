import { expect } from 'vitest'
import { color } from '../styles/tokens'

// Style tokens are CSS variables (`var(--fv-…)`), which jsdom can't resolve, so
// toHaveStyle can't compare them (and `not.toHaveStyle` would pass for the wrong
// reason). Read the inline style attribute instead.
const inline = (el: HTMLElement) => el.getAttribute('style') ?? ''

/** The amber new-match state: the amber fill, dark amber text, and amber border. */
export function expectAmber(el: HTMLElement) {
  const s = inline(el)
  expect(s).toContain(`background: ${color.bgAmberPriority}`)
  expect(s).toContain(`color: ${color.textAmberDark}`)
  expect(s).toContain(`border: 1px solid ${color.borderAmber}`)
}

export function expectNotAmber(el: HTMLElement) {
  const s = inline(el)
  expect(s).not.toContain(color.bgAmberPriority)
  expect(s).not.toContain(color.textAmberDark)
  expect(s).not.toContain(color.borderAmber)
}

/** An empty priority: white, muted text, default border. */
export function expectPlainEmpty(el: HTMLElement) {
  const s = inline(el)
  expect(s).toContain(`background: ${color.white}`)
  expect(s).toContain(`color: ${color.textMuted}`)
  expect(s).toContain(`border: 1px solid ${color.borderDefault}`)
}

export const fontSizeOf = (el: HTMLElement) => /font-size: ([^;]+);/.exec(inline(el))?.[1]
