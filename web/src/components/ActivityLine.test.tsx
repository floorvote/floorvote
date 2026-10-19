import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { GroupingEvent } from '../../../shared/companionGroups'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import { POSITION_FEED_ICON, PRIORITY_COLORS } from '../../../shared/billChipColors'
import { USER_EVENT_ICONS } from '../../../shared/billCardModel'
import { ActivityLine, ThreadLineView } from './ActivityLine'

// The muted line a bill's comment thread shows for a change a person made to a
// team field. Timestamps are at midday so the date reads the same in any time
// zone.
const change = (id: string, over: Partial<FieldChangeEvent> = {}): FieldChangeEvent => ({
  id, createdAt: '2026-10-14 12:00:00', actorId: 'u-david', actorName: 'David Park', billId: 'a190', billNumber: 'A190',
  field: 'priority', label: 'priority', old: 'medium', new: 'high', ...over,
})

describe('ActivityLine', () => {
  it('is one note: an icon, who changed what, and the date', () => {
    render(<ActivityLine event={change('e1', { field: 'position', label: 'position', old: 'Oppose', new: 'Support' })} />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('thumbs_up_down' + 'David Park changed the official position from Oppose to Support · Oct 14')
  })

  it('opens the sentence with who made the change, in the weight a comment author name has', () => {
    render(<ActivityLine event={change('e1')} />)
    expect(screen.getByText('David Park')).toHaveStyle({ fontWeight: '600' })
  })

  // The same icon and color rules the feed and the email digest use for these
  // events, from shared/billCardModel (USER_EVENT_ICONS) and billChipColors.
  describe('the icon, as the feed and the digest draw it', () => {
    const glyph = (note: HTMLElement) => note.querySelector('.material-symbols-outlined') as HTMLElement | null
    const square = (note: HTMLElement) => note.querySelector('[data-testid="priority-square"]') as HTMLElement | null

    it.each(['high', 'medium', 'low'] as const)('draws a %s priority change as the priority square in that priority color, with no glyph', (level) => {
      render(<ActivityLine event={change('p', { old: null, new: level })} />)
      const note = screen.getByRole('note')
      expect(square(note)).not.toBeNull()
      expect(square(note)).toHaveStyle({ background: PRIORITY_COLORS[level].fill })
      expect(glyph(note)).toBeNull()
    })

    it('draws a cleared priority as the square in the feed fallback color', () => {
      render(<ActivityLine event={change('p', { old: 'high', new: null })} />)
      expect(square(screen.getByRole('note'))).toHaveStyle({ background: USER_EVENT_ICONS.priority_set.color })
    })

    it.each(Object.keys(POSITION_FEED_ICON))('draws setting the position to %s as the feed\'s filled thumbs-up-down glyph in that position\'s color', (position) => {
      render(<ActivityLine event={change('o', { field: 'position', label: 'position', old: null, new: position })} />)
      const icon = glyph(screen.getByRole('note'))!
      expect(icon.textContent).toBe(USER_EVENT_ICONS.position_set.name)
      expect(icon).toHaveStyle({ color: POSITION_FEED_ICON[position] })
      expect(icon.style.fontVariationSettings).toContain("'FILL' 1")
    })

    it('draws clearing the position as the same glyph, in the color the feed gives a cleared position', () => {
      render(<ActivityLine event={change('o', { field: 'position', label: 'position', old: 'Support', new: null })} />)
      const icon = glyph(screen.getByRole('note'))!
      expect(icon.textContent).toBe('thumbs_up_down')
      expect(icon).toHaveStyle({ color: USER_EVENT_ICONS.position_set.color })
    })

    it('falls back to the feed color for a position the vocabulary has no color for', () => {
      render(<ActivityLine event={change('o', { field: 'position', label: 'position', old: null, new: 'Watching closely' })} />)
      expect(glyph(screen.getByRole('note'))).toHaveStyle({ color: USER_EVENT_ICONS.position_set.color })
    })

    it('draws a custom field change with the shared table\'s custom field entry', () => {
      render(<ActivityLine event={change('c', { field: 'customField', label: 'Lead', old: null, new: 'Legal' })} />)
      const icon = glyph(screen.getByRole('note'))!
      expect(icon.textContent).toBe(USER_EVENT_ICONS.custom_field_set.name)
      expect(icon).toHaveStyle({ color: USER_EVENT_ICONS.custom_field_set.color })
    })

    it('hides every icon from a screen reader', () => {
      render(<>
        <ActivityLine event={change('p')} />
        <ActivityLine event={change('o', { field: 'position', label: 'position', old: null, new: 'Support' })} />
        <ActivityLine event={change('c', { field: 'customField', label: 'Lead', old: null, new: 'Legal' })} />
      </>)
      for (const note of screen.getAllByRole('note')) {
        const mark = square(note) ?? glyph(note)
        expect(mark?.getAttribute('aria-hidden')).toBe('true')
      }
    })
  })

  it("words the position as the page does, when told", () => {
    render(<ActivityLine event={change('o', { field: 'position', label: 'position', old: null, new: 'Support' })} positionLabel="association position" />)
    expect(screen.getByRole('note')).toHaveTextContent('David Park set the association position to Support')
  })

  it("shows what the page gives for a change made on a companion, after the sentence, and nothing for one made here", () => {
    const renderBill = (e: FieldChangeEvent) => e.billId === 'a190' ? null : <span data-testid="mark">{e.billNumber}</span>
    render(<>
      <ActivityLine event={change('own')} renderBill={renderBill} />
      <ActivityLine event={change('other', { billId: 'b1713', billNumber: 'S1713' })} renderBill={renderBill} />
    </>)
    const [own, other] = screen.getAllByRole('note')
    expect(within(own).queryByTestId('mark')).toBeNull()
    expect(within(other).getByTestId('mark')).toHaveTextContent('S1713')
    expect(other.textContent!.indexOf('S1713')).toBeGreaterThan(other.textContent!.indexOf('Oct 14'))
  })
})

describe('ThreadLineView', () => {
  const grouping: GroupingEvent = { id: 'g', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: 'Ada', with: [{ billId: 'b1713', billNumber: 'S1713' }], commentBills: [], replaced: [] }

  it('draws a grouping line as the grouping line and a change as an activity line', () => {
    render(<>
      <ThreadLineView line={{ kind: 'grouping', key: 'g', event: grouping }} />
      <ThreadLineView line={{ kind: 'change', key: 'e1', event: change('e1') }} />
    </>)
    const notes = screen.getAllByRole('note')
    expect(notes[0]).toHaveTextContent('link' + 'Ada grouped this bill with S1713 on October 11.')
    expect(notes[1]).toHaveTextContent('David Park changed priority from Medium to High')
  })

  it('draws no button: nothing in the thread folds or opens', () => {
    render(<ThreadLineView line={{ kind: 'change', key: 'e1', event: change('e1') }} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
