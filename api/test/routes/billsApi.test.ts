import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env, createExecutionContext } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { inArray, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { getDb } from '../../src/db/client'
import { memberVotes, officialPositions, comments, notes, calendarEvents, associationConfig } from '../../src/db/schema'
import { app } from '../../src/index'
import { DEMO_BILL_COMMENT_CAP } from '../../src/routes/billsApi/engagementRoutes'

describe('GET /bills', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    await seedBill({ billNumber: 'HB 1', title: 'Election Act', priority: 'high', status: 'In Committee' })
    await seedBill({ billNumber: 'SB 2', title: 'Voter ID Act', priority: 'low', status: 'Passed House' })
  })

  it('returns 401 without session', async () => {
    const res = await SELF.fetch('http://localhost/api/bills')
    expect(res.status).toBe(401)
  })

  it('returns all bills with vote counts', async () => {
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: unknown[]; pagination: { total: number } }
    expect(body.bills).toHaveLength(2)
    const first = body.bills[0] as Record<string, unknown>
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('billNumber')
    expect(first).toHaveProperty('voteCounts')
    expect(first).toHaveProperty('tags')
    expect(Array.isArray(first.tags)).toBe(true)
  })

  it('filters by priority', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?priority=high', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[]; pagination: { total: number } }
    expect(body.bills).toHaveLength(1)
    expect((body.bills[0] as Record<string, unknown>).billNumber).toBe('HB 1')
  })

  it('filters by status', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?status=Passed+House', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[]; pagination: { total: number } }
    expect(body.bills).toHaveLength(1)
    expect((body.bills[0] as Record<string, unknown>).billNumber).toBe('SB 2')
  })

  it('filters by text search (q)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?q=Voter', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[]; pagination: { total: number } }
    expect(body.bills).toHaveLength(1)
    expect((body.bills[0] as Record<string, unknown>).billNumber).toBe('SB 2')
  })

  it('searches by bill number with space (q="HB 1")', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?q=HB+1', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[] }
    expect(body.bills).toHaveLength(1)
    expect((body.bills[0] as Record<string, unknown>).billNumber).toBe('HB 1')
  })

  it('searches by bare bill number (q="1")', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?q=1', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[] }
    const billNumbers = (body.bills as Record<string, unknown>[]).map(b => b.billNumber)
    expect(billNumbers).toContain('HB 1')
  })

  it('searches by compact bill number without space (q="HB1")', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?q=HB1', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[] }
    expect(body.bills).toHaveLength(1)
    expect((body.bills[0] as Record<string, unknown>).billNumber).toBe('HB 1')
  })

  it('filters by year', async () => {
    await seedBill({ billNumber: 'NJ1', session: '2026-2027 Regular Session', sessionId: '2250', yearStart: 2026, yearEnd: 2027 })
    await seedBill({ billNumber: 'RI1', session: '2025 Regular Session', sessionId: '2193', yearStart: 2025, yearEnd: 2025 })
    const res = await SELF.fetch('http://localhost/api/bills?year=2026', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: { billNumber: string }[] }
    const numbers = body.bills.map(b => b.billNumber)
    expect(numbers).toContain('NJ1')
    expect(numbers).not.toContain('RI1')
  })

  it('returns yearStart and yearEnd in bill rows', async () => {
    await seedBill({ billNumber: 'DC1', session: '26th Council', sessionId: '2198', yearStart: 2025, yearEnd: 2026 })
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: { billNumber: string; yearStart: number | null; yearEnd: number | null }[] }
    const dc = body.bills.find(b => b.billNumber === 'DC1')!
    expect(dc.yearStart).toBe(2025)
    expect(dc.yearEnd).toBe(2026)
  })

  it('default sort puts higher year_start first', async () => {
    await seedBill({ billNumber: 'OLD', session: '2024 Regular Session', sessionId: '2128', yearStart: 2024, yearEnd: 2024 })
    await seedBill({ billNumber: 'NEW', session: '2026 Regular Session', sessionId: '2253', yearStart: 2026, yearEnd: 2026 })
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: { billNumber: string }[] }
    const numbers = body.bills.map(b => b.billNumber)
    expect(numbers.indexOf('NEW')).toBeLessThan(numbers.indexOf('OLD'))
  })

  it('default sort ranks an active tracked bill above an active stub with a lower session_id', async () => {
    // Reproduces the S282 case: a keyword-tracked bill in an active session (NJ, higher
    // session_id, relevance 10) should outrank an untracked stub in another active session
    // (UT, lower session_id, no relevance). The old session_id grouping wrongly buried it.
    const cy = new Date().getUTCFullYear()
    await seedBill({ billNumber: 'STUB', state: 'UT', session: `${cy} General Session`, sessionId: '2214', yearStart: cy, yearEnd: cy })
    await seedBill({ billNumber: 'TRACKED', state: 'NJ', session: `${cy}-${cy + 1} Regular Session`, sessionId: '2250', yearStart: cy, yearEnd: cy + 1, relevanceScore: 10 })
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const numbers = (await res.json() as { bills: { billNumber: string }[] }).bills.map(b => b.billNumber)
    expect(numbers.indexOf('TRACKED')).toBeLessThan(numbers.indexOf('STUB'))
  })

  it('default sort treats active sessions as tied so relevance, not year_end, orders them', async () => {
    // Two active sessions: a later-ending one with low relevance must NOT jump ahead of a
    // current-year one with high relevance. Active sessions are a tied bucket.
    const cy = new Date().getUTCFullYear()
    await seedBill({ billNumber: 'FUTURE', sessionId: '2200', yearStart: cy, yearEnd: cy + 1, relevanceScore: 1 })
    await seedBill({ billNumber: 'CURRENT', sessionId: '2300', yearStart: cy, yearEnd: cy, relevanceScore: 9 })
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const numbers = (await res.json() as { bills: { billNumber: string }[] }).bills.map(b => b.billNumber)
    expect(numbers.indexOf('CURRENT')).toBeLessThan(numbers.indexOf('FUTURE'))
  })

  it('explicit Year ascending orders by year_end (oldest first)', async () => {
    const cy = new Date().getUTCFullYear()
    await seedBill({ billNumber: 'ENDS_LATER', sessionId: '2200', yearStart: cy, yearEnd: cy + 1 })
    await seedBill({ billNumber: 'ENDS_NOW', sessionId: '2300', yearStart: cy, yearEnd: cy })
    const res = await SELF.fetch('http://localhost/api/bills?sort=year&dir=asc', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const numbers = (await res.json() as { bills: { billNumber: string }[] }).bills.map(b => b.billNumber)
    expect(numbers.indexOf('ENDS_NOW')).toBeLessThan(numbers.indexOf('ENDS_LATER'))
  })

  it('orders fully-tied bills deterministically by id', async () => {
    const cy = new Date().getUTCFullYear()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(await seedBill({ billNumber: `TIE${i}`, sessionId: '2250', yearStart: cy, yearEnd: cy }))
    }
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: { id: string; billNumber: string }[] }
    const tied = body.bills.filter(b => b.billNumber.startsWith('TIE')).map(b => b.id)
    expect(tied).toEqual([...ids].sort())
  })

  it('includes commentCount per bill', async () => {
    const db = getDb(env.DB)
    // Get seeded bill ids
    const allBills = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const allBillsBody = await allBills.json() as { bills: Array<Record<string, unknown>> }
    const firstBillId = allBillsBody.bills.find((b) => b.billNumber === 'HB 1')!.id as string

    await db.insert(comments).values({
      id: crypto.randomUUID(),
      billId: firstBillId,
      userId: (await seedUser()),
      content: 'Test comment',
      createdAt: new Date().toISOString(),
    })

    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: Array<Record<string, unknown>> }
    const hb1 = body.bills.find((b) => b.billNumber === 'HB 1')!
    const sb2 = body.bills.find((b) => b.billNumber === 'SB 2')!
    expect(hb1.commentCount).toBe(1)
    expect(sb2.commentCount).toBe(0)
  })
})

