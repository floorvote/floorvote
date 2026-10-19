import { describe, it, expect } from 'vitest'
import { resolveTeamValues, type TeamValueRows } from '../../src/lib/teamFields'

// A group's analysis (team summary and tags) is its lead bill's
// (teamFieldsLeadAnalysis.test.ts). While the lead has no analysis yet, it comes
// from a bill the team tracks (#554): among the members with an analysis, those
// that match on their own (a match type, keyword or manual) come first, and the
// most recent of them is the group's. Only a group with no tracked analysis
// falls back to the most recent of any member, such as a pulled companion's.
// Every group below has such a lead. The other team fields keep the
// most-recent rule.

type Bill = TeamValueRows['bills'][number]

function bill(id: string, over: Partial<Bill> = {}): Bill {
  return {
    id,
    billNumber: id.toUpperCase(),
    statusRank: 100,
    newestTextDate: null,
    matchType: 'keyword',
    priority: null,
    prioritySetAt: null,
    tenantSummary: null,
    tags: '[]',
    aiProcessedAt: null,
    triagedAt: null,
    triagedBy: null,
    ...over,
  }
}

function analyzed(id: string, at: string | null, matchType: Bill['matchType'], tags: string[] = [id]): Bill {
  return bill(id, { matchType, aiProcessedAt: at, tenantSummary: `${id} summary`, tags: JSON.stringify(tags) })
}

// The group's lead: furthest along, with no analysis yet.
const LEAD = bill('lead', { statusRank: 900 })

function analysisOf(...members: Bill[]) {
  const rows: TeamValueRows = { bills: [LEAD, ...members], positions: [], customFields: [] }
  return resolveTeamValues(rows, new Set([LEAD, ...members].map(m => m.id)))
}

describe('while its lead has no analysis, a group shows its tracked bill\'s', () => {
  it('keeps the tracked bill\'s analysis over a newer one of a pulled companion', () => {
    const v = analysisOf(
      analyzed('a190', '2026-09-01 00:00:00', 'keyword', ['Labor']),
      analyzed('b1713', '2026-09-05 00:00:00', null, ['Energy']),
    )
    expect(v.analysis).toMatchObject({ billId: 'a190', tenantSummary: 'a190 summary', tags: ['Labor'], aiProcessedAt: '2026-09-01 00:00:00' })
  })

  it('counts a manual add as tracked', () => {
    const v = analysisOf(
      analyzed('a190', '2026-09-01 00:00:00', 'manual'),
      analyzed('b1713', '2026-09-05 00:00:00', null),
    )
    expect(v.analysis?.billId).toBe('a190')
  })

  it('takes the most recent of two tracked analyses', () => {
    const v = analysisOf(
      analyzed('a190', '2026-09-01 00:00:00', 'keyword'),
      analyzed('b1713', '2026-09-03 00:00:00', 'manual'),
      analyzed('c9', '2026-09-09 00:00:00', null),
    )
    expect(v.analysis?.billId).toBe('b1713')
  })

  it('breaks a tie between tracked analyses by the larger bill id', () => {
    const v = analysisOf(
      analyzed('b1713', '2026-09-01 00:00:00', 'keyword'),
      analyzed('a190', '2026-09-01 00:00:00', 'keyword'),
      analyzed('c9', '2026-09-09 00:00:00', null),
    )
    expect(v.analysis?.billId).toBe('b1713')
  })

  it('breaks a tie between untracked analyses by the larger bill id, when none is tracked', () => {
    const v = analysisOf(
      analyzed('b1713', '2026-09-01 00:00:00', null),
      analyzed('a190', '2026-09-01 00:00:00', null),
    )
    expect(v.analysis?.billId).toBe('b1713')
  })

  it('falls back to the most recent of any member when no tracked member has an analysis', () => {
    const v = analysisOf(
      bill('a190', { matchType: 'keyword' }), // tracked, never analyzed
      analyzed('b1713', '2026-09-01 00:00:00', null),
      analyzed('c9', '2026-09-03 00:00:00', null),
    )
    expect(v.analysis?.billId).toBe('c9')
  })

  it('reads no analysis for a group with none', () => {
    expect(analysisOf(bill('a190'), bill('b1713', { matchType: null })).analysis).toBeNull()
  })

  it('takes a tracked analysis with no time over a timed untracked one', () => {
    // An analysis is a time, a team summary, or tags. One with no time is the oldest among the tracked.
    const v = analysisOf(
      bill('a190', { matchType: 'keyword', tenantSummary: 'a190 summary' }),
      analyzed('b1713', '2026-09-01 00:00:00', null),
    )
    expect(v.analysis).toMatchObject({ billId: 'a190', tenantSummary: 'a190 summary', aiProcessedAt: null })
  })

  it('takes a tracked analysis with only tags over a newer untracked one', () => {
    const v = analysisOf(
      bill('a190', { matchType: 'keyword', tags: '["Labor"]' }),
      analyzed('b1713', '2026-09-01 00:00:00', null, ['Energy']),
    )
    expect(v.analysis).toMatchObject({ billId: 'a190', tags: ['Labor'] })
  })

  it('reads a bill in no group\'s own analysis, tracked or not', () => {
    const own = (b: Bill) => resolveTeamValues({ bills: [b], positions: [], customFields: [] }, new Set([b.id])).analysis?.billId
    expect(own(analyzed('solo', '2026-09-01 00:00:00', null))).toBe('solo')
    expect(own(analyzed('solo', '2026-09-01 00:00:00', 'keyword'))).toBe('solo')
  })

  it('makes a companion eligible once it matches on its own', () => {
    const tracked = analyzed('a190', '2026-09-01 00:00:00', 'keyword')
    expect(analysisOf(tracked, analyzed('b1713', '2026-09-05 00:00:00', null)).analysis?.billId).toBe('a190')
    expect(analysisOf(tracked, analyzed('b1713', '2026-09-05 00:00:00', 'keyword')).analysis?.billId).toBe('b1713')
  })

  it('ignores a non-member\'s tracked analysis', () => {
    const rows: TeamValueRows = {
      bills: [analyzed('a190', '2026-09-01 00:00:00', 'keyword'), analyzed('b1713', '2026-09-05 00:00:00', null)],
      positions: [],
      customFields: [],
    }
    expect(resolveTeamValues(rows, new Set(['b1713'])).analysis?.billId).toBe('b1713')
  })
})

