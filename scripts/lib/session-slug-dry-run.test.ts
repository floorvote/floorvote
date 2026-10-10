import { describe, it, expect } from 'vitest'
import { dryRunSlugs, parseSessionRows } from './session-slug-dry-run'

describe('parseSessionRows', () => {
  it('reads CSV, skipping a header, with commas and quotes in names', () => {
    expect(parseSessionRows('session_id,state,session_name\n2154,RI,2026 Regular Session\n7,"US","Special, Joint ""A"""\n')).toEqual([
      { sessionId: 2154, state: 'RI', sessionName: '2026 Regular Session' },
      { sessionId: 7, state: 'US', sessionName: 'Special, Joint "A"' },
    ])
  })

  it("reads wrangler's d1 execute --json output", () => {
    const json = JSON.stringify([{ results: [{ session_id: 1000000026, state: 'DC', session_name: '2025-2026 Council Period 26', provider: 'lims', owner: 'lims' }], success: true }])
    expect(parseSessionRows(json)).toEqual([{ sessionId: 1000000026, state: 'DC', sessionName: '2025-2026 Council Period 26', provider: 'lims', owner: 'lims' }])
  })
})

describe('dryRunSlugs', () => {
  it('reports the sessions whose slug is taken, and what they would get', () => {
    const rows = parseSessionRows([
      '2200,MD,2026 Regular Session',
      '2201,MD,2026 Special Session',
      '2202,MD,2026 1st Extraordinary Session',
      '2154,RI,2026 Regular Session',
      '2155,RI,2026 1st Special Session',
    ].join('\n'))
    expect(dryRunSlugs(rows).map(c => [c.sessionId, c.wanted, c.slug])).toEqual([[2201, '2026', '2026-2'], [2202, '2026', '2026-3']])
  })

  it("gives the owner's session the plain slug, ahead of an older one", () => {
    const collisions = dryRunSlugs([
      { sessionId: 2050, state: 'DC', sessionName: '2025-2026 Council Period 26', provider: 'legiscan', owner: 'lims' },
      { sessionId: 1000000026, state: 'DC', sessionName: '2025-2026 Council Period 26', provider: 'lims', owner: 'lims' },
    ])
    expect(collisions.map(c => [c.sessionId, c.slug])).toEqual([[2050, 'cp26-2']])
  })
})