describe('GET /bills — comma multi-search', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    await seedBill({ billNumber: 'H 7377', title: 'Mail Ballot Modernization Act' })
    await seedBill({ billNumber: 'H 7358', title: 'Voting Rights Act of Rhode Island' })
    await seedBill({ billNumber: 'H 8334', title: 'Voting Rights Act Implementation' })
    await seedBill({ billNumber: 'S 5042', title: 'Absentee, Ballot Act' })
    await seedBill({ billNumber: 'S 5043', title: 'Ballot Act' })
  })

  // Returns sorted bill numbers for a search query.
  async function search(q: string): Promise<string[]> {
    const res = await SELF.fetch(`http://localhost/api/bills?q=${encodeURIComponent(q)}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: { billNumber: string }[] }
    return body.bills.map(b => b.billNumber).sort()
  }

  it('comma ORs two bare numbers (7377,7358)', async () => {
    expect(await search('7377,7358')).toEqual(['H 7358', 'H 7377'])
  })

  it('comma ORs bare + compact number (7377, H7358)', async () => {
    expect(await search('7377, H7358')).toEqual(['H 7358', 'H 7377'])
  })

  it('comma ORs bare + spaced number (7377, H 7358)', async () => {
    expect(await search('7377, H 7358')).toEqual(['H 7358', 'H 7377'])
  })

  it('comma ORs a text search with a number (voting rights act,7377)', async () => {
    expect(await search('voting rights act,7377')).toEqual(['H 7358', 'H 7377', 'H 8334'])
  })

  it('composes quoted phrase AND token ("voting rights act" 8334)', async () => {
    expect(await search('"voting rights act" 8334')).toEqual(['H 8334'])
  })

  it('does not split on commas inside a quoted phrase', async () => {
    expect(await search('"absentee, ballot"')).toEqual(['S 5042'])
  })

  it('degrades an unbalanced quote to a token search', async () => {
    expect(await search('"voting rights')).toEqual(['H 7358', 'H 8334'])
  })

  it('drops empty segments (7377,)', async () => {
    expect(await search('7377,')).toEqual(['H 7377'])
  })

  it('treats a bare comma as no filter', async () => {
    expect(await search(',')).toEqual(['H 7358', 'H 7377', 'H 8334', 'S 5042', 'S 5043'])
  })

  it('composes with the state filter on multi-state data', async () => {
    await seedBill({ billNumber: 'H 7377', title: 'Utah Mail Ballots', state: 'UT' })
    const res = await SELF.fetch(`http://localhost/api/bills?q=7377&state=UT`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: { billNumber: string; state: string }[] }
    expect(body.bills).toHaveLength(1)
    expect(body.bills[0].state).toBe('UT')
  })

  it('caps segments instead of erroring on absurd comma counts', async () => {
    const q = Array.from({ length: 200 }, (_, i) => String(9000 + i)).join(',')
    const res = await SELF.fetch(`http://localhost/api/bills?q=${encodeURIComponent(q)}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('GET /bills — long search terms (D1 LIKE 50-byte limit)', () => {
  let token: string
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const uid = await seedUser()
    token = await seedSession(uid)
    await seedBill({ billNumber: 'HB 1', title: 'Election administration and voter registration procedures act', tenantSummary: 'A bill about elections' })
    await seedBill({ billNumber: 'SB 2', title: 'Unrelated transportation act' })
  })
  const get = (q: string) =>
    SELF.fetch(`http://localhost/api/bills?q=${encodeURIComponent(q)}`, { headers: { Cookie: `session=${token}` } })

  it('does not 500 on a single over-long token', async () => {
    expect((await get('a'.repeat(60))).status).toBe(200)
  })
  it('does not 500 on a long quoted phrase', async () => {
    expect((await get('"an act relating to election administration and voter registration"')).status).toBe(200)
  })
  it('does not 500 on a long multi-word query and still matches by token', async () => {
    const res = await get('election administration and voter registration procedures act')
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills.map(b => b.billNumber)).toContain('HB 1')
  })
  it('matches on the truncated prefix of an over-long token', async () => {
    await seedBill({ billNumber: 'HB 3', title: 'zz electionadministrationandvoterregistrationproceduresandmore zz' })
    const res = await get('electionadministrationandvoterregistrationproceduresandmore') // 59 chars, no spaces
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills.map(b => b.billNumber)).toContain('HB 3')
  })
  it('does not 500 on a many-word unquoted query (D1 100-bound-param limit)', async () => {
    // Each token emits ~3 LIKE bound params; ~34+ tokens would blow D1's 100-var
    // cap ("too many SQL variables"). A long pasted phrase is one segment, many tokens.
    const q = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ')
    expect((await get(q)).status).toBe(200)
  })
})

