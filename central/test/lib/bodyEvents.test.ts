import { describe, it, expect } from 'vitest'
import { bodyEventMonths, bodyEventUid, planBodyEventPulls, type BodyEventPull, type BodyEventRow } from '../../src/lib/bodyEvents'
import { getProvider, type BodyEvent } from '../../src/providers'

// The body-event planner on its own: what one sync's pulls do to a provider's
// stored events in a state. The main-seam test (test/cron/body-events.test.ts)
// drives the same rules through the Council's calendar and what instances get.

const lims = getProvider('lims')
const NOW = '2026-09-28 12:00:00'
const OCTOBER = { from: '2026-10-01', to: '2026-10-31' }

function event(o: Partial<BodyEvent> = {}): BodyEvent {
  return {
    event_id: '1', kind: 'hearing', type: 'Hearing', date: '2026-10-14', time: '10:00', timezone: 'America/New_York',
    committee: null, joint_with: null, location: 'Room 412', title: 'Health hearing', agenda: [], url: null, event_hash: 'h1', ...o,
  }
}

/** The rows a sync's pulls write, as stored rows. */
function rows(values: ReturnType<typeof planBodyEventPulls>): BodyEventRow[] {
  return values.map((v, i) => ({
    id: i + 1, createdAt: NOW, type: null, time: null, timezone: null, committeeId: null, committee: null, jointWith: null,
    location: null, agendaJson: '[]', url: null, missedPulls: 0, cancelledAt: null, ...v,
  } as BodyEventRow))
}

const pull = (events: BodyEvent[], range = OCTOBER): BodyEventPull => ({ ...range, events })
const plan = (prior: BodyEventRow[], ...pulls: BodyEventPull[]) => planBodyEventPulls(lims, 'DC', prior, pulls, NOW)

describe('body events', () => {
  it('are stored under the provider\'s event id, and an unchanged listing writes nothing', () => {
    const first = rows(plan([], pull([event(), event({ event_id: '2', date: '2026-10-20' })])))
    expect(first.map(r => [r.eventId, r.kind, r.date, r.missedPulls, r.cancelledAt])).toEqual([
      ['1', 'hearing', '2026-10-14', 0, null],
      ['2', 'hearing', '2026-10-20', 0, null],
    ])
    expect(plan(first, pull([event(), event({ event_id: '2', date: '2026-10-20' })]))).toEqual([])
    // A move is the same event, changed.
    expect(plan(first, pull([event({ date: '2026-10-15', event_hash: 'h2' }), event({ event_id: '2', date: '2026-10-20' })])))
      .toEqual([expect.objectContaining({ eventId: '1', date: '2026-10-15', eventHash: 'h2' })])
  })

  it('cancel at once on positive evidence, and an event never stored has nothing to cancel', () => {
    const stored = rows(plan([], pull([event()])))
    expect(plan(stored, pull([event({ cancelled: true })]))).toEqual([expect.objectContaining({ eventId: '1', cancelledAt: NOW })])
    expect(plan([], pull([event({ cancelled: true })]))).toEqual([])
    // Listed twice, the cancellation wins.
    expect(plan(stored, pull([event({ cancelled: true }), event()]))).toEqual([expect.objectContaining({ cancelledAt: NOW })])
  })

  it('cancel after two pulls in a row that leave them out, and come back when listed again', () => {
    const stored = rows(plan([], pull([event(), event({ event_id: '2' })])))
    const once = rows(plan(stored, pull([event({ event_id: '2' })])))
    expect(once).toEqual([expect.objectContaining({ eventId: '1', missedPulls: 1, cancelledAt: null })])
    const twice = plan([...once, stored[1]], pull([event({ event_id: '2' })]))
    expect(twice).toEqual([expect.objectContaining({ eventId: '1', missedPulls: 2, cancelledAt: NOW })])
    expect(plan(rows(twice), pull([event()]))).toEqual([expect.objectContaining({ eventId: '1', missedPulls: 0, cancelledAt: null })])
  })

  it('count nothing missing from a pull with no live event, or from a month nobody pulled', () => {
    const stored = rows(plan([], pull([event()])))
    // Only a cancellation of another event, or nothing at all.
    expect(plan(stored, pull([event({ event_id: '9', cancelled: true })]))).toEqual([])
    expect(plan(stored, pull([]))).toEqual([])
    // November listed something, but the event is in October: a date passing never cancels anything.
    expect(plan(stored, pull([event({ event_id: '3', date: '2026-11-02' })], { from: '2026-11-01', to: '2026-11-30' })))
      .toEqual([expect.objectContaining({ eventId: '3' })])
  })

  it('are read last month through three months ahead, across a year\'s end', () => {
    expect(bodyEventMonths('2026-11-15')).toEqual([
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-11-01', to: '2026-11-30' },
      { from: '2026-12-01', to: '2026-12-31' },
      { from: '2027-01-01', to: '2027-01-31' },
      { from: '2027-02-01', to: '2027-02-28' },
    ])
  })

  it('get a UID from the provider and event id, or the provider\'s own scheme', () => {
    expect(bodyEventUid(getProvider('mga'), 'House/HGO 2026-02-03')).toBe('body-mga-House%2FHGO%202026-02-03@floorvote.org')
    expect(bodyEventUid(lims, '2408')).toBe('council-2408@lims.dccouncil.gov')
  })
})
