import { describe, it, expect } from 'vitest'
import { detectChanges, type BillSnapshot, detectCalendarChanges, calendarIdentityKey, type PriorCalendarRow, calendarBlockFromRows, type StoredCalendarRow } from '../../src/lib/detect-changes'
import type { LegiscanBill, LegiscanCalendarEntry } from '../../src/lib/legiscan'

const baseSnapshot: BillSnapshot = {
  status: 1,
  title: 'An Act Relating to Elections',
  description: 'Relates to voter registration',
  latestHistoryCount: 3,
  textDocIds: new Set([101, 102]),
  supplementIds: new Set([201]),
  amendmentIds: new Set<number>(),
  voteIds: new Set([301]),
  sponsorKeys: new Set(['p1234']),
  sponsorDetailByKey: new Map([['p1234', 'Rep. Jane Smith (D)']]),
}

function baseBill(overrides: Partial<LegiscanBill> = {}): LegiscanBill {
  return {
    bill_id: 999,
    bill_number: 'A1',
    title: 'An Act Relating to Elections',
    description: 'Relates to voter registration',
    state: 'NJ',
    state_id: 30,
    change_hash: 'abc123',
    status: 1,
    status_date: '2026-01-01',
    bill_type: 'B',
    bill_type_id: '1',
    body: 'H',
    body_id: 1,
    current_body: 'H',
    current_body_id: 1,
    url: 'https://legiscan.com/NJ/bill/A1/2026',
    state_link: 'https://www.njleg.state.nj.us/Bills/2026/A0500/1_I1.HTM',
    pending_committee_id: 0,
    session_id: 2000,
    session: { session_id: 2000, session_name: 'NJ 2026-2027', year_start: 2026, year_end: 2027 },
    committee: null,
    referrals: [],
    progress: [],
    sponsors: [
      {
        people_id: 1234,
        name: 'Jane Smith',
        party: 'D',
        role: 'Rep.',
        role_id: 1,
        district: '5',
        sponsor_type_id: 1,
        sponsor_order: 1,
      },
    ],
    history: [
      { date: '2026-01-01', action: 'Introduced', chamber: 'H', chamber_id: 1, importance: 1 },
      { date: '2026-01-15', action: 'Referred to committee', chamber: 'H', chamber_id: 1, importance: 2 },
      { date: '2026-02-01', action: 'Committee hearing', chamber: 'H', chamber_id: 1, importance: 2 },
    ],
    sasts: [],
    subjects: [],
    votes: [
      {
        roll_call_id: 301,
        date: '2026-02-10',
        desc: 'Passed committee',
        yea: 5,
        nay: 2,
        nv: 0,
        absent: 0,
        total: 7,
        passed: 1,
        chamber: 'H',
        chamber_id: 1,
        url: 'https://legiscan.com/NJ/rollcall/2026/Y301',
        state_link: 'https://www.njleg.state.nj.us/votes/301',
      },
    ],
    texts: [
      {
        doc_id: 101,
        date: '2026-01-01',
        type: 'Introduced',
        type_id: 1,
        mime: 'text/html',
        mime_id: 1,
        url: 'https://legiscan.com/NJ/text/A1/2026',
        state_link: 'https://www.njleg.state.nj.us/Bills/2026/A0500/1_I1.HTM',
        text_size: 5000,
        text_hash: 'hash1',
        alt_bill_text: 0,
        alt_mime: '',
        alt_mime_id: 0,
        alt_state_link: '',
        alt_text_size: 0,
        alt_text_hash: '',
      },
      {
        doc_id: 102,
        date: '2026-01-20',
        type: 'Engrossed',
        type_id: 2,
        mime: 'text/html',
        mime_id: 1,
        url: 'https://legiscan.com/NJ/text/A1/2026/2',
        state_link: 'https://www.njleg.state.nj.us/Bills/2026/A0500/2_E1.HTM',
        text_size: 5200,
        text_hash: 'hash2',
        alt_bill_text: 0,
        alt_mime: '',
        alt_mime_id: 0,
        alt_state_link: '',
        alt_text_size: 0,
        alt_text_hash: '',
      },
    ],
    calendar: [],
    amendments: [],
    supplements: [
      {
        supplement_id: 201,
        date: '2026-01-10',
        type_id: 1,
        type: 'Fiscal Note',
        title: 'Fiscal Note for A1',
        description: 'Estimated cost: $1M',
        mime: 'application/pdf',
        url: 'https://legiscan.com/NJ/supplement/A1/2026',
        state_link: 'https://www.njleg.state.nj.us/Bills/2026/AR/1FN.HTM',
        supplement_size: 2000,
        supplement_hash: 'shash1',
      },
    ],
    ...overrides,
  }
}