describe('GET /bills — monitoring-only bills are visible to all roles', () => {
  let memberToken: string
  let adminToken: string
  let stubBillId: string
  let normalBillId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser({ role: 'member' })
    memberToken = await seedSession(memberId)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminToken = await seedSession(adminId)
    normalBillId = await seedBill({ billNumber: 'HB 1', title: 'Normal Bill' })
    stubBillId = await seedBill({ billNumber: 'HB 2', title: 'Stub Bill', matchType: null })
  })

  it('list includes both tracked and monitoring-only bills by default', async () => {
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: Array<Record<string, unknown>> }
    expect(body.bills).toHaveLength(2)
    expect(body.bills.find(b => b.id === stubBillId)).toBeDefined()
    expect(body.bills.find(b => b.id === normalBillId)).toBeDefined()
  })

  it('detail returns monitoring-only bill for members', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${stubBillId}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.matchType).toBeNull()
  })

  it('detail returns monitoring-only bill for admins', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${stubBillId}`, {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.matchType).toBeNull()
  })
})

describe('GET /bills — tag filter', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    // Bill with Elections tag only
    await seedBill({ billNumber: 'HB 10', title: 'Election Security Act', tags: ['Elections'], status: 'In Committee' })
    // Bill with Budget tag only
    await seedBill({ billNumber: 'SB 20', title: 'Budget Appropriations Act', tags: ['Budget'], status: 'In Committee' })
    // Bill with both Elections and Budget tags
    await seedBill({ billNumber: 'HB 30', title: 'Election Finance Reform', tags: ['Elections', 'Budget'], status: 'In Committee' })
    // Bill with no tags
    await seedBill({ billNumber: 'SB 40', title: 'Unrelated Act', tags: [], status: 'In Committee' })
  })

  it('returns only bills whose tags include the requested tag', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?tag=Elections', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string; tags: string[] }> }
    const billNumbers = body.bills.map((b) => b.billNumber)
    expect(billNumbers).toContain('HB 10')
    expect(billNumbers).toContain('HB 30')
    expect(billNumbers).not.toContain('SB 20')
    expect(billNumbers).not.toContain('SB 40')
  })

  it('returns bills matching either tag with OR semantics (?tag=A&tag=B)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?tag=Elections&tag=Budget', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    const billNumbers = body.bills.map((b) => b.billNumber)
    expect(billNumbers).toContain('HB 10')  // Elections
    expect(billNumbers).toContain('SB 20')  // Budget
    expect(billNumbers).toContain('HB 30')  // Both
    expect(billNumbers).not.toContain('SB 40')  // Neither
  })

  it('combines ?tag= with ?status= (AND semantics across filter types)', async () => {
    // Seed a bill tagged Elections but with a different status
    await seedBill({ billNumber: 'HB 50', title: 'Another Election Bill', tags: ['Elections'], status: 'Passed House' })

    const res = await SELF.fetch('http://localhost/api/bills?tag=Elections&status=In+Committee', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string; status: string }> }
    const billNumbers = body.bills.map((b) => b.billNumber)
    // HB 10 has Elections tag and default status 'In Committee'
    expect(billNumbers).toContain('HB 10')
    // HB 30 has Elections tag and default status 'In Committee'
    expect(billNumbers).toContain('HB 30')
    // HB 50 has Elections tag but 'Passed House' status, should be excluded
    expect(billNumbers).not.toContain('HB 50')
    // SB 20 has Budget tag only, should be excluded
    expect(billNumbers).not.toContain('SB 20')
    // Every returned bill must have status 'In Committee'
    for (const b of body.bills) {
      expect(b.status).toBe('In Committee')
    }
  })
})

describe('GET /bills/:id', () => {
  let memberId: string
  let memberToken: string
  let adminId: string
  let adminToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser({ role: 'member', name: 'Alice' })
    memberToken = await seedSession(memberId)
    adminId = await seedUser({ role: 'admin', name: 'Admin' })
    adminToken = await seedSession(adminId)
    billId = await seedBill({ billNumber: 'HB 1', title: 'Election Act', tags: ['Elections & Voting', 'Criminal Justice & Public Safety'] })
    const db = getDb(env.DB)
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(),
      userId: memberId,
      billId,
      position: 'support',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await db.insert(officialPositions).values({
      id: crypto.randomUUID(),
      billId,
      position: 'Support',
      setBy: adminId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    await db.insert(comments).values({
      id: crypto.randomUUID(),
      billId,
      userId: memberId,
      content: 'Important bill.',
      createdAt: new Date().toISOString(),
    })
  })

  it('returns 404 for unknown id', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/nonexistent', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(404)
  })

  it('returns composite bill detail for member', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.billNumber).toBe('HB 1')
    expect(Array.isArray(body.tags)).toBe(true)
    expect((body.tags as string[])).toContain('Elections & Voting')
    expect(body.myVote).toBe('support')
    expect((body.position as Record<string, unknown>)?.position).toBe('Support')
    expect((body.voteCounts as Record<string, number>).support).toBe(1)
    expect(body.memberVotes).toBeUndefined() // members don't see individual votes
    expect(Array.isArray(body.comments)).toBe(true)
  })

  it('includes memberVotes breakdown for admin', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}`, {
      headers: { Cookie: `session=${adminToken}` },
    })
    const body = await res.json() as Record<string, unknown>
    expect(Array.isArray(body.memberVotes)).toBe(true)
    expect((body.memberVotes as unknown[])).toHaveLength(1)
  })

  it('returns comments in chronological order (oldest first)', async () => {
    const db = getDb(env.DB)
    const userId = await seedUser()
    await db.insert(comments).values({
      id: 'comment-1',
      billId,
      userId,
      content: 'First comment',
      createdAt: '2026-01-01T10:00:00.000Z',
    })
    await db.insert(comments).values({
      id: 'comment-2',
      billId,
      userId,
      content: 'Second comment',
      createdAt: '2026-01-02T10:00:00.000Z',
    })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as Record<string, unknown>
    const cmts = body.comments as Array<{ content: string }>
    const idx1 = cmts.findIndex((c) => c.content === 'First comment')
    const idx2 = cmts.findIndex((c) => c.content === 'Second comment')
    expect(idx1).toBeLessThan(idx2)
  })

  it('memberVotes includes userEmail and userName is empty when user has no name', async () => {
    const db = getDb(env.DB)
    const noNameId = await seedUser({ role: 'member', name: '', email: 'noname@example.com' })
    const noNameToken = await seedSession(noNameId)
    // Cast the vote via the API so the vote is recorded
    await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${noNameToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'oppose' }),
    })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}`, {
      headers: { Cookie: `session=${adminToken}` },
    })
    const body = await res.json() as Record<string, unknown>
    const votes = body.memberVotes as Array<{ userName: string; userEmail: string; position: string }>
    const noNameVote = votes.find((v) => v.userEmail === 'noname@example.com')
    expect(noNameVote).toBeDefined()
    expect(noNameVote!.userEmail).toBe('noname@example.com')
    expect(noNameVote!.userName).toBe('')
  })

  it('includes texts, calendar, amendments, supplements in GET /bills/:id', async () => {
    const userId = await seedUser({ role: 'member' })
    const token = await seedSession(userId)
    const billId = await seedBill({ externalId: '100' })
    await seedBillText(billId, { docId: '999', type: 'Introduced', date: '2025-01-01' })
    await seedBillText(billId, { docId: '1001', type: 'Amended', date: '2025-03-01' })

    const res = await SELF.fetch(`http://localhost/api/bills/${billId}`, {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect((body.texts as unknown[]).length).toBe(2)
    expect(Array.isArray(body.calendar)).toBe(true)
    expect(Array.isArray(body.amendments)).toBe(true)
    expect(Array.isArray(body.supplements)).toBe(true)
  })

  it('GET /bills/:id/text/:docId proxies to central', async () => {
    const userId = await seedUser({ role: 'member' })
    const token = await seedSession(userId)
    const billId = await seedBill({ externalId: '100' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>bill text</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    ))

    const res = await app.request(`/api/bills/${billId}/text/999`, {
      headers: { Cookie: `session=${token}` },
    }, { ...env })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  it('overrides calendar with seeded hearing events in DEMO_MODE', async () => {
    const db = getDb(env.DB)
    const userId = await seedUser({ role: 'member' })
    const token = await seedSession(userId)
    const demoBillId = await seedBill({ externalId: 'legiscan:777', billNumber: 'A777', title: 'Demo Act', priority: 'high' })
    const hearingDate = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10)
    await db.insert(calendarEvents).values([
      { id: 'ce-h', uid: 'ce-h@test', billId: demoBillId, source: 'hearing', sequence: 0,
        date: hearingDate, time: '10:00:00', location: 'Room 11', description: 'Committee hearing', status: 'confirmed', eventHash: 'ehh' },
      { id: 'ce-c', uid: 'ce-c@test', billId: demoBillId, source: 'custom', sequence: 0,
        date: hearingDate, time: null, location: null, description: 'Custom deadline', status: 'confirmed', eventHash: null },
    ])

    const res = await app.request(`/api/bills/${demoBillId}`,
      { headers: { Cookie: `session=${token}` } },
      { ...env, DEMO_MODE: 'true' })
    expect(res.status).toBe(200)
    const body = await res.json() as { calendar: Array<{ date: string; description: string; type: string }> }
    expect(body.calendar).toHaveLength(1)
    expect(body.calendar[0].date).toBe(hearingDate)
    expect(body.calendar[0].description).toBe('Committee hearing')
    expect(body.calendar[0].type).toBe('Hearing')
  })
})

describe('POST /bills/:id/votes', () => {
  let memberId: string
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    billId = await seedBill()
  })

  it('creates a vote', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.position).toBe('support')
  })

  it('updates an existing vote', async () => {
    await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'oppose' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.position).toBe('oppose')
  })

  it('rejects invalid position', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'maybe' }),
    })
    expect(res.status).toBe(400)
  })

  it('SEC-C1: returns 404 for non-existent bill', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/non-existent-id/votes', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'support' }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /bills/:id/votes', () => {
  let memberId: string
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    memberId = await seedUser()
    memberToken = await seedSession(memberId)
    billId = await seedBill()
    await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'neutral' }),
    })
  })

  it('removes vote and returns 204', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'DELETE',
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(204)
  })
})

describe('PATCH /bills/:id/priority (admin only)', () => {
  let adminToken: string
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ role: 'member' })
    memberToken = await seedSession(memberId)
    billId = await seedBill()
  })

  it('returns 403 for member', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect(res.status).toBe(403)
  })

  it('sets priority for admin', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.priority).toBe('high')
  })

  it('writes a priority_set feed event when priority is set', async () => {
    await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    const db = getDb(env.DB)
    const { feedEvents: fe } = await import('../../src/db/schema')
    const events = await db.select().from(fe).all()
    expect(events.some((e) => e.type === 'priority_set' && e.billId === billId)).toBe(true)
  })

  it('does not write a feed event when priority is cleared', async () => {
    await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: null }),
    })
    const db = getDb(env.DB)
    const { feedEvents: fe } = await import('../../src/db/schema')
    const events = await db.select().from(fe).all()
    expect(events.some((e) => e.type === 'priority_set')).toBe(false)
  })

  it('clears priority when null passed', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: null }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as Record<string, unknown>).priority).toBeNull()
  })

  it('returns 400 when priority key is absent', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('PATCH /bills/:id/priority — promotion to full analysis', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    // central promote + calendar backfill both go through global fetch in tests
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, matchType: 'manual' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    ))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  function promoteCalled() {
    return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(call => String(call[0]).includes('/tenants/promote-bill/'))
  }

  it('promotes a null-match LegiScan stub and returns promoted:true', async () => {
    const billId = await seedBill({ externalId: 'legiscan:9001', matchType: null })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { promoted: boolean }).promoted).toBe(true)
    expect(promoteCalled()).toBe(true)
  })

  it('does not promote an already-tracked bill', async () => {
    const billId = await seedBill({ externalId: 'legiscan:9002', matchType: 'manual' })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect((await res.json() as { promoted: boolean }).promoted).toBe(false)
    expect(promoteCalled()).toBe(false)
  })

  it('does not promote a non-LegiScan bill', async () => {
    const billId = await seedBill({ externalId: 'ocd-bill/abc', matchType: null })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect((await res.json() as { promoted: boolean }).promoted).toBe(false)
    expect(promoteCalled()).toBe(false)
  })

  it('does not promote when clearing priority', async () => {
    const billId = await seedBill({ externalId: 'legiscan:9003', matchType: null })
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: null }),
    })
    expect((await res.json() as { promoted: boolean }).promoted).toBe(false)
    expect(promoteCalled()).toBe(false)
  })
})

