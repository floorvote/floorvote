import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  legacyCalendarKey, planCalendarPull, planCalendarRecheck, calendarBlockEvents, type CalendarRow,
} from '../../src/lib/billCalendar'
import { getProvider, type MeasureCalendarEntry, type Provider } from '../../src/providers'

// The calendar planner on its own: what one pull or recheck does to a bill's
// stored calendar rows. The main-seam tests (test/cron/calendar-identity.test.ts)
// drive the same rules through a sync and the bill API.

const legiscan = getProvider('legiscan')
const lims = getProvider('lims')
const NOW = '2026-06-05 12:00:00'
const BILL = 9001

function entry(o: Partial<MeasureCalendarEntry> = {}): MeasureCalendarEntry {
  return {
    type_id: 1, type: 'Hearing', date: '2026-06-10', time: '10:00', location: 'Room 100',
    description: 'House Cmte on Elections', event_hash: 'h1', ...o,
  }
}

/** The rows a first pull of `entries` writes. */
function stored(provider: Provider, entries: MeasureCalendarEntry[]): CalendarRow[] {
  return planCalendarPull(provider, BILL, [], entries, 'pull-0', NOW).writes
}

/** A row as the ingest wrote it before identities were stored. */
function legacyRow(o: Partial<CalendarRow>): CalendarRow {
  return {
    id: crypto.randomUUID(), billId: BILL, typeId: 1, type: 'Hearing', date: '2026-06-10', time: null, location: null,
    description: 'House Cmte on Elections', eventHash: 'h1', eventId: null, identityKey: null,
    missedPulls: 0, missedHash: null, cancelledAt: null, ...o,
  }
}

const kinds = (plan: { changes: { changeType: string }[] }) => plan.changes.map(c => c.changeType)

afterEach(() => vi.restoreAllMocks())

describe('LegiScan\'s identity', () => {
  it('is the type id and description, as it always was, so subscribers\' calendar UIDs never change', () => {
    expect(legacyCalendarKey({ typeId: 1, description: 'House  Cmte on Elections ', date: '2026-06-04' })).toBe('1|house cmte on elections')
    expect(legacyCalendarKey({ typeId: 2, description: '', date: '2026-07-01' })).toBe('2|date:2026-07-01')
    expect(legacyCalendarKey({ typeId: 0, description: 'Floor Session', date: null })).toBe('x|floor session')
    expect(legacyCalendarKey({ typeId: null, description: 'Floor Session', date: null })).toBe('x|floor session')
    expect(calendarBlockEvents(legiscan, stored(legiscan, [entry()])).map(e => e.identityKey)).toEqual(['1|house cmte on elections'])
  })

  it('keeps a row for each LegiScan entry that shares an identity, and sends instances one', () => {
    // Two hearings before the same committee: one identity, one calendar UID, as always.
    const twice = [entry({ date: '2026-06-10' }), entry({ date: '2026-06-17', event_hash: 'h2' })]
    const rows = stored(legiscan, twice)
    expect(rows.map(r => r.date).sort()).toEqual(['2026-06-10', '2026-06-17'])
    expect(calendarBlockEvents(legiscan, rows).map(e => [e.identityKey, e.date])).toEqual([['1|house cmte on elections', '2026-06-17']])
    // Listed again, both rows are kept as they are.
    expect(planCalendarPull(legiscan, BILL, rows, twice, 'pull-1', NOW).writes).toEqual([])
    // Once the later one goes, the earlier one is what instances see, as a change, not a cancellation.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const first = planCalendarPull(legiscan, BILL, rows, [twice[0]], 'pull-1', NOW)
    const second = planCalendarPull(legiscan, BILL, merge(rows, first.writes), [twice[0]], 'pull-2', NOW)
    expect(kinds(second)).toEqual(['hearing_changed'])
    expect(calendarBlockEvents(legiscan, second.live).map(e => e.date)).toEqual(['2026-06-10'])
  })

  it('reads a moved LegiScan hearing as changed, not cancelled and added', () => {
    const prior = stored(legiscan, [entry()])
    const plan = planCalendarPull(legiscan, BILL, prior, [entry({ date: '2026-06-12', event_hash: 'h2' })], 'pull-1', NOW)
    expect(kinds(plan)).toEqual(['hearing_changed'])
    expect(plan.live.map(r => [r.date, r.identityKey])).toEqual([['2026-06-12', '1|house cmte on elections']])
  })
})

