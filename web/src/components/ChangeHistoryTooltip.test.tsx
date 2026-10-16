import { describe, it, expect } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChangeHistoryTooltip, resolveUpdatedTs, type ChangeRecord } from './ChangeHistoryTooltip'

const statusChange: ChangeRecord = { changeType: 'status_change', oldValue: 'Introduced', newValue: 'In Committee', detail: null, detectedAt: '2026-06-01 12:00:00' }
const actionChange: ChangeRecord = { changeType: 'action_added', oldValue: null, newValue: 'Passed committee', detail: '2026-06-03', detectedAt: '2026-06-05 12:00:00' }

// Hover-open helper for the panel-content tests. relativeTime is stubbed to a
// fixed label so we can find the trigger by text regardless of which timestamp
// the component chose to drive the headline.
function open(changes: ChangeRecord[]) {
  render(<ChangeHistoryTooltip changes={changes} lastActionDate={null} relativeTime={() => '2 days ago'} />)
  fireEvent.pointerEnter(screen.getByText(/Updated 2 days ago/), { pointerType: 'mouse' })
}

describe('resolveUpdatedTs', () => {
  it('returns the most recent detected change, regardless of array order', () => {
    // Deliberately out of order — the helper must pick the max, not changes[0].
    expect(resolveUpdatedTs([statusChange, actionChange], null)).toBe('2026-06-05 12:00:00')
    expect(resolveUpdatedTs([actionChange, statusChange], null)).toBe('2026-06-05 12:00:00')
  })

  it('ignores lastActionDate when detected changes exist', () => {
    expect(resolveUpdatedTs([statusChange], '2024-01-01')).toBe('2026-06-01 12:00:00')
  })

  it('falls back to lastActionDate, normalized to UTC midnight, when there are no changes', () => {
    // Date-only strings must be made parseable (dbTsToEpoch NaNs on "2026-03-26Z").
    expect(resolveUpdatedTs([], '2026-03-26')).toBe('2026-03-26T00:00:00Z')
  })

  it('returns null when there are no changes and no lastActionDate', () => {
    expect(resolveUpdatedTs([], null)).toBeNull()
    expect(resolveUpdatedTs([], undefined)).toBeNull()
  })
})

describe('ChangeHistoryTooltip', () => {
  it('drives the headline off the latest detected change, not the row write time', () => {
    // relativeTime echoes its input so we can assert WHICH timestamp was used.
    render(<ChangeHistoryTooltip changes={[statusChange, actionChange]} lastActionDate={null} relativeTime={(ts) => ts} />)
    expect(screen.getByText(/Updated 2026-06-05 12:00:00/)).toBeInTheDocument()
  })

  it('reveals a titled change-log panel with caption on hover', () => {
    open([statusChange])
    // Source text is "Change log"; CSS text-transform:uppercase renders it
    // "CHANGE LOG" but jsdom textContent reports the source text.
    expect(screen.getByText('Change log')).toBeInTheDocument()
    expect(screen.getByText(/Updates detected by the tracker/)).toBeInTheDocument()
  })

  it('renders the shared change text and the detected date', () => {
    open([statusChange])
    expect(screen.getByText(/Status: Introduced → In Committee/)).toBeInTheDocument()
    // detectedAt formatted as an absolute month-day (e.g. "Jun 1")
    expect(screen.getByText(/Jun 1/)).toBeInTheDocument()
  })

  it('appends the action date inline on action_added rows', () => {
    open([actionChange])
    // text = formatBillUpdateDetail + " · <action date>"; action date is Jun 3, detected Jun 5
    expect(screen.getByText(/Action: Passed committee · Jun 3/)).toBeInTheDocument()
  })

  it('drops the inline action date when the action date is a sentinel/invalid value', () => {
    open([{ changeType: 'action_added', oldValue: null, newValue: 'Referred to committee', detail: '0000-00-00', detectedAt: '2026-06-05 12:00:00' }])
    expect(screen.getByText('Action: Referred to committee')).toBeInTheDocument()
    expect(screen.queryByText(/Invalid Date/)).toBeNull()
  })

  it('renders the trigger plain (no tooltip) from lastActionDate when there are no changes', () => {
    render(<ChangeHistoryTooltip changes={[]} lastActionDate="2026-03-26" relativeTime={() => '3 months ago'} />)
    const trigger = screen.getByText(/Updated 3 months ago/)
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    expect(screen.queryByText('Change log')).toBeNull()
  })

  it('renders nothing when there are no changes and no lastActionDate', () => {
    const { container } = render(<ChangeHistoryTooltip changes={[]} lastActionDate={null} relativeTime={() => 'x'} />)
    expect(container).toBeEmptyDOMElement()
  })
})