describe('POST /bills/:id/position (admin only)', () => {
  let adminId: string
  let adminToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    billId = await seedBill()
  })

  it('sets position and writes feed event', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Support' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.position).toBe('Support')
    // Verify feed event was written
    const db = getDb(env.DB)
    const { feedEvents: fe } = await import('../../src/db/schema')
    const events = await db.select().from(fe).all()
    expect(events.some((e) => e.type === 'position_set' && e.billId === billId)).toBe(true)
  })

  it('SEC-C1: returns 404 for non-existent bill', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/non-existent-id/position', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'Support' }),
    })
    expect(res.status).toBe(404)
  })

  it('SEC-I5: returns 400 for invalid position vocabulary', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'BOGUS' }),
    })
    expect(res.status).toBe(400)
  })

  it('SEC-I5: accepts all valid position values', async () => {
    const validPositions = ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position']
    for (const position of validPositions) {
      const res = await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
        method: 'POST',
        headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position }),
      })
      expect(res.status).toBe(200)
    }
  })
})

describe('DELETE /bills/:id/position (admin only)', () => {
  let adminToken: string
  let memberToken: string
  let billId: string
  let adminId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ role: 'member' })
    memberToken = await seedSession(memberId)
    billId = await seedBill()
    const db = getDb(env.DB)
    await db.insert(officialPositions).values({
      id: crypto.randomUUID(),
      billId,
      position: 'Support',
      setBy: adminId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  })

  it('clears the official position', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
      method: 'DELETE',
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(204)
    const detail = await SELF.fetch(`http://localhost/api/bills/${billId}`, {
      headers: { Cookie: `session=${adminToken}` },
    })
    const body = await detail.json() as Record<string, unknown>
    expect(body.position).toBeNull()
  })

  it('returns 403 for non-admin', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
      method: 'DELETE',
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('returns 204 even when no position exists (idempotent)', async () => {
    const emptyBillId = await seedBill({ billNumber: 'HB 99' })
    const res = await SELF.fetch(`http://localhost/api/bills/${emptyBillId}/position`, {
      method: 'DELETE',
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(204)
  })

  it('returns 404 for non-existent bill', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/non-existent-id/position', {
      method: 'DELETE',
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(404)
  })

  it('suppresses position_set feed events when position is cleared', async () => {
    const db = getDb(env.DB)
    const { feedEvents: fe } = await import('../../src/db/schema')
    await db.insert(fe).values({
      id: crypto.randomUUID(),
      type: 'position_set',
      billId,
      userId: adminId,
      metadata: '{}',
    })

    await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
      method: 'DELETE',
      headers: { Cookie: `session=${adminToken}` },
    })

    const events = await db.select().from(fe).all()
    expect(events.every((e) => e.suppressed)).toBe(true)
  })
})

describe('POST /bills/:id/comments', () => {
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    billId = await seedBill()
  })

  it('creates a comment', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Great bill!' }),
    })
    expect(res.status).toBe(201)
  })

  it('SEC-C1: returns 404 for non-existent bill', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/non-existent-id/comments', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    })
    expect(res.status).toBe(404)
  })

  it('SEC-I4: accepts content at exactly 10 KB boundary', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(10_240) }),
    })
    expect(res.status).toBe(201)
  })

  it('SEC-I4: returns 400 when content exceeds 10 KB', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(10_241) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /bills/:id/comments — demo per-bill cap', () => {
  let cookie: string
  let billId: string
  let userId: string
  const demoEnv = { ...env, DEMO_MODE: 'true' }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser()
    cookie = `session=${await seedSession(userId)}`
    billId = await seedBill()
  })

  // Bulk-insert in chunks — one statement for all 60 rows blows D1's SQL
  // variable limit, and 60 single-row inserts is needless work.
  async function seedComments(n: number, opts?: { deleted?: number }) {
    const db = getDb(env.DB)
    const deleted = opts?.deleted ?? 0
    const rows = Array.from({ length: n }, (_, i) => ({
      id: crypto.randomUUID(),
      billId,
      userId,
      content: `<p>seeded ${i}</p>`,
      createdAt: new Date().toISOString(),
      deletedAt: i < deleted ? new Date().toISOString() : null,
    }))
    for (let i = 0; i < rows.length; i += 15) {
      await db.insert(comments).values(rows.slice(i, i + 15))
    }
  }

  const post = (testEnv: typeof env) =>
    app.request(`/api/bills/${billId}/comments`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'one more' }),
    }, testEnv, createExecutionContext())

  it('accepts a comment below the cap', async () => {
    await seedComments(DEMO_BILL_COMMENT_CAP - 1)
    const res = await post(demoEnv)
    expect(res.status).toBe(201)
  })

  it('refuses a comment once the bill is at the cap — 403, not 429', async () => {
    // 403, because waiting does not clear it: the bill stays full until the next
    // reset. 429 would promise a retry that never comes. The per-IP limiter is
    // the opposite case and stays 429.
    await seedComments(DEMO_BILL_COMMENT_CAP)
    const res = await post(demoEnv)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toMatch(/comment limit/i)
  })

  it('counts only live comments — deleted ones do not hold the cap shut', async () => {
    await seedComments(DEMO_BILL_COMMENT_CAP, { deleted: 1 })
    const res = await post(demoEnv)
    expect(res.status).toBe(201)
  })

  it('does not apply the cap when DEMO_MODE is unset', async () => {
    await seedComments(DEMO_BILL_COMMENT_CAP)
    const res = await post(env)
    expect(res.status).toBe(201)
  })
})