describe('the other team fields keep the most-recent rule', () => {
  it('takes a priority set on a pulled companion over an older one on the tracked bill', () => {
    const v = analysisOf(
      bill('a190', { matchType: 'keyword', priority: 'low', prioritySetAt: '2026-09-01 00:00:00' }),
      bill('b1713', { matchType: null, priority: 'high', prioritySetAt: '2026-09-05 00:00:00' }),
    )
    expect(v.priority).toMatchObject({ billId: 'b1713', priority: 'high' })
  })

  it('takes a triage on a pulled companion over an older one on the tracked bill', () => {
    const v = analysisOf(
      bill('a190', { matchType: 'keyword', triagedAt: '2026-09-01 00:00:00', triagedBy: 'u1' }),
      bill('b1713', { matchType: null, triagedAt: '2026-09-05 00:00:00', triagedBy: 'u2' }),
    )
    expect(v.triaged).toMatchObject({ billId: 'b1713', triagedBy: 'u2' })
  })

  it('takes a position and a custom field set on a pulled companion over older ones on the tracked bill', () => {
    const rows: TeamValueRows = {
      bills: [bill('a190', { matchType: 'keyword' }), bill('b1713', { matchType: null })],
      positions: [
        { billId: 'a190', position: 'Support', setBy: 'u1', updatedAt: '2026-09-01 00:00:00' },
        { billId: 'b1713', position: 'Oppose', setBy: 'u1', updatedAt: '2026-09-05 00:00:00' },
      ],
      customFields: [
        { billId: 'a190', fieldId: 'cf1', value: 'x', setBy: 'u1', updatedAt: '2026-09-01 00:00:00' },
        { billId: 'b1713', fieldId: 'cf1', value: 'y', setBy: 'u1', updatedAt: '2026-09-05 00:00:00' },
      ],
    }
    const v = resolveTeamValues(rows, new Set(['a190', 'b1713']))
    expect(v.position).toMatchObject({ billId: 'b1713', position: 'Oppose' })
    expect(v.customFields.get('cf1')).toMatchObject({ billId: 'b1713', value: 'y' })
  })
})