// The "Updated X ago" trigger is a toggletip, like the ⓘ and the term explainers
// (#575): click, tap, Enter, or Space pins the change log open or closed, Escape
// closes it, and hover and focus still preview it.
describe('ChangeHistoryTooltip toggletip', () => {
  const log = () => screen.queryByText('Change log')
  const trigger = () => screen.getByRole('button', { name: /Updated 2 days ago/ })
  const renderIt = (extra?: React.ReactNode) => render(
    <>
      <ChangeHistoryTooltip changes={[statusChange]} lastActionDate={null} relativeTime={() => '2 days ago'} />
      {extra}
    </>,
  )

  it('opens on a click and closes on a second click', async () => {
    const user = userEvent.setup()
    renderIt()
    expect(log()).toBeNull()
    await user.click(trigger())
    expect(log()).toBeInTheDocument()
    await user.click(trigger())
    expect(log()).toBeNull()
  })

  it('opens on a tap and closes on a second tap', async () => {
    const user = userEvent.setup()
    renderIt()
    await user.pointer({ keys: '[TouchA]', target: trigger() })
    expect(log()).toBeInTheDocument()
    await user.pointer({ keys: '[TouchA]', target: trigger() })
    expect(log()).toBeNull()
  })

  it('a click pins it open after the mouse leaves', async () => {
    const user = userEvent.setup()
    renderIt()
    await user.click(trigger())
    fireEvent.pointerLeave(trigger(), { pointerType: 'mouse' })
    expect(log()).toBeInTheDocument()
  })

  it('Enter toggles it: the first pins the focus preview, the second closes', async () => {
    const user = userEvent.setup()
    renderIt()
    await user.tab()
    expect(trigger()).toHaveFocus()
    expect(log()).toBeInTheDocument() // focus preview
    await user.keyboard('{Enter}')
    expect(log()).toBeInTheDocument() // pinned
    await user.keyboard('{Enter}')
    expect(log()).toBeNull()
    await user.keyboard('{Enter}')
    expect(log()).toBeInTheDocument()
  })

  it('Space toggles it the same way', async () => {
    const user = userEvent.setup()
    renderIt()
    await user.tab()
    await user.keyboard(' ')
    expect(log()).toBeInTheDocument()
    await user.keyboard(' ')
    expect(log()).toBeNull()
  })

  it('Escape closes a click-pinned log, keeping focus, and the next click opens it again', async () => {
    const user = userEvent.setup()
    renderIt()
    await user.click(trigger())
    expect(log()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(log()).toBeNull()
    expect(trigger()).toHaveFocus()
    await user.click(trigger())
    expect(log()).toBeInTheDocument()
  })

  it('Escape closes a hover preview', () => {
    renderIt()
    fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' })
    expect(log()).toBeInTheDocument()
    fireEvent.keyDown(trigger(), { key: 'Escape' })
    expect(log()).toBeNull()
  })

  it('previews on hover and hides when an unpinned hover leaves', () => {
    renderIt()
    fireEvent.pointerEnter(trigger(), { pointerType: 'mouse' })
    expect(log()).toBeInTheDocument()
    fireEvent.pointerLeave(trigger(), { pointerType: 'mouse' })
    expect(log()).toBeNull()
  })

  it('does not preview on a touch pointerenter, so a tap cannot strand the log', () => {
    renderIt()
    fireEvent.pointerEnter(trigger(), { pointerType: 'touch' })
    expect(log()).toBeNull()
  })

  it('previews on keyboard focus and hides on blur', async () => {
    const user = userEvent.setup()
    renderIt(<button>next</button>)
    await user.tab()
    expect(log()).toBeInTheDocument()
    await user.tab()
    expect(log()).toBeNull()
  })

  it('the trigger is a button named by its text, with the pointer cursor, and keeps its dotted underline', () => {
    renderIt()
    const btn = trigger()
    expect(btn.tagName).toBe('BUTTON')
    expect(btn).toHaveAttribute('type', 'button')
    expect(btn.style.cursor).toBe('pointer')
    expect(screen.getByText(/Updated 2 days ago/).style.borderBottom).toContain('dotted')
    // The inner span must not override the button's pointer cursor with its own.
    expect(screen.getByText(/Updated 2 days ago/).style.cursor).not.toBe('default')
  })

  it('is a single tab stop, and not nested inside a link or button', () => {
    render(<div><ChangeHistoryTooltip changes={[statusChange]} lastActionDate={null} relativeTime={() => '2 days ago'} /></div>)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(trigger().closest('a')).toBeNull()
    expect(trigger().parentElement?.closest('button')).toBeNull()
  })

  it('announces the open log the way the ⓘ does: a role=tooltip bubble the button is described by', async () => {
    const user = userEvent.setup()
    renderIt()
    await user.click(trigger())
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent(/Status: Introduced → In Committee/)
    expect(trigger().getAttribute('aria-describedby')).toBe(tip.id)
  })

  it('does not submit a form it sits in', async () => {
    const user = userEvent.setup()
    let submitted = false
    render(
      <form onSubmit={(e) => { e.preventDefault(); submitted = true }}>
        <ChangeHistoryTooltip changes={[statusChange]} lastActionDate={null} relativeTime={() => '2 days ago'} />
      </form>,
    )
    await user.click(trigger())
    await user.tab()
    await user.keyboard('{Enter}')
    expect(submitted).toBe(false)
  })

  it('with no changes the trigger stays plain text: no button, no underline, no log', async () => {
    const user = userEvent.setup()
    render(<ChangeHistoryTooltip changes={[]} lastActionDate="2026-03-26" relativeTime={() => '3 months ago'} />)
    expect(screen.queryByRole('button')).toBeNull()
    const el = screen.getByText(/Updated 3 months ago/)
    expect(el.style.borderBottom).toBe('')
    await user.click(el)
    expect(log()).toBeNull()
  })
})
