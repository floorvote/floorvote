import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GroupingEvent } from '../../../shared/companionGroups'
import type { FieldChangeEvent } from '../../../shared/teamFields'
import { ActivityFold, ActivityLine, ThreadLineView } from './ActivityLine'

// The muted lines a bill's comment thread shows for its team's changes: one for
// a change, one that folds a run of them and opens in place. Timestamps are at
// midday so the date reads the same in any time zone.
const change = (id: string, over: Partial<FieldChangeEvent> = {}): FieldChangeEvent => ({
  id, createdAt: '2026-10-14 12:00:00', actorId: 'u-david', actorName: 'David Park', billId: 'a190', billNumber: 'A190',
  field: 'priority', label: 'priority', old: 'medium', new: 'high', ...over,
})
const run = [
  change('e1', { createdAt: '2026-10-14 10:00:00', old: null, new: 'medium' }),
  change('e2', { createdAt: '2026-10-14 11:00:00', field: 'position', label: 'position', old: null, new: 'Support' }),
  change('e3', { createdAt: '2026-10-15 12:00:00' }),
]

describe('ActivityLine', () => {
  it('is one note: an icon, who changed what, and the date', () => {
    render(<ActivityLine event={change('e1')} />)
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('flag' + 'David Park changed priority from Medium to High · Oct 14')
  })

  it('draws the icon of the field that changed, hidden from a screen reader', () => {
    render(<>
      <ActivityLine event={change('p')} />
      <ActivityLine event={change('o', { field: 'position', label: 'position', old: null, new: 'Support' })} />
      <ActivityLine event={change('c', { field: 'customField', label: 'Lead', old: null, new: 'Legal' })} />
      <ActivityLine event={change('t', { field: 'tags', label: 'tags', old: [], new: ['Energy'] })} />
    </>)
    const icons = screen.getAllByRole('note').map(n => n.querySelector('.material-symbols-outlined'))
    expect(icons.map(i => i?.textContent)).toEqual(['flag', 'thumbs_up_down', 'edit_note', 'list'])
    expect(icons.every(i => i?.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('names FloorVote for a change with no actor', () => {
    render(<ActivityLine event={change('t', { actorName: null, actorId: null, field: 'tags', label: 'tags', old: [], new: ['Energy'] })} />)
    expect(screen.getByRole('note')).toHaveTextContent('FloorVote added the tag Energy · Oct 14')
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

describe('ActivityFold', () => {
  const fold = (props: Partial<React.ComponentProps<typeof ActivityFold>> = {}) =>
    render(<ActivityFold actorName="David Park" events={run} {...props} />)
  const toggle = () => screen.getByRole('button', { name: /3 changes by David Park/ })

  it('shows a button counting the changes and naming who made them, closed, with none of them showing', () => {
    fold()
    expect(toggle()).toHaveTextContent('3 changes by David Park')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('note')).toHaveLength(0)
    expect(screen.queryByText(/changed priority/)).toBeNull()
  })

  it('names FloorVote when no one made the changes', () => {
    fold({ actorName: null })
    expect(screen.getByRole('button', { name: /3 changes by FloorVote/ })).toBeInTheDocument()
  })

  it('opens in place on a click: each change as its own line, oldest first, the button saying it is open', async () => {
    fold()
    await userEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('note').map(n => n.textContent)).toEqual([
      'flag' + 'David Park set priority to Medium · Oct 14',
      'thumbs_up_down' + 'David Park set the official position to Support · Oct 14',
      'flag' + 'David Park changed priority from Medium to High · Oct 15',
    ])
  })

  it('closes again on a second click', async () => {
    fold()
    await userEvent.click(toggle())
    await userEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByRole('note')).toHaveLength(0)
  })

  it('opens and closes from the keyboard with Enter and Space, keeping focus on the button', async () => {
    fold()
    await userEvent.tab()
    expect(toggle()).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle()).toHaveFocus()
    await userEvent.keyboard(' ')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toHaveFocus()
  })

  it('is one tab stop when closed, and when open adds none of its own: its lines are not buttons', async () => {
    fold()
    await userEvent.click(toggle())
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('ties the button to the list of lines it opens, and lists them for a screen reader', async () => {
    fold()
    expect(toggle()).not.toHaveAttribute('aria-controls', expect.stringMatching(/./)) // nothing to control while closed
    await userEvent.click(toggle())
    const list = screen.getByRole('list')
    expect(toggle()).toHaveAttribute('aria-controls', list.id)
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
  })

  it('reads the button, then the lines, in that order for a screen reader', async () => {
    fold()
    await userEvent.click(toggle())
    const all = Array.from(document.body.querySelectorAll('button, [role="note"]'))
    expect(all[0]).toBe(toggle())
    expect(all.slice(1).every(el => el.getAttribute('role') === 'note')).toBe(true)
  })

  it('hides the arrow from a screen reader, which reads the state from aria-expanded', () => {
    fold()
    expect(toggle().querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(toggle()).toHaveAccessibleName('3 changes by David Park')
  })

  it("passes each line's companion mark through, and positionLabel", async () => {
    const renderBill = (e: FieldChangeEvent) => e.id === 'e2' ? <span data-testid="mark">S1713</span> : null
    fold({ renderBill, positionLabel: 'association position' })
    await userEvent.click(toggle())
    expect(screen.getAllByTestId('mark')).toHaveLength(1)
    expect(within(screen.getAllByRole('note')[1]).getByTestId('mark')).toBeInTheDocument()
    expect(screen.getAllByRole('note')[1]).toHaveTextContent('set the association position to Support')
  })
})

describe('ThreadLineView', () => {
  const grouping: GroupingEvent = { id: 'g', type: 'grouped', createdAt: '2026-10-11 12:00:00', actorName: 'Ada', with: [{ billId: 'b1713', billNumber: 'S1713' }], commentBills: [], replaced: [] }

  it('draws a grouping line as the grouping line, a change as an activity line, and a run as a fold', () => {
    render(<>
      <ThreadLineView line={{ kind: 'grouping', key: 'g', event: grouping }} />
      <ThreadLineView line={{ kind: 'change', key: 'e1', event: change('e1') }} />
      <ThreadLineView line={{ kind: 'fold', key: 'fold-e1', actorName: 'David Park', events: run }} />
    </>)
    const notes = screen.getAllByRole('note')
    expect(notes[0]).toHaveTextContent('link_2' + 'Ada grouped this bill with S1713 on October 11.')
    expect(notes[1]).toHaveTextContent('David Park changed priority from Medium to High')
    expect(screen.getByRole('button', { name: '3 changes by David Park' })).toBeInTheDocument()
  })
})