describe('detectChanges', () => {
  it('returns empty array when nothing changed', () => {
    const changes = detectChanges(baseSnapshot, baseBill())
    expect(changes).toHaveLength(0)
  })

  it('detects status_change', () => {
    const changes = detectChanges(baseSnapshot, baseBill({ status: 4 }))
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('status_change')
    expect(changes[0].oldValue).toBe('Introduced')
    expect(changes[0].newValue).toBe('Passed')
  })

  it('detects title_changed', () => {
    const changes = detectChanges(baseSnapshot, baseBill({ title: 'An Act Relating to Voting Rights' }))
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('title_changed')
    expect(changes[0].oldValue).toBe('An Act Relating to Elections')
    expect(changes[0].newValue).toBe('An Act Relating to Voting Rights')
  })

  it('detects description_changed', () => {
    const changes = detectChanges(baseSnapshot, baseBill({ description: 'Relates to absentee ballots' }))
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('description_changed')
    expect(changes[0].oldValue).toBe('Relates to voter registration')
    expect(changes[0].newValue).toBe('Relates to absentee ballots')
  })

  it('detects action_added when a new history entry appears', () => {
    const billWithNewAction = baseBill({
      history: [
        { date: '2026-01-01', action: 'Introduced', chamber: 'H', chamber_id: 1, importance: 1 },
        { date: '2026-01-15', action: 'Referred to committee', chamber: 'H', chamber_id: 1, importance: 2 },
        { date: '2026-02-01', action: 'Committee hearing', chamber: 'H', chamber_id: 1, importance: 2 },
        { date: '2026-02-20', action: 'Passed committee', chamber: 'H', chamber_id: 1, importance: 1 },
      ],
    })
    const changes = detectChanges(baseSnapshot, billWithNewAction)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('action_added')
    expect(changes[0].newValue).toBe('Passed committee')
    expect(changes[0].detail).toBe('2026-02-20')
  })

  it('reports only the latest action when multiple new history entries arrive simultaneously', () => {
    // snapshot has seen 3 entries
    const snapshot = { ...baseSnapshot, latestHistoryCount: 3 }
    const bill = baseBill()
    // add two new entries beyond the snapshot count
    bill.history = [
      ...bill.history, // 3 existing entries
      { date: '2026-02-15', action: 'Committee Hearing', chamber: 'H', chamber_id: 1, importance: 1 },
      { date: '2026-02-20', action: 'Passed Committee', chamber: 'H', chamber_id: 1, importance: 2 },
    ]
    const changes = detectChanges(snapshot, bill)
    // Only one action_added record, for the latest entry
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('action_added')
    expect(changes[0].newValue).toBe('Passed Committee')
  })

  it('detects multiple change types in a single call', () => {
    const bill = baseBill({ status: 4 }) // status changed
    bill.texts = [
      ...bill.texts,
      {
        doc_id: 103,
        date: '2026-02-15',
        type: 'Enrolled',
        type_id: 3,
        mime: 'text/html',
        mime_id: 1,
        url: 'https://legiscan.com/NJ/text/A1/2026/3',
        state_link: 'https://www.njleg.state.nj.us/Bills/2026/A0500/3_P1.HTM',
        text_size: 5400,
        text_hash: 'hash3',
        alt_bill_text: 0,
        alt_mime: '',
        alt_mime_id: 0,
        alt_state_link: '',
        alt_text_size: 0,
        alt_text_hash: '',
      },
    ]
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes.length).toBeGreaterThanOrEqual(2)
    const types = changes.map(c => c.changeType)
    expect(types).toContain('status_change')
    expect(types).toContain('text_added')
  })

  it('detects text_added when a new doc_id appears', () => {
    const bill = baseBill()
    bill.texts = [
      ...bill.texts,
      {
        doc_id: 103,
        date: '2026-02-15',
        type: 'Enrolled',
        type_id: 3,
        mime: 'text/html',
        mime_id: 1,
        url: 'https://legiscan.com/NJ/text/A1/2026/3',
        state_link: 'https://www.njleg.state.nj.us/Bills/2026/A0500/3_P1.HTM',
        text_size: 5400,
        text_hash: 'hash3',
        alt_bill_text: 0,
        alt_mime: '',
        alt_mime_id: 0,
        alt_state_link: '',
        alt_text_size: 0,
        alt_text_hash: '',
      },
    ]
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('text_added')
    expect(changes[0].newValue).toBe('103')
  })

  it('detects amendment_added', () => {
    const bill = baseBill({
      amendments: [
        {
          amendment_id: 401,
          adopted: 0,
          chamber: 'H',
          date: '2026-02-10',
          title: 'Amendment 1',
          description: 'Strike section 2',
          mime: 'text/html',
          url: 'https://legiscan.com/NJ/amendment/401',
          state_link: 'https://www.njleg.state.nj.us/Bills/2026/A0500/A401.HTM',
          amendment_size: 1000,
          amendment_hash: 'ahash1',
        },
      ],
    })
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('amendment_added')
    expect(changes[0].newValue).toBe('401')
  })

  it('detects supplement_added when a new supplement_id appears', () => {
    const bill = baseBill()
    bill.supplements = [
      ...bill.supplements,
      {
        supplement_id: 202,
        date: '2026-02-05',
        type_id: 2,
        type: 'Statement',
        title: 'Statement for A1',
        description: 'Statement of purpose',
        mime: 'application/pdf',
        url: 'https://legiscan.com/NJ/supplement/A1/2026/2',
        state_link: 'https://www.njleg.state.nj.us/Bills/2026/AR/1ST.HTM',
        supplement_size: 1500,
        supplement_hash: 'shash2',
      },
    ]
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('supplement_added')
    expect(changes[0].newValue).toBe('202')
  })

  it('detects sponsor_added when a new sponsor appears', () => {
    const bill = baseBill()
    bill.sponsors = [
      ...bill.sponsors,
      {
        people_id: 5678,
        name: 'John Doe',
        party: 'R',
        role: 'Rep.',
        role_id: 1,
        district: '7',
        sponsor_type_id: 2,
        sponsor_order: 2,
      },
    ]
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('sponsor_added')
    expect(changes[0].newValue).toBe('Rep. John Doe (R)')
  })

  it('detects sponsor_removed when a sponsor disappears', () => {
    const bill = baseBill({ sponsors: [] })
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('sponsor_removed')
    expect(changes[0].oldValue).toBe('Rep. Jane Smith (D)')
  })

  it('detects vote_added when a new roll_call_id appears', () => {
    const bill = baseBill()
    bill.votes = [
      ...bill.votes,
      {
        roll_call_id: 302,
        date: '2026-02-25',
        desc: 'Passed full House',
        yea: 50,
        nay: 20,
        nv: 5,
        absent: 2,
        total: 77,
        passed: 1,
        chamber: 'H',
        chamber_id: 1,
        url: 'https://legiscan.com/NJ/rollcall/2026/Y302',
        state_link: 'https://www.njleg.state.nj.us/votes/302',
      },
    ]
    const changes = detectChanges(baseSnapshot, bill)
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('vote_added')
    expect(changes[0].newValue).toBe('302')
  })

  it('uses name fallback for sponsor key when people_id is 0', () => {
    const snapshotWithNameKey: BillSnapshot = {
      ...baseSnapshot,
      sponsorKeys: new Set(['nJane Smith']),
      sponsorDetailByKey: new Map([['nJane Smith', 'Rep. Jane Smith (D)']]),
    }
    const bill = baseBill({
      sponsors: [
        {
          people_id: 0,
          name: 'Jane Smith',
          party: 'D',
          role: 'Rep.',
          role_id: 1,
          district: '5',
          sponsor_type_id: 1,
          sponsor_order: 1,
        },
      ],
    })
    const changes = detectChanges(snapshotWithNameKey, bill)
    expect(changes).toHaveLength(0)
  })

  it('does not emit status_change when snapshot.status is null', () => {
    const snapshotNoStatus: BillSnapshot = { ...baseSnapshot, status: null }
    const changes = detectChanges(snapshotNoStatus, baseBill({ status: 4 }))
    const statusChanges = changes.filter((c) => c.changeType === 'status_change')
    expect(statusChanges).toHaveLength(0)
  })
})

