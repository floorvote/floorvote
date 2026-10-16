import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LegislativeHistory } from './LegislativeHistory'

// The header on LegislativeHistory is a disclosure, like the dotted-underline
// toggletips of #575 and #579: click, tap, Enter, or Space opens or closes the
// timeline, Escape closes it, it is a real button with the pointer cursor, and
// it never sits inside a link or another button. Unlike those, it opens the
// timeline inline rather than in a floating bubble, so there is no hover or
// focus preview: the timeline is too long for one, and hover cannot reveal what
// a tap would not.
const ENTRY = 'Introduced in the Senate'
const entries = [{ date: '2026-04-10', action: ENTRY, chamber: 'S' }]
const props = { entries, votes: [], lastAction: 'Signed by Governor', lastActionDate: '2026-04-20' }
const header = () => screen.getByRole('button', { name: /Signed by Governor/ })
const timeline = () => screen.queryByText(ENTRY)

describe('LegislativeHistory header trigger', () => {
  it('starts closed, and a click opens the timeline and a second click closes it', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    expect(timeline()).toBeNull()
    await user.click(header())
    expect(timeline()).toBeInTheDocument()
    await user.click(header())
    expect(timeline()).toBeNull()
  })

  it('opens on a tap and closes on a second tap', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    await user.pointer({ keys: '[TouchA]', target: header() })
    expect(timeline()).toBeInTheDocument()
    await user.pointer({ keys: '[TouchA]', target: header() })
    expect(timeline()).toBeNull()
  })

  it('Enter toggles it', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    await user.tab()
    expect(header()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(timeline()).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(timeline()).toBeNull()
  })

  it('Space toggles it', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    await user.tab()
    await user.keyboard(' ')
    expect(timeline()).toBeInTheDocument()
    await user.keyboard(' ')
    expect(timeline()).toBeNull()
  })

  it('Escape closes an open timeline, keeping focus, and the next click opens it again', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    await user.click(header())
    expect(timeline()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(timeline()).toBeNull()
    expect(header()).toHaveFocus()
    await user.click(header())
    expect(timeline()).toBeInTheDocument()
  })

  it('Escape on a closed timeline does nothing', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    await user.tab()
    await user.keyboard('{Escape}')
    expect(timeline()).toBeNull()
  })

  it('a click survives the mouse leaving and entering: hover alone neither opens nor closes it', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    fireEvent.pointerEnter(header(), { pointerType: 'mouse' })
    expect(timeline()).toBeNull()
    await user.click(header())
    fireEvent.pointerLeave(header(), { pointerType: 'mouse' })
    expect(timeline()).toBeInTheDocument()
  })

  it('exposes its state: aria-expanded follows the timeline', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory {...props} />)
    expect(header()).toHaveAttribute('aria-expanded', 'false')
    await user.click(header())
    expect(header()).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(header()).toHaveAttribute('aria-expanded', 'false')
  })

  it('is a button with the pointer cursor and a dotted underline when there is a timeline', () => {
    render(<LegislativeHistory {...props} />)
    expect(header().tagName).toBe('BUTTON')
    expect(header()).toHaveAttribute('type', 'button')
    expect(header().style.cursor).toBe('pointer')
    expect(header().style.borderBottom).toContain('dotted')
  })

  it('is one tab stop, and not nested inside a link or button', () => {
    render(<div><LegislativeHistory {...props} /></div>)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(header().closest('a')).toBeNull()
    expect(header().parentElement?.closest('button')).toBeNull()
    expect(header().querySelector('a, button, [tabindex]')).toBeNull()
  })

  it('does not submit a form it sits in', async () => {
    const user = userEvent.setup()
    let submitted = false
    render(<form onSubmit={(e) => { e.preventDefault(); submitted = true }}><LegislativeHistory {...props} /></form>)
    await user.click(header())
    await user.tab()
    await user.keyboard('{Enter}')
    expect(submitted).toBe(false)
  })

  it('with a single event there is no timeline: no dotted underline, no disclosure, and a click opens nothing', async () => {
    const user = userEvent.setup()
    render(<LegislativeHistory entries={[]} votes={[]} lastAction="Signed by Governor" lastActionDate={null} />)
    const btn = screen.getByRole('button', { name: /Signed by Governor/ })
    expect(btn.style.borderBottom).not.toContain('dotted')
    expect(btn.style.cursor).toBe('default')
    expect(btn).not.toHaveAttribute('aria-expanded')
    await user.click(btn)
    expect(screen.queryByText('▲')).toBeNull()
  })

  it('hideHeader renders the timeline with no trigger', () => {
    render(<LegislativeHistory {...props} hideHeader />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(timeline()).toBeInTheDocument()
  })
})