describe('GET /bills — pagination', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    // Seed 5 bills
    for (let i = 1; i <= 5; i++) {
      await seedBill({ billNumber: `HB ${i}`, title: `Bill ${i}`, status: i % 2 === 0 ? 'in_committee' : 'introduced' })
    }
  })

  it('returns paginated response with pagination object', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?pageSize=2&page=1', {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: unknown[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }
    expect(Array.isArray(body.bills)).toBe(true)
    expect(body.bills).toHaveLength(2)
    expect(body.pagination.total).toBe(5)
    expect(body.pagination.totalPages).toBe(3)
    expect(body.pagination.page).toBe(1)
    expect(body.pagination.pageSize).toBe(2)
  })

  it('returns next page correctly', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?pageSize=2&page=2', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[]; pagination: { page: number } }
    expect(body.bills).toHaveLength(2)
    expect(body.pagination.page).toBe(2)
  })

  it('filters by status via SQL', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?status=in_committee', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as { bills: unknown[]; pagination: { total: number } }
    expect(body.pagination.total).toBe(2)
    for (const b of body.bills as Array<Record<string, unknown>>) {
      expect(b.status).toBe('in_committee')
    }
  })

  it('response shape has both bills and pagination keys', async () => {
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${memberToken}` },
    })
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('bills')
    expect(body).toHaveProperty('pagination')
  })
})

describe('GET /bills — sort', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
    // Seed 3 bills with distinct sortable values
    await seedBill({ billNumber: 'AB 3', lastActionDate: '2025-02-01', relevanceScore: 5, session: '2024', sessionId: '2128', yearStart: 2024, yearEnd: 2024, priority: 'medium' })
    await seedBill({ billNumber: 'HB 1', lastActionDate: '2025-01-01', relevanceScore: 3, session: '2025', sessionId: '2193', yearStart: 2025, yearEnd: 2025, priority: 'low' })
    await seedBill({ billNumber: 'SB 2', lastActionDate: '2025-03-01', relevanceScore: 7, session: '2025', sessionId: '2193', yearStart: 2025, yearEnd: 2025, priority: 'high' })
  })

  it('sort=bill dir=asc returns bills in ascending bill number order', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?sort=bill&dir=asc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills.map(b => b.billNumber)).toEqual(['AB 3', 'HB 1', 'SB 2'])
  })

  it('sort=bill dir=desc returns bills in descending bill number order', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?sort=bill&dir=desc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills.map(b => b.billNumber)).toEqual(['SB 2', 'HB 1', 'AB 3'])
  })

  it('sort=bill orders numerically within a prefix ("HB 9" before "HB 10")', async () => {
    await seedBill({ billNumber: 'HB 10', state: 'RI' })
    await seedBill({ billNumber: 'HB 9', state: 'RI' })
    await seedBill({ billNumber: 'HB 100', state: 'RI' })
    const res = await SELF.fetch('http://localhost/api/bills?sort=bill&dir=asc&state=RI', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    const hbBills = body.bills.map(b => b.billNumber).filter(n => n.startsWith('HB'))
    expect(hbBills).toEqual(['HB 1', 'HB 9', 'HB 10', 'HB 100'])
  })

  it('sort=bill groups by state first, then bill prefix and number', async () => {
    await seedBill({ billNumber: 'SB 5', state: 'CA' })
    await seedBill({ billNumber: 'HB 2', state: 'CA' })
    const res = await SELF.fetch('http://localhost/api/bills?sort=bill&dir=asc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string; state: string }> }
    expect(body.bills.map(b => `${b.state} ${b.billNumber}`)).toEqual([
      'CA HB 2', 'CA SB 5', 'RI AB 3', 'RI HB 1', 'RI SB 2',
    ])
  })

  // Note: priority sort uses standard SQL ASC/DESC semantics over a CASE rank where
  // high=3, medium=2, low=1. So DESC = high→medium→low (most important first), and
  // ASC = low→medium→high. The UI's first-click default is dir=desc, which gives
  // users the most-important-first ordering they expect.
  it('sort=priority dir=desc returns high→medium→low (most important first)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?sort=priority&dir=desc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ priority: string }> }
    expect(body.bills.map(b => b.priority)).toEqual(['high', 'medium', 'low'])
  })

  it('sort=priority dir=asc returns low→medium→high', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?sort=priority&dir=asc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ priority: string }> }
    expect(body.bills.map(b => b.priority)).toEqual(['low', 'medium', 'high'])
  })

  it('sort=relevance dir=desc returns highest relevance first', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?sort=relevance&dir=desc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ relevanceScore: number }> }
    const scores = body.bills.map(b => b.relevanceScore)
    expect(scores[0]).toBe(7)
    expect(scores[2]).toBe(3)
  })

  // Position sort uses the same SQL ASC/DESC convention as priority: a CASE rank
  // where Support=5, …, No Position=1, null=0. DESC sorts bills with positions to
  // the top (matching the UI's first-click=desc behavior).
  it('sort=position dir=desc places bills with a position before those without', async () => {
    const db = getDb(env.DB)
    // Fetch bill IDs
    const listRes = await SELF.fetch('http://localhost/api/bills', { headers: { Cookie: `session=${token}` } })
    const { bills: allBills } = await listRes.json() as { bills: Array<{ id: string; billNumber: string }> }
    const hb1Id = allBills.find(b => b.billNumber === 'HB 1')!.id
    const adminId = await seedUser({ role: 'admin' })
    // Insert a position directly
    await db.insert(officialPositions).values({
      id: crypto.randomUUID(),
      billId: hb1Id,
      position: 'Support',
      setBy: adminId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const res = await SELF.fetch('http://localhost/api/bills?sort=position&dir=desc', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    // HB 1 has a position; it should sort first
    expect(body.bills[0].billNumber).toBe('HB 1')
    expect(body.bills.slice(1).map((b: { billNumber: string }) => b.billNumber).sort()).toEqual(['AB 3', 'SB 2'])
  })

  it('no sort param uses default multi-column order (year DESC, then priority, then relevance)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string; yearStart: number }> }
    // AB 3 is yearStart 2024; SB 2 and HB 1 are yearStart 2025 — 2025 bills come first
    expect(body.bills[0].yearStart).toBe(2025)
    expect(body.bills[2].yearStart).toBe(2024)
  })
})

describe('PUT /bills/:id/note', () => {
  let memberToken: string
  let billId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    billId = await seedBill()
  })

  it('saves a note', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'My note' }),
    })
    expect(res.status).toBe(200)
  })

  it('SEC-C1: returns 404 for non-existent bill', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/non-existent-id/note', {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello' }),
    })
    expect(res.status).toBe(404)
  })

  it('SEC-I4: accepts note at exactly 50 KB boundary', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(51_200) }),
    })
    expect(res.status).toBe(200)
  })

  it('SEC-I4: returns 400 when content exceeds 50 KB', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'a'.repeat(51_201) }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /bills — multi-value filters', () => {
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
    await seedBill({ billNumber: 'HB 1', status: 'In Committee', priority: 'high', session: '2025' })
    await seedBill({ billNumber: 'SB 2', status: 'Passed House', priority: 'low', session: '2024' })
    await seedBill({ billNumber: 'AB 3', status: 'Failed', priority: 'medium', session: '2025' })
  })

  it('filters by two statuses (OR)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?status=In+Committee&status=Passed+House', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills).toHaveLength(2)
    const nums = body.bills.map(b => b.billNumber).sort()
    expect(nums).toEqual(['HB 1', 'SB 2'])
  })

  it('filters by two priorities (OR)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?priority=high&priority=low', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills).toHaveLength(2)
    const nums = body.bills.map(b => b.billNumber).sort()
    expect(nums).toEqual(['HB 1', 'SB 2'])
  })

  it('filters by two sessions (OR)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills?session=2025&session=2024', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills).toHaveLength(3) // all bills match
  })
})

describe('GET /bills — tag filter with long tag names', () => {
  let token: string
  // Regression: the TX tenant surfaced a tag whose name is long enough that the
  // old `tags LIKE '%"<tag>"%'` filter produced a pattern over D1's 50-byte
  // LIKE-pattern limit, 500ing both the list and facets. A tag ≥47 chars trips it.
  const LONG_TAG = 'County Election Officials & Voter Registrars Duties' // 51 chars → 55-byte LIKE pattern

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const userId = await seedUser()
    token = await seedSession(userId)
    // Facets filter tag counts to the current taxonomy; seed one covering this fixture's tags.
    await getDb(env.DB).insert(associationConfig).values({
      key: 'tag_taxonomy', value: JSON.stringify([{ name: LONG_TAG }, { name: 'Short' }]),
    })
    await seedBill({ billNumber: 'HB 1', tags: [LONG_TAG, 'Short'] })
    await seedBill({ billNumber: 'SB 2', tags: ['Short'] })
  })

  it('filters the list by a tag longer than D1 50-byte LIKE limit', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills?tag=${encodeURIComponent(LONG_TAG)}`, {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills.map(b => b.billNumber)).toEqual(['HB 1'])
  })

  it('computes facets when a long tag filter is active', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/facets?tag=${encodeURIComponent(LONG_TAG)}`, {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    // The tag facet excludes its own filter, so the long tag still reports its count.
    const body = await res.json() as { tags: Record<string, number> }
    expect(body.tags[LONG_TAG]).toBe(1)
  })
})

describe('GET /bills/facets', () => {
  let token: string
  let adminId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin' })
    token = await seedSession(adminId)
    // Facets filter tag counts to the current taxonomy; seed one covering this fixture's tags.
    await getDb(env.DB).insert(associationConfig).values({
      key: 'tag_taxonomy', value: JSON.stringify([{ name: 'Voting' }, { name: 'Election Admin' }]),
    })
    await seedBill({ billNumber: 'HB 1', status: 'In Committee', priority: 'high', session: '2025', tags: ['Voting', 'Election Admin'] })
    await seedBill({ billNumber: 'SB 2', status: 'Passed House', priority: 'low', session: '2024', tags: ['Voting'] })
    await seedBill({ billNumber: 'AB 3', status: 'In Committee', priority: 'medium', session: '2025', tags: [] })
  })

  it('returns 401 without session', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/facets')
    expect(res.status).toBe(401)
  })

  it('returns counts for all bills when no filters', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/facets', {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      status: Record<string, number>
      priority: Record<string, number>
      session: Record<string, number>
      tags: Record<string, number>
      position: Record<string, number>
      myBillsCount: number
    }
    expect(body.status['In Committee']).toBe(2)
    expect(body.status['Passed House']).toBe(1)
    expect(body.priority['high']).toBe(1)
    expect(body.priority['low']).toBe(1)
    expect(body.priority['medium']).toBe(1)
    expect(body.session['2025']).toBe(2)
    expect(body.session['2024']).toBe(1)
    expect(body.tags['Voting']).toBe(2)
    expect(body.tags['Election Admin']).toBe(1)
    expect(body.position['none']).toBe(3)
    expect(body.myBillsCount).toBe(0)
  })

  it('facet counts respect active filters', async () => {
    // Filter to session=2025; tag counts should only include 2025 bills
    const res = await SELF.fetch('http://localhost/api/bills/facets?session=2025', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { tags: Record<string, number>; status: Record<string, number> }
    // Only HB 1 (session 2025, tags: Voting, Election Admin) and AB 3 (session 2025, no tags)
    expect(body.tags['Voting']).toBe(1) // only HB 1 contributes; SB 2 is session 2024
    expect(body.tags['Election Admin']).toBe(1)
    expect(body.status['In Committee']).toBe(2)
    expect(body.status['Passed House']).toBeUndefined()
  })

  it('returns year facets with counts', async () => {
    // beforeEach seeds HB 1 (session 2025), SB 2 (session 2024), AB 3 (session 2025) — no yearStart set
    // Add bills with yearStart to test year facets
    await seedBill({ billNumber: 'Y1', yearStart: 2026, yearEnd: 2026 })
    await seedBill({ billNumber: 'Y2', yearStart: 2025, yearEnd: 2026 })
    await seedBill({ billNumber: 'Y3', yearStart: 2025, yearEnd: 2025 })
    const res = await SELF.fetch('http://localhost/api/bills/facets', {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { year: Record<string, number> }
    expect(body.year['2026']).toBe(1)
    expect(body.year['2025']).toBe(2)
  })

  it('year facet counts are disjunctive (exclude own filter)', async () => {
    await seedBill({ billNumber: 'Y1', yearStart: 2026, yearEnd: 2026 })
    await seedBill({ billNumber: 'Y2', yearStart: 2025, yearEnd: 2026 })
    await seedBill({ billNumber: 'Y3', yearStart: 2025, yearEnd: 2025 })
    const res = await SELF.fetch('http://localhost/api/bills/facets?year=2026', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { year: Record<string, number> }
    expect(body.year['2025']).toBe(2)
    expect(body.year['2026']).toBe(1)
  })

  it('position facet shows set position and none count', async () => {
    const db = getDb(env.DB)
    const listRes = await SELF.fetch('http://localhost/api/bills', { headers: { Cookie: `session=${token}` } })
    const { bills: allBills } = await listRes.json() as { bills: Array<{ id: string; billNumber: string }> }
    const hb1Id = allBills.find(b => b.billNumber === 'HB 1')!.id
    await db.insert(officialPositions).values({
      id: crypto.randomUUID(), billId: hb1Id, position: 'Support',
      setBy: adminId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    const res = await SELF.fetch('http://localhost/api/bills/facets', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { position: Record<string, number> }
    expect(body.position['Support']).toBe(1)
    expect(body.position['none']).toBe(2)
  })

  it('applies comma multi-search to facet counts', async () => {
    const res = await SELF.fetch(`http://localhost/api/bills/facets?q=${encodeURIComponent('HB1, SB 2')}`, {
      headers: { Cookie: `session=${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { status: Record<string, number> }
    // HB 1 (In Committee) + SB 2 (Passed House) match; AB 3 must not.
    expect(body.status['In Committee']).toBe(1)
    expect(body.status['Passed House']).toBe(1)
  })
})

describe('GET /bills — unvoted filter', () => {
  let userId: string
  let token: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    userId = await seedUser({ canVote: true })
    token = await seedSession(userId)
    await seedBill({ billNumber: 'HB 1' })
    await seedBill({ billNumber: 'SB 2' })
  })

  it('unvoted=1 returns only bills the user has not voted on', async () => {
    const db = getDb(env.DB)
    // Get bill IDs
    const listRes = await SELF.fetch('http://localhost/api/bills', { headers: { Cookie: `session=${token}` } })
    const { bills: allBills } = await listRes.json() as { bills: Array<{ id: string; billNumber: string }> }
    const hb1Id = allBills.find(b => b.billNumber === 'HB 1')!.id
    // Vote on HB 1
    await db.insert(memberVotes).values({
      id: crypto.randomUUID(),
      billId: hb1Id,
      userId,
      position: 'support',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const res = await SELF.fetch('http://localhost/api/bills?unvoted=1', {
      headers: { Cookie: `session=${token}` },
    })
    const body = await res.json() as { bills: Array<{ billNumber: string }> }
    expect(body.bills).toHaveLength(1)
    expect(body.bills[0].billNumber).toBe('SB 2')
  })
})

describe('POST /bills/bulk (admin only)', () => {
  let adminToken: string
  let memberToken: string
  let billId1: string
  let billId2: string
  let billId3: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ role: 'member' })
    memberToken = await seedSession(memberId)
    billId1 = await seedBill({ billNumber: 'HB 1', priority: 'low', status: 'In Committee' })
    billId2 = await seedBill({ billNumber: 'HB 2', priority: null, status: 'In Committee' })
    billId3 = await seedBill({ billNumber: 'HB 3', priority: 'high', status: 'Passed House' })
  })

  it('returns 403 for member', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${memberToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1], priority: 'high' }),
    })
    expect(res.status).toBe(403)
  })

  it('returns 400 when both ids and filter provided', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1], filter: {}, priority: 'high' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when neither ids nor filter provided', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when no actions specified', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1] }),
    })
    expect(res.status).toBe(400)
  })

  it('sets priority on explicit ids', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1, billId2], priority: 'high' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { updated: number }
    expect(body.updated).toBe(2)
    const db = getDb(env.DB)
    const { bills: billsTable } = await import('../../src/db/schema')
    const rows = await db.select({ id: billsTable.id, priority: billsTable.priority })
      .from(billsTable).where(inArray(billsTable.id, [billId1, billId2])).all()
    expect(rows.every(r => r.priority === 'high')).toBe(true)
  })

  it('sets priority using filter (status=In Committee sets HB 1 and HB 2)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { status: ['In Committee'] }, priority: 'medium' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { updated: number }
    expect(body.updated).toBe(2)
    const db = getDb(env.DB)
    const { bills: billsTable } = await import('../../src/db/schema')
    const rows = await db.select({ id: billsTable.id, priority: billsTable.priority })
      .from(billsTable).where(eq(billsTable.status, 'In Committee')).all()
    expect(rows.every(r => r.priority === 'medium')).toBe(true)
  })

  it('sets official position on explicit ids and writes feed events (≤10)', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1, billId2], position: 'Support' }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    const { officialPositions: op, feedEvents: fe } = await import('../../src/db/schema')
    const posRows = await db.select().from(op).where(inArray(op.billId, [billId1, billId2])).all()
    expect(posRows.every(r => r.position === 'Support')).toBe(true)
    const events = await db.select().from(fe).where(eq(fe.type, 'position_set')).all()
    expect(events).toHaveLength(2)
    expect(events.every(e => !JSON.parse(e.metadata).isBulk)).toBe(true)
  })

  it('updates existing position when bill already has one', async () => {
    const db = getDb(env.DB)
    const { users, officialPositions: op } = await import('../../src/db/schema')
    const adminUser = await db.select({ id: users.id }).from(users).get()
    await db.insert(op).values({ id: crypto.randomUUID(), billId: billId1, position: 'Oppose', setBy: adminUser!.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })

    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1], position: 'Support' }),
    })
    expect(res.status).toBe(200)
    const rows = await db.select().from(op).where(eq(op.billId, billId1)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].position).toBe('Support')
  })

  it('writes one summary feed event (isBulk=true) when >10 bills', async () => {
    const extraIds: string[] = []
    for (let i = 4; i <= 11; i++) {
      extraIds.push(await seedBill({ billNumber: `HB ${i}` }))
    }
    const allIds = [billId1, billId2, billId3, ...extraIds]
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: allIds, priority: 'high' }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    const { feedEvents: fe } = await import('../../src/db/schema')
    const events = await db.select().from(fe).where(eq(fe.type, 'priority_set')).all()
    expect(events).toHaveLength(1)
    const meta = JSON.parse(events[0].metadata) as Record<string, unknown>
    expect(meta.isBulk).toBe(true)
    expect(meta.count).toBe(11)
  })

  it('returns 400 when >1000 bills would be affected', async () => {
    const ids: string[] = []
    for (let i = 0; i < 1001; i++) {
      ids.push(await seedBill({ billNumber: `SB ${i}` }))
    }
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, priority: 'high' }),
    })
    expect(res.status).toBe(400)
  })

  it('can set priority and position in one request', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1], priority: 'high', position: 'Support' }),
    })
    expect(res.status).toBe(200)
    const db = getDb(env.DB)
    const { bills: billsTable, officialPositions: op } = await import('../../src/db/schema')
    const bill = await db.select({ priority: billsTable.priority }).from(billsTable).where(eq(billsTable.id, billId1)).get()
    const pos = await db.select({ position: op.position }).from(op).where(eq(op.billId, billId1)).get()
    expect(bill?.priority).toBe('high')
    expect(pos?.position).toBe('Support')
  })

  it('returns 400 when ids array is empty', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [], priority: 'high' }),
    })
    expect(res.status).toBe(400)
  })

  it('sets a custom field on explicit ids', async () => {
    const db = getDb(env.DB)
    const { customFieldDefinitions, billCustomFieldValues } = await import('../../src/db/schema')
    const fieldId = crypto.randomUUID()
    await db.insert(customFieldDefinitions).values({
      id: fieldId,
      name: 'Tracked',
      type: 'binary',
      options: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [billId1, billId2], customFields: [{ fieldId, value: '1' }] }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { updated: number }
    expect(body.updated).toBe(2)
    const rows = await db.select().from(billCustomFieldValues)
      .where(eq(billCustomFieldValues.fieldId, fieldId)).all()
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.value === '1')).toBe(true)
  })
})

describe('POST /bills/bulk — priority promotion', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, promoted: 0 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    ))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('promotes only null-match LegiScan bills via the bulk central endpoint', async () => {
    const stub = await seedBill({ externalId: 'legiscan:701', matchType: null })
    const tracked = await seedBill({ externalId: 'legiscan:702', matchType: 'keyword' })
    const nonLs = await seedBill({ externalId: 'ocd-bill/x', matchType: null })

    const res = await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [stub, tracked, nonLs], priority: 'high' }),
    })
    expect(res.status).toBe(200)

    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    const promoteCall = calls.find(call => String(call[0]).includes('/tenants/promote-bills/'))
    expect(promoteCall).toBeTruthy()
    const sentBody = JSON.parse((promoteCall![1] as { body: string }).body) as { billIds: number[] }
    expect(sentBody.billIds).toEqual([701])
  })

  it('does not call the promote endpoint when clearing priority', async () => {
    const stub = await seedBill({ externalId: 'legiscan:703', matchType: null })
    await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [stub], priority: null }),
    })
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.some(call => String(call[0]).includes('/tenants/promote-bills/'))).toBe(false)
  })
})

describe('GET /bills/bulk-values — nullMatchCount', () => {
  let adminToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
  })

  it('counts null-match LegiScan bills as nullMatchCount', async () => {
    const stub = await seedBill({ externalId: 'legiscan:801', matchType: null })
    const tracked = await seedBill({ externalId: 'legiscan:802', matchType: 'keyword' })
    const nonLs = await seedBill({ externalId: 'ocd-bill/y', matchType: null })

    const params = new URLSearchParams()
    for (const id of [stub, tracked, nonLs]) params.append('ids', id)
    const res = await SELF.fetch(`http://localhost/api/bills/bulk-values?${params}`, {
      headers: { Cookie: `session=${adminToken}` },
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { nullMatchCount: number }).nullMatchCount).toBe(1)
  })
})