function cal(overrides: Partial<LegiscanCalendarEntry> = {}): LegiscanCalendarEntry {
  return {
    type_id: 1, type: 'Hearing', date: '2026-06-04', time: '14:00:00',
    location: 'Room 35', description: 'House Cmte on Elections', event_hash: 'h1',
    ...overrides,
  }
}

describe('detectCalendarChanges', () => {
  it('normalizes whitespace and case in identity key', () => {
    const k1 = calendarIdentityKey({ type_id: 1, description: 'House  Cmte on Elections', date: '2026-06-04' })
    const k2 = calendarIdentityKey({ type_id: 1, description: 'house cmte on elections', date: '2026-06-04' })
    expect(k1).toBe(k2)
  })

  it('returns empty when prior and incoming match by identity + hash', () => {
    const prior: PriorCalendarRow[] = [{ identityKey: calendarIdentityKey(cal()), eventHash: 'h1', date: '2026-06-04', description: 'House Cmte on Elections' }]
    expect(detectCalendarChanges(prior, [cal()])).toEqual([])
  })

  it('detects a newly added hearing', () => {
    const changes = detectCalendarChanges([], [cal()])
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('hearing_added')
    expect(changes[0].date).toBe('2026-06-04')
    expect(changes[0].description).toBe('House Cmte on Elections')
  })

  it('detects a changed hearing when event_hash differs under same identity (reschedule)', () => {
    const prior: PriorCalendarRow[] = [{ identityKey: calendarIdentityKey(cal()), eventHash: 'h1', date: '2026-06-04', description: 'House Cmte on Elections' }]
    const moved = cal({ date: '2026-06-05', time: '10:00:00', event_hash: 'h2' })
    const changes = detectCalendarChanges(prior, [moved])
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('hearing_changed')
    expect(changes[0].date).toBe('2026-06-05')
  })

  it('handles multiple hearings: one unchanged, one rescheduled', () => {
    const a = cal({ type_id: 1, description: 'House Cmte on Elections', event_hash: 'a1' })
    const b = cal({ type_id: 2, description: 'Senate Judiciary', event_hash: 'b1' })
    const prior: PriorCalendarRow[] = [
      { identityKey: calendarIdentityKey(a), eventHash: 'a1', date: a.date, description: a.description },
      { identityKey: calendarIdentityKey(b), eventHash: 'b1', date: b.date, description: b.description },
    ]
    const bMoved = cal({ type_id: 2, description: 'Senate Judiciary', date: '2026-06-06', event_hash: 'b2' })
    const changes = detectCalendarChanges(prior, [a, bMoved])
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('hearing_changed')
    expect(changes[0].description).toBe('Senate Judiciary')
  })

  it('detects a cancelled hearing and carries prior date/description', () => {
    const prior: PriorCalendarRow[] = [{ identityKey: calendarIdentityKey(cal()), eventHash: 'h1', date: '2026-06-04', description: 'House Cmte on Elections' }]
    const changes = detectCalendarChanges(prior, [])
    expect(changes).toHaveLength(1)
    expect(changes[0].changeType).toBe('hearing_cancelled')
    expect(changes[0].date).toBe('2026-06-04')
    expect(changes[0].description).toBe('House Cmte on Elections')
  })

  it('falls back to date for identity when description is blank', () => {
    const k = calendarIdentityKey({ type_id: 2, description: '', date: '2026-07-01' })
    expect(k).toBe('2|date:2026-07-01')
  })

  it('treats type_id 0 and null identically (matches storage convention)', () => {
    const k0 = calendarIdentityKey({ type_id: 0, description: 'Floor Session', date: '2026-06-04' })
    const kNull = calendarIdentityKey({ type_id: null, description: 'Floor Session', date: '2026-06-04' })
    expect(k0).toBe(kNull)
    expect(k0).toBe('x|floor session')
  })
})

describe('calendarBlockFromRows', () => {
  it('maps stored rows to events-only block with identity keys', () => {
    const rows: StoredCalendarRow[] = [
      { typeId: 1, description: 'House Cmte on Elections', date: '2026-06-04', time: '14:00:00', location: 'Room 35', eventHash: 'h1' },
    ]
    const block = calendarBlockFromRows(rows)
    expect(block.changes).toEqual([])
    expect(block.events).toHaveLength(1)
    expect(block.events[0].identityKey).toBe('1|house cmte on elections')
    expect(block.events[0].date).toBe('2026-06-04')
    expect(block.events[0].eventHash).toBe('h1')
  })

  it('returns empty events for no rows', () => {
    expect(calendarBlockFromRows([])).toEqual({ events: [], changes: [] })
  })
})
