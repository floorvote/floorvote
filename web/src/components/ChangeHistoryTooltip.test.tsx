import { describe, it, expect } from 'vitest'
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