describe('GET /bills/bulk-values (admin only)', () => {
  let adminToken: string
  let memberToken: string
  let adminId: string
  let billId1: string
  let billId2: string
  let billId3: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
    const memberId = await seedUser({ role: 'member' })
    memberToken = await seedSession(memberId)
    billId1 = await seedBill({ billNumber: 'HB 1', priority: 'high', status: 'In Committee' })
    billId2 = await seedBill({ billNumber: 'HB 2', priority: 'high', status: 'In Committee' })
    billId3 = await seedBill({ billNumber: 'HB 3', priority: 'low', status: 'Passed House' })
  })

  it('returns 403 for member', async () => {
    const res = await SELF.fetch('http://localhost/api/bills/bulk-values?ids=' + billId1, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(403)
  })

  it('returns value distributions for explicit ids', async () => {
    const res = await SELF.fetch(
      `http://localhost/api/bills/bulk-values?ids=${billId1}&ids=${billId2}&ids=${billId3}`,
      { headers: { Cookie: `session=${adminToken}` } }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; priorities: Record<string, number>; positions: Record<string, number> }
    expect(body.count).toBe(3)
    expect(body.priorities['high']).toBe(2)
    expect(body.priorities['low']).toBe(1)
    expect(body.positions['null']).toBe(3)
  })

  it('returns value distributions for filter mode', async () => {
    const res = await SELF.fetch(
      'http://localhost/api/bills/bulk-values?status=In+Committee',
      { headers: { Cookie: `session=${adminToken}` } }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number; priorities: Record<string, number> }
    expect(body.count).toBe(2)
    expect(body.priorities['high']).toBe(2)
  })

  it('returns empty when no bills match', async () => {
    const res = await SELF.fetch(
      'http://localhost/api/bills/bulk-values?status=Signed+Into+Law',
      { headers: { Cookie: `session=${adminToken}` } }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { count: number }
    expect(body.count).toBe(0)
  })

  it('returns custom field distribution including nulls for unset bills', async () => {
    const db = getDb(env.DB)
    const { customFieldDefinitions, billCustomFieldValues } = await import('../../src/db/schema')
    const fieldId = crypto.randomUUID()
    await db.insert(customFieldDefinitions).values({
      id: fieldId,
      name: 'Tracked',
      type: 'binary',
      options: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    // Set value only on billId1; billId2 and billId3 are unset
    await db.insert(billCustomFieldValues).values({
      billId: billId1,
      fieldId,
      value: '1',
      setBy: adminId,
      updatedAt: new Date().toISOString(),
    })

    const res = await SELF.fetch(
      `http://localhost/api/bills/bulk-values?ids=${billId1}&ids=${billId2}&ids=${billId3}`,
      { headers: { Cookie: `session=${adminToken}` } }
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { customFields: Record<string, Record<string, number>> }
    expect(body.customFields[fieldId]['1']).toBe(1)
    expect(body.customFields[fieldId]['null']).toBe(2)
  })
})

describe('stored timestamps are space-format', () => {
  const SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
  let adminToken: string
  let adminId: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin' })
    adminToken = await seedSession(adminId)
  })

  function adminHeaders() {
    return { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' }
  }

  it('single priority_set writes a space-format created_at', async () => {
    const billId = await seedBill({ billNumber: 'H 1' })
    await SELF.fetch(`http://localhost/api/bills/${billId}/priority`, {
      method: 'PATCH', headers: adminHeaders(), body: JSON.stringify({ priority: 'high' }),
    })
    const db = getDb(env.DB)
    const { feedEvents } = await import('../../src/db/schema')
    const row = await db.select().from(feedEvents).where(eq(feedEvents.type, 'priority_set')).get()
    expect(row!.createdAt).toMatch(SPACE)
    const b = await db.select().from((await import('../../src/db/schema')).bills).where(eq((await import('../../src/db/schema')).bills.id, billId)).get()
    expect(b!.updatedAt).toMatch(SPACE)
  })

  it('single position_set writes space-format created_at + position rows', async () => {
    const billId = await seedBill({ billNumber: 'H 2' })
    await SELF.fetch(`http://localhost/api/bills/${billId}/position`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ position: 'Support' }),
    })
    const db = getDb(env.DB)
    const { feedEvents } = await import('../../src/db/schema')
    const row = await db.select().from(feedEvents).where(eq(feedEvents.type, 'position_set')).get()
    expect(row!.createdAt).toMatch(SPACE)
    const pos = await db.select().from(officialPositions).where(eq(officialPositions.billId, billId)).get()
    expect(pos!.createdAt).toMatch(SPACE)
    expect(pos!.updatedAt).toMatch(SPACE)
  })

  it('member vote writes space-format created_at/updated_at', async () => {
    const billId = await seedBill({ billNumber: 'H 5' })
    await SELF.fetch(`http://localhost/api/bills/${billId}/votes`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ position: 'support' }),
    })
    const db = getDb(env.DB)
    const v = await db.select().from(memberVotes).where(eq(memberVotes.billId, billId)).get()
    expect(v!.createdAt).toMatch(SPACE)
    expect(v!.updatedAt).toMatch(SPACE)
  })

  it('comment + note + custom-field writes are space-format', async () => {
    const billId = await seedBill({ billNumber: 'H 6' })
    await SELF.fetch(`http://localhost/api/bills/${billId}/comments`, {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ content: 'hello' }),
    })
    await SELF.fetch(`http://localhost/api/bills/${billId}/note`, {
      method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ content: 'a note' }),
    })
    const db = getDb(env.DB)
    const cmt = await db.select().from(comments).where(eq(comments.billId, billId)).get()
    expect(cmt!.createdAt).toMatch(SPACE)
    const note = await db.select().from(notes).where(eq(notes.billId, billId)).get()
    expect(note!.createdAt).toMatch(SPACE)
    expect(note!.updatedAt).toMatch(SPACE)
  })

  it('bulk priority + position write space-format timestamps', async () => {
    const b1 = await seedBill({ billNumber: 'H 3' })
    const b2 = await seedBill({ billNumber: 'H 4' })
    await SELF.fetch('http://localhost/api/bills/bulk', {
      method: 'POST', headers: adminHeaders(), body: JSON.stringify({ ids: [b1, b2], priority: 'low', position: 'Support' }),
    })
    const db = getDb(env.DB)
    const { feedEvents, bills } = await import('../../src/db/schema')
    const events = await db.select().from(feedEvents).all()
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) expect(e.createdAt).toMatch(SPACE)
    const bs = await db.select().from(bills).where(inArray(bills.id, [b1, b2])).all()
    for (const b of bs) expect(b.updatedAt).toMatch(SPACE)
    const ps = await db.select().from(officialPositions).where(inArray(officialPositions.billId, [b1, b2])).all()
    for (const p of ps) { expect(p.createdAt).toMatch(SPACE); expect(p.updatedAt).toMatch(SPACE) }
  })
})

