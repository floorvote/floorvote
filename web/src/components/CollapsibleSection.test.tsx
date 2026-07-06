import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CollapsibleSection } from './CollapsibleSection'

function mockMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
}

function bodyOf(): HTMLElement {
  return screen.getByText('body content').closest('[aria-hidden]') as HTMLElement
}

describe('CollapsibleSection', () => {
  beforeEach(() => mockMatchMedia(false))

  it('renders children even when closed (always mounted)', () => {
    render(
      <CollapsibleSection label="Actions" open={false} onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('body content')).not.toBeNull()
  })

  it('collapses grid rows + hides body when closed, expands when open', () => {
    const { rerender } = render(
      <CollapsibleSection label="Actions" open={false} onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(bodyOf().style.gridTemplateRows).toBe('0fr')
    expect(bodyOf().getAttribute('aria-hidden')).toBe('true')
    expect(bodyOf().hasAttribute('inert')).toBe(true)

    rerender(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(bodyOf().style.gridTemplateRows).toBe('1fr')
    expect(bodyOf().getAttribute('aria-hidden')).toBe('false')
    expect(bodyOf().hasAttribute('inert')).toBe(false)
  })

  it('calls onToggle when the header is clicked', () => {
    const onToggle = vi.fn()
    render(
      <CollapsibleSection label="Actions" open={false} onToggle={onToggle}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Actions/ }))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reflects open state via aria-expanded on the header button', () => {
    const { rerender } = render(
      <CollapsibleSection label="Actions" open={false} onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.getByRole('button', { name: /Actions/ }).getAttribute('aria-expanded')).toBe('false')
    rerender(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.getByRole('button', { name: /Actions/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('renders the count badge only when count is provided', () => {
    const { rerender } = render(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('7')).toBeNull()
    rerender(
      <CollapsibleSection label="Actions" count={7} open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('7')).not.toBeNull()
  })

  it('shows closedSummary only when closed and openHint only when open', () => {
    const { rerender } = render(
      <CollapsibleSection
        label="Actions"
        open={false}
        onToggle={() => {}}
        closedSummary={<span>last action summary</span>}
        openHint={<span>most recent first</span>}
      >
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('last action summary')).not.toBeNull()
    expect(screen.queryByText('most recent first')).toBeNull()

    rerender(
      <CollapsibleSection
        label="Actions"
        open
        onToggle={() => {}}
        closedSummary={<span>last action summary</span>}
        openHint={<span>most recent first</span>}
      >
        <p>body content</p>
      </CollapsibleSection>,
    )
    expect(screen.queryByText('last action summary')).toBeNull()
    expect(screen.queryByText('most recent first')).not.toBeNull()
  })

  it('disables transitions under prefers-reduced-motion', () => {
    mockMatchMedia(true)
    render(
      <CollapsibleSection label="Actions" open onToggle={() => {}}>
        <p>body content</p>
      </CollapsibleSection>,
    )
    // grid wrapper (rows transition)
    expect(bodyOf().style.transition).toBe('')
    // outer wrapper (box-shadow transition)
    expect((bodyOf().parentElement as HTMLElement).style.transition).toBe('')
    // inner content div (opacity/transform transition) — the <p>'s parent
    expect((screen.getByText('body content').parentElement as HTMLElement).style.transition).toBe('')
    // chevron (rotate transition)
    expect(screen.getByText('▼').style.transition).toBe('')
  })
})