describe('the shared identity', () => {
  it('is the kind, date, and description, so same-text entries on different days are two entries', () => {
    const rows = stored(lims, [
      entry({ description: 'Public Hearing on B26-0400', date: '2026-06-10' }),
      entry({ description: 'Public Hearing on B26-0400', date: '2026-06-20' }),
    ])
    expect(rows.map(r => r.identityKey).sort()).toEqual([
      'hearing|2026-06-10|public hearing on b26-0400',
      'hearing|2026-06-20|public hearing on b26-0400',
    ])
  })

  it('is the provider\'s event id when it has one, so a moved event is the same entry', () => {
    const withIds: Provider = { ...lims, id: 'with-ids' }
    const prior = stored(withIds, [entry({ event_id: 'E-77' })])
    expect(prior.map(r => r.identityKey)).toEqual(['id:E-77'])
    const plan = planCalendarPull(withIds, BILL, prior, [entry({ event_id: 'E-77', date: '2026-06-11', description: 'Moved', event_hash: 'h2' })], 'pull-1', NOW)
    expect(kinds(plan)).toEqual(['hearing_changed'])
    expect(plan.live.map(r => [r.identityKey, r.date])).toEqual([['id:E-77', '2026-06-11']])
  })

  it('keeps the identity a row written before identities were stored was sent under, ordinal and all', () => {
    const prior = [
      legacyRow({ description: 'Public Hearing on B26-0400', date: '2026-06-10' }),
      legacyRow({ description: 'Public Hearing on B26-0400 (2)', date: '2026-06-20' }),
    ]
    const plan = planCalendarPull(lims, BILL, prior, [
      entry({ description: 'Public Hearing on B26-0400', date: '2026-06-10' }),
      entry({ description: 'Public Hearing on B26-0400', date: '2026-06-20' }),
    ], 'pull-1', NOW)
    expect(plan.live.map(r => [r.date, r.identityKey, r.description])).toEqual([
      ['2026-06-10', '1|public hearing on b26-0400', 'Public Hearing on B26-0400'],
      ['2026-06-20', '1|public hearing on b26-0400 (2)', 'Public Hearing on B26-0400'],
    ])
    expect(plan.changes.filter(c => c.changeType !== 'hearing_changed')).toEqual([])
  })
})

describe('cancellation', () => {
  it('waits for two successful pulls in a row to cancel a missing entry', () => {
    const prior = stored(legiscan, [entry(), entry({ type_id: 3, description: 'Markup' })])
    const first = planCalendarPull(legiscan, BILL, prior, [entry()], 'pull-1', NOW)
    expect(first.changes).toEqual([])
    expect(first.live).toHaveLength(2)

    const second = planCalendarPull(legiscan, BILL, merge(prior, first.writes), [entry()], 'pull-2', NOW)
    expect(second.changes.map(c => [c.changeType, c.description])).toEqual([['hearing_cancelled', 'Markup']])
    expect(second.live.map(r => r.description)).toEqual(['House Cmte on Elections'])
    // Kept, not deleted.
    expect(second.writes.find(r => r.description === 'Markup')?.cancelledAt).toBe(NOW)
  })

  it('counts a pull of the same record once, however often it is ingested', () => {
    const prior = stored(legiscan, [entry(), entry({ type_id: 3, description: 'Markup' })])
    const first = planCalendarPull(legiscan, BILL, prior, [entry()], 'pull-1', NOW)
    // The same message retried, or the bill re-ingested at the same hash.
    const retried = planCalendarPull(legiscan, BILL, merge(prior, first.writes), [entry()], 'pull-1', NOW)
    expect(retried.writes).toEqual([])
    expect(retried.live).toHaveLength(2)
  })

  it('counts a recheck of the same record as the second pull', () => {
    const prior = stored(legiscan, [entry(), entry({ type_id: 3, description: 'Markup' })])
    const first = planCalendarPull(legiscan, BILL, prior, [entry()], 'pull-1', NOW)
    const rows = merge(prior, first.writes)
    expect(planCalendarRecheck(legiscan, rows, 'pull-0', NOW).writes).toEqual([])
    const recheck = planCalendarRecheck(legiscan, rows, 'pull-1', NOW)
    expect(kinds(recheck)).toEqual(['hearing_cancelled'])
  })

  it('resets the count when the entry comes back', () => {
    const prior = stored(legiscan, [entry(), entry({ type_id: 3, description: 'Markup' })])
    const first = planCalendarPull(legiscan, BILL, prior, [entry()], 'pull-1', NOW)
    const back = planCalendarPull(legiscan, BILL, merge(prior, first.writes), [entry(), entry({ type_id: 3, description: 'Markup' })], 'pull-2', NOW)
    const third = planCalendarPull(legiscan, BILL, merge(merge(prior, first.writes), back.writes), [entry()], 'pull-3', NOW)
    expect(third.changes).toEqual([])
  })

  it('never counts a pull with no entries at all', () => {
    const prior = stored(legiscan, [entry()])
    for (const hash of ['pull-1', 'pull-2', 'pull-3']) {
      const plan = planCalendarPull(legiscan, BILL, prior, [], hash, NOW)
      expect(plan.writes).toEqual([])
      expect(plan.live).toHaveLength(1)
    }
  })

  it('cancels at once on positive evidence', () => {
    const prior = stored(lims, [entry({ description: 'Public Hearing on B26-0769' })])
    const plan = planCalendarPull(lims, BILL, prior, [entry({ description: 'Public Hearing on B26-0769', cancelled: true })], 'pull-1', NOW)
    expect(kinds(plan)).toEqual(['hearing_cancelled'])
    expect(plan.live).toEqual([])
  })

  it('counts nothing missing from a pull that lists only cancellations', () => {
    const prior = stored(lims, [entry({ description: 'Public Hearing on B26-0769' }), entry({ type_id: 3, description: 'Committee Mark-up of B26-0769' })])
    for (const hash of ['pull-1', 'pull-2']) {
      const plan = planCalendarPull(lims, BILL, prior, [entry({ description: 'Public Hearing on B26-0769', cancelled: true })], hash, NOW)
      expect(plan.live.map(r => r.description)).toEqual(['Committee Mark-up of B26-0769'])
      expect(plan.writes.every(r => r.missedPulls === 0)).toBe(true)
    }
  })

  it('never cancels on a date passing, and cancels a past entry quietly', () => {
    const past = entry({ date: '2026-05-01' })
    const prior = stored(legiscan, [past, entry({ type_id: 3, description: 'Markup' })])
    const kept = planCalendarPull(legiscan, BILL, prior, [past, entry({ type_id: 3, description: 'Markup' })], 'pull-1', NOW)
    expect(kept.writes).toEqual([])
    const first = planCalendarPull(legiscan, BILL, prior, [entry({ type_id: 3, description: 'Markup' })], 'pull-1', NOW)
    const second = planCalendarPull(legiscan, BILL, merge(prior, first.writes), [entry({ type_id: 3, description: 'Markup' })], 'pull-2', NOW)
    expect(second.changes).toEqual([])
    expect(second.live.map(r => r.description)).toEqual(['Markup'])
  })

  it('brings a cancelled entry back under its identity', () => {
    const prior = stored(lims, [entry({ description: 'Public Hearing on B26-0769' })])
    const cancelled = planCalendarPull(lims, BILL, prior, [entry({ description: 'Public Hearing on B26-0769', cancelled: true })], 'pull-1', NOW)
    const back = planCalendarPull(lims, BILL, merge(prior, cancelled.writes), [entry({ description: 'Public Hearing on B26-0769' })], 'pull-2', NOW)
    expect(kinds(back)).toEqual(['hearing_added'])
    expect(back.live.map(r => r.id)).toEqual(prior.map(r => r.id))
  })
})