describe('GET /bills — broadened search fields', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
    // Term lives ONLY in tenant_summary:
    await seedBill({ billNumber: 'H 100', title: 'Consumer Protection Act',
      tenantSummary: 'Caps the resale price on a secondary ticket platform.' })
    // Term lives ONLY in abstract:
    await seedBill({ billNumber: 'H 200', title: 'General Revenue Act',
      abstract: 'Establishes a geothermal energy pilot program.' })
    // Control bill with the term in none of the fields:
    await seedBill({ billNumber: 'H 300', title: 'Unrelated Act' })
    // Cross-field match: one token only in title, the other only in abstract.
    await seedBill({ billNumber: 'H 400', title: 'Coastal Zoning Reform',
      abstract: 'Includes a desalination feasibility study.' })
  })

  async function search(q: string): Promise<string[]> {
    const res = await SELF.fetch(`http://localhost/api/bills?q=${encodeURIComponent(q)}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: { billNumber: string }[] }
    return body.bills.map(b => b.billNumber).sort()
  }

  it('a quoted phrase matches the summary (the reported bug)', async () => {
    expect(await search('"resale price on a secondary ticket"')).toEqual(['H 100'])
  })

  it('a single bare word matches the summary', async () => {
    expect(await search('resale')).toEqual(['H 100'])
  })

  it('a search matches the abstract', async () => {
    expect(await search('geothermal')).toEqual(['H 200'])
  })

  it('a multi-word query matches across summary tokens', async () => {
    expect(await search('resale secondary')).toEqual(['H 100'])
  })

  it('a multi-word query matches tokens across different fields (title + abstract)', async () => {
    expect(await search('zoning desalination')).toEqual(['H 400'])
  })
})

describe('GET /bills — bill-number ranking', () => {
  let memberToken: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    const memberId = await seedUser()
    memberToken = await seedSession(memberId)
  })

  // Order-PRESERVING search helper (the comma-search helper sorts; this keeps rank order).
  async function searchOrdered(q: string, extra = ''): Promise<string[]> {
    const res = await SELF.fetch(`http://localhost/api/bills?q=${encodeURIComponent(q)}${extra}`, {
      headers: { Cookie: `session=${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { bills: { billNumber: string }[] }
    return body.bills.map(b => b.billNumber)
  }

  it('floats the exact bill-number match above an abstract number-noise match', async () => {
    // H 100 would sort first by default (higher relevance) but only matches in its abstract.
    await seedBill({ billNumber: 'H 100', title: 'Budget Act',
      abstract: 'Amends section SB 977 of the code.', relevanceScore: 10 })
    await seedBill({ billNumber: 'SB 977', title: 'Unrelated Act', relevanceScore: 1 })
    expect(await searchOrdered('SB 977')).toEqual(['SB 977', 'H 100'])
  })

  it('leaves topic-search order unchanged (boost inert)', async () => {
    await seedBill({ billNumber: 'H 1', title: 'Election Reform', relevanceScore: 1 })
    await seedBill({ billNumber: 'H 2', title: 'Election Funding', relevanceScore: 9 })
    // Default sort ranks by relevance desc; no bill_number contains "election".
    expect(await searchOrdered('election')).toEqual(['H 2', 'H 1'])
  })

  it('floats the exact match even under an explicit non-default sort', async () => {
    // sort=bill asc would order H 100 before SB 977 by prefix; the boost overrides.
    await seedBill({ billNumber: 'H 100', title: 'Zeta', abstract: 'refers to SB 977' })
    await seedBill({ billNumber: 'SB 977', title: 'Alpha' })
    expect(await searchOrdered('SB 977', '&sort=bill&dir=asc')).toEqual(['SB 977', 'H 100'])
  })

  it('floats both bills in a comma multi-lookup above a higher-tier non-match', async () => {
    await seedBill({ billNumber: 'HB 100', title: 'Alpha', relevanceScore: 1 })
    await seedBill({ billNumber: 'SB 200', title: 'Beta', relevanceScore: 1 })
    await seedBill({ billNumber: 'HB 999', title: 'Election Omnibus', relevanceScore: 10 })
    // Matches HB 100 and SB 200 by number and HB 999 by title; HB 999 has the highest
    // relevance but the two exact number matches float above it.
    const order = await searchOrdered('HB 100, SB 200, election')
    expect(order.slice(0, 2).sort()).toEqual(['HB 100', 'SB 200'])
    expect(order[2]).toBe('HB 999')
  })

  it('floats an untracked exact match even when the optimize fast path would trigger', async () => {
    // Two TRACKED noise bills (abstract mentions the number) + one UNTRACKED exact match.
    // With pageSize=1 and 2 tracked bills, the old fast path (tracked-only) would return a
    // noise bill and never surface the untracked SB 977. Bypassing the fast path for searches
    // fixes it.
    await seedBill({ billNumber: 'HB 100', title: 'Budget Act', abstract: 'mentions SB 977', matchType: 'keyword', relevanceScore: 10 })
    await seedBill({ billNumber: 'HB 200', title: 'Finance Act', abstract: 'also SB 977', matchType: 'keyword', relevanceScore: 9 })
    await seedBill({ billNumber: 'SB 977', title: 'Ticket Resale Act', matchType: null, relevanceScore: 1 })
    const order = await searchOrdered('SB 977', '&pageSize=1')
    expect(order[0]).toBe('SB 977')
  })
})
