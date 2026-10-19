import { describe, it, expect } from 'vitest'
import { resolveTeamValues, type TeamValueRows } from '../../src/lib/teamFields'

// A group's analysis (team summary and tags) is its lead bill's: the bill furthest
// along, then the one with the newest text, then the lowest bill number, then the
// smallest id (lib/groupLead.ts), tracked or not. It changes only when the lead
// changes or is analyzed again. While the lead has no analysis, the group reads
// the one it read before leads (teamFieldsTrackedAnalysis.test.ts). Invented bills.

type Bill = TeamValueRows['bills'][number]

function bill(id: string, over: Partial<Bill> = {}): Bill {
  return {
    id, billNumber: id.toUpperCase(), statusRank: 100, newestTextDate: null, matchType: 'keyword',
    priority: null, prioritySetAt: null, tenantSummary: null, tags: '[]', aiProcessedAt: null, triagedAt: null, triagedBy: null,
    ...over,
  }
}

const analyzed = (id: string, at: string, over: Partial<Bill> = {}) =>
  bill(id, { aiProcessedAt: at, tenantSummary: `${id} summary`, tags: JSON.stringify([id]), ...over })

function analysisOf(...members: Bill[]) {
  return resolveTeamValues({ bills: members, positions: [], customFields: [] }, new Set(members.map(m => m.id))).analysis
}

describe("a group shows its lead bill's analysis", () => {
  it('is the lead\'s, though another member was analyzed later', () => {
    expect(analysisOf(
      analyzed('hb10', '2026-09-05 00:00:00', { newestTextDate: '2026-01-01' }),
      analyzed('sb20', '2026-09-01 00:00:00', { newestTextDate: '2026-04-01' }),
    )).toMatchObject({ billId: 'sb20', tenantSummary: 'sb20 summary', tags: ['sb20'], aiProcessedAt: '2026-09-01 00:00:00' })
  })

  it('is the bill furthest along, over one with a newer text', () => {
    expect(analysisOf(
      analyzed('hb10', '2026-09-01 00:00:00', { statusRank: 300, newestTextDate: '2026-01-01' }),
      analyzed('sb20', '2026-09-05 00:00:00', { newestTextDate: '2026-04-01' }),
    )?.billId).toBe('hb10')
  })

  it('is the lower bill number when status and newest text tie', () => {
    expect(analysisOf(
      analyzed('sb20', '2026-09-05 00:00:00', { newestTextDate: '2026-04-01' }),
      analyzed('hb10', '2026-09-01 00:00:00', { newestTextDate: '2026-04-01' }),
    )?.billId).toBe('hb10')
  })

  it('is an untracked lead\'s over a tracked member\'s', () => {
    expect(analysisOf(
      analyzed('hb10', '2026-09-05 00:00:00'),
      analyzed('sb20', '2026-09-01 00:00:00', { matchType: null, statusRank: 200 }),
    )?.billId).toBe('sb20')
  })

  it('counts a lead with only tags, or only a summary, as analyzed', () => {
    expect(analysisOf(analyzed('hb10', '2026-09-05 00:00:00'), bill('sb20', { statusRank: 200, tags: '["x"]' }))?.billId).toBe('sb20')
    expect(analysisOf(analyzed('hb10', '2026-09-05 00:00:00'), bill('sb20', { statusRank: 200, tenantSummary: 's' }))?.billId).toBe('sb20')
  })

  it("falls back to another member's while the lead has none", () => {
    expect(analysisOf(
      bill('sb20', { statusRank: 300 }),
      analyzed('hb10', '2026-09-01 00:00:00'),
    )?.billId).toBe('hb10')
  })

  it('picks the lead among the members only', () => {
    const rows: TeamValueRows = {
      bills: [analyzed('hb10', '2026-09-01 00:00:00'), analyzed('sb20', '2026-09-05 00:00:00', { statusRank: 900 })],
      positions: [], customFields: [],
    }
    expect(resolveTeamValues(rows, new Set(['hb10'])).analysis?.billId).toBe('hb10')
  })
})