describe('changes', () => {
  it('reports a changed future entry, but not a changed past one', () => {
    const prior = stored(legiscan, [entry({ date: '2026-12-01' }), entry({ type_id: 2, description: 'Approps', date: '2026-04-27' })])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const plan = planCalendarPull(legiscan, BILL, prior, [
      entry({ date: '2026-12-01', event_hash: 'h2' }),
      entry({ type_id: 2, description: 'Approps', date: '2026-04-27', event_hash: 'h2' }),
    ], 'pull-1', NOW)
    expect(plan.changes.map(c => [c.changeType, c.date])).toEqual([['hearing_changed', '2026-12-01']])
  })

  it('reports an added entry even when it is in the past', () => {
    const plan = planCalendarPull(legiscan, BILL, stored(legiscan, [entry()]), [entry(), entry({ type_id: 3, description: 'Back-dated', date: '2026-02-01' })], 'pull-1', NOW)
    expect(kinds(plan)).toEqual(['hearing_added'])
  })

  it('logs each changed entry, with what moved', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const prior = stored(legiscan, [entry({ time: '09:00', location: 'Room 1' })])
    planCalendarPull(legiscan, BILL, prior, [entry({ time: '10:00', location: 'Room 2', event_hash: 'h2' })], 'pull-1', NOW)
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain('[calendar-change]')
    expect(logged).toContain('"oldHash":"h1"')
    expect(logged).toContain('"newHash":"h2"')
  })

  it('names each entry\'s kind from the vocabulary', () => {
    const rows = stored(legiscan, [entry(), entry({ type_id: 2, description: 'Exec' }), entry({ type_id: 3, description: 'Markup' })])
    expect(calendarBlockEvents(legiscan, rows).map(e => e.kind).sort()).toEqual(['hearing', 'markup', 'markup'])
    expect(calendarBlockEvents(lims, stored(lims, [entry({ type_id: 10, description: 'Mayor\'s response due' })])).map(e => e.kind)).toEqual(['deadline'])
  })
})

/** `rows` with `writes` applied. */
function merge(rows: CalendarRow[], writes: CalendarRow[]): CalendarRow[] {
  const byId = new Map(rows.map(r => [r.id, r]))
  for (const w of writes) byId.set(w.id, w)
  return [...byId.values()]
}
