import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill, seedBillText } from '../helpers'
import { EXPORT_TABLES } from '../../../shared/exportTables'

vi.mock('../../src/lib/email', () => ({
  sendMagicLink: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

// The /rich export path calls central's bulk /bills/rich-batch endpoint. Mock
// centralFetch so the test exercises the flattening logic without a real central
// worker. centralRichByBill is keyed by external id ('legiscan:<n>').
const centralRichByBill: Record<string, any> = {}
vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn(async (_env: unknown, path: string, init?: RequestInit) => {
    if (path === '/bills/rich-batch') {
      const ids: unknown[] = JSON.parse((init?.body as string) ?? '{}').ids ?? []
      const byId: Record<string, unknown> = {}
      for (const id of ids) {
        const numeric = String(id).replace('legiscan:', '')
        const entry = centralRichByBill[`legiscan:${numeric}`]
        byId[numeric] = entry
          ? { amendments: entry.amendments ?? [], supplements: entry.supplements ?? [], votes: entry.votes ?? [] }
          : { amendments: [], supplements: [], votes: [] }
      }
      return new Response(JSON.stringify({ byId }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }),
}))

describe('Export API', () => {
  let adminId: string
  let adminCookie: string
  let memberId: string
  let memberCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    const adminToken = await seedSession(adminId)
    adminCookie = `session=${adminToken}`
    memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member User' })
    const memberToken = await seedSession(memberId)
    memberCookie = `session=${memberToken}`
  })

  it('returns 400 for unknown table name', async () => {
    const res = await app.request(
      '/api/admin/export/nonexistent',
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/unknown table/i)
  })

  it('returns 401 without session', async () => {
    const res = await app.request('/api/admin/export/bills', {}, env)
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin', async () => {
    const res = await app.request(
      '/api/admin/export/bills',
      { headers: { Cookie: memberCookie } },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('returns rows for bills table', async () => {
    const billId = await seedBill({ billNumber: 'HB 100', title: 'Test Export Bill', state: 'RI', matchType: 'keyword' })
    const res = await app.request(
      '/api/admin/export/bills',
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.table).toBe('bills')
    expect(body.rows.length).toBe(1)
    expect(body.rows[0].id).toBe(billId)
    expect(body.rows[0].billNumber).toBe('HB 100')
  })

  it('filters sensitive columns from users table', async () => {
    const res = await app.request(
      '/api/admin/export/users',
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.table).toBe('users')
    expect(body.rows.length).toBeGreaterThan(0)
    // Should have safe columns
    expect(body.rows[0]).toHaveProperty('id')
    expect(body.rows[0]).toHaveProperty('email')
    expect(body.rows[0]).toHaveProperty('name')
    expect(body.rows[0]).toHaveProperty('role')
    // Should NOT have sensitive columns (users table has no tokenHash, but
    // we verify the whitelist is applied by checking only expected keys exist)
    const keys = Object.keys(body.rows[0])
    expect(keys).toEqual(expect.arrayContaining(['id', 'email', 'name', 'role', 'createdAt']))
    // Should not have any unexpected columns beyond the safe set
    const safeKeys = ['id', 'email', 'name', 'role', 'subtitle', 'invitedBy', 'createdAt', 'lastActive', 'deactivatedAt', 'canVote']
    for (const key of keys) {
      expect(safeKeys).toContain(key)
    }
  })

  it('paginates with cursor and limit', async () => {
    // Seed 3 bills
    const id1 = await seedBill({ billNumber: 'HB 1', title: 'Bill 1', state: 'RI', matchType: 'keyword' })
    const id2 = await seedBill({ billNumber: 'HB 2', title: 'Bill 2', state: 'RI', matchType: 'keyword' })
    const id3 = await seedBill({ billNumber: 'HB 3', title: 'Bill 3', state: 'RI', matchType: 'keyword' })

    // Fetch with limit=2
    const res1 = await app.request(
      '/api/admin/export/bills?limit=2',
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as any
    expect(body1.rows.length).toBe(2)
    expect(body1.nextCursor).toBeTruthy()

    // Fetch next page
    const res2 = await app.request(
      `/api/admin/export/bills?limit=2&cursor=${body1.nextCursor}`,
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res2.status).toBe(200)
    const body2 = await res2.json() as any
    expect(body2.rows.length).toBe(1)
    expect(body2.nextCursor).toBeNull()

    // All IDs should be unique across pages
    const allIds = [...body1.rows.map((r: any) => r.id), ...body2.rows.map((r: any) => r.id)]
    expect(new Set(allIds).size).toBe(3)
  })

  it('returns empty rows for table with no data', async () => {
    const res = await app.request(
      '/api/admin/export/feedEvents',
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.table).toBe('feedEvents')
    expect(body.rows).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  // Regression guard for the "Unknown table name" export bug: every table the
  // frontend asks for (the shared EXPORT_TABLES list) must be accepted by the
  // backend. A phantom table name here (e.g. the old billCalendar) would 400.
  it('accepts every table in the shared EXPORT_TABLES list', async () => {
    for (const table of EXPORT_TABLES) {
      const res = await app.request(
        `/api/admin/export/${table}`,
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status, `table "${table}" should be exportable`).toBe(200)
      const body = await res.json() as any
      expect(body.table).toBe(table)
    }
  })

  it('exports calendar_event_bills rows (composite-key table)', async () => {
    const billId = await seedBill({ billNumber: 'HB 50', title: 'Calendar Bill', state: 'RI' })
    const db = env.DB
    await db.prepare(
      `INSERT INTO calendar_events (id, uid, bill_id, source, status) VALUES (?, ?, ?, 'hearing', 'confirmed')`,
    ).bind('evt-1', 'uid-1', billId).run()
    await db.prepare(
      `INSERT INTO calendar_event_bills (event_id, bill_id) VALUES (?, ?)`,
    ).bind('evt-1', billId).run()

    const res = await app.request(
      '/api/admin/export/calendarEventBills',
      { headers: { Cookie: adminCookie } },
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.rows.length).toBe(1)
    expect(body.rows[0].eventId).toBe('evt-1')
    expect(body.rows[0].billId).toBe(billId)
    expect(body.nextCursor).toBeNull()
  })

  describe('associationConfig export is whitelisted', () => {
    it('includes user-facing keys and excludes secret/internal/dead keys', async () => {
      const db = env.DB
      const rows: [string, string][] = [
        // user-facing — should be exported
        ['association_name', '"RI Clerks"'],
        ['keywords', '["election"]'],
        ['tag_taxonomy', '[]'],
        // secret / internal / dead — should NOT be exported
        ['calendar_feed_slug', 'abc123secret'],
        ['sessions', '{"data":[]}'],
        ['resend_daily_used', '11'],
        ['last_digest_at', '2026-06-09 11:00:15'],
        ['allowed_domains', '[]'],
        ['reaction_emojis', '["👍"]'],
      ]
      for (const [key, value] of rows) {
        await db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES (?, ?)`).bind(key, value).run()
      }

      const res = await app.request('/api/admin/export/associationConfig', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as any
      const keys: string[] = body.rows.map((r: any) => r.key)
      // user-facing keys present
      expect(keys).toEqual(expect.arrayContaining(['association_name', 'keywords', 'tag_taxonomy']))
      // secret / internal / dead keys excluded
      for (const banned of ['calendar_feed_slug', 'sessions', 'resend_daily_used', 'last_digest_at', 'allowed_domains', 'reaction_emojis']) {
        expect(keys).not.toContain(banned)
      }
    })
  })

  describe('bills export is scoped to meaningful bills', () => {
    it('excludes untracked stubs but includes tracked/analyzed/prioritized/engaged bills', async () => {
      const tracked = await seedBill({ billNumber: 'HB 1', title: 'Tracked', state: 'RI', matchType: 'keyword' })
      const analyzed = await seedBill({ billNumber: 'HB 2', title: 'Analyzed', state: 'RI', matchType: null, aiProcessedAt: '2026-01-01 00:00:00' })
      const prioritized = await seedBill({ billNumber: 'HB 3', title: 'Prioritized', state: 'RI', matchType: null, priority: 'high' })
      const engaged = await seedBill({ billNumber: 'HB 4', title: 'Engaged', state: 'RI', matchType: null })
      await seedBill({ billNumber: 'HB 5', title: 'Stub', state: 'RI', matchType: null })
      // Give the "engaged" bill a comment so it qualifies via engagement only.
      await env.DB.prepare(
        `INSERT INTO comments (id, bill_id, user_id, content) VALUES ('c1', ?, ?, 'hi')`,
      ).bind(engaged, adminId).run()

      const res = await app.request('/api/admin/export/bills', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as any
      const ids = body.rows.map((r: any) => r.id).sort()
      expect(ids).toEqual([tracked, analyzed, prioritized, engaged].sort())
    })
  })

  describe('billTexts export follows the same bill scope', () => {
    it('excludes texts belonging to untracked stub bills', async () => {
      const tracked = await seedBill({ billNumber: 'HB 1', title: 'Tracked', state: 'RI', matchType: 'keyword' })
      const stub = await seedBill({ billNumber: 'HB 2', title: 'Stub', state: 'RI', matchType: null })
      await seedBillText(tracked, { docId: 'doc-tracked' })
      await seedBillText(stub, { docId: 'doc-stub' })

      const res = await app.request('/api/admin/export/billTexts', { headers: { Cookie: adminCookie } }, env)
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.rows.length).toBe(1)
      expect(body.rows[0].billId).toBe(tracked)
    })
  })

  describe('GET /admin/export/rich', () => {
    beforeEach(() => {
      for (const k of Object.keys(centralRichByBill)) delete centralRichByBill[k]
    })

    it('flattens amendments, supplements, and roll-call votes from central', async () => {
      const billId = await seedBill({
        billNumber: 'HB 200',
        title: 'Rich Bill',
        state: 'RI',
        externalId: 'legiscan:999',
        matchType: 'keyword',
      })
      centralRichByBill['legiscan:999'] = {
        amendments: [
          { amendmentId: 11, adopted: true, chamber: 'H', date: '2026-01-02', title: 'Amd 1', description: 'd', mime: 'application/pdf', url: 'u', stateLink: 's' },
        ],
        supplements: [
          { supplementId: 22, typeId: 1, type: 'Fiscal Note', date: '2026-01-03', title: 'Sup 1', description: 'd', mime: 'application/pdf', url: 'u', stateLink: 's' },
        ],
        votes: [
          { id: 'rc-1', motionText: 'Third Reading', date: '2026-01-04', result: 'pass', chamber: 'H', counts: [
            { option: 'yes', value: 40 }, { option: 'no', value: 10 }, { option: 'not voting', value: 2 }, { option: 'absent', value: 1 },
          ] },
        ],
      }

      const res = await app.request(
        '/api/admin/export/rich',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as any

      expect(body.amendments.length).toBe(1)
      expect(body.amendments[0]).toMatchObject({ billId, billNumber: 'HB 200', amendmentId: 11, adopted: true })
      expect(body.supplements.length).toBe(1)
      expect(body.supplements[0]).toMatchObject({ billId, billNumber: 'HB 200', supplementId: 22, type: 'Fiscal Note' })
      expect(body.votes.length).toBe(1)
      expect(body.votes[0]).toMatchObject({ billId, billNumber: 'HB 200', voteId: 'rc-1', result: 'pass', yes: 40, no: 10, notVoting: 2, absent: 1 })
      expect(body.nextCursor).toBeNull()
    })

    it('skips non-LegiScan bills', async () => {
      await seedBill({ billNumber: 'HB 1', title: 'OS Bill', state: 'RI', externalId: 'ocd-bill/abc' })
      const res = await app.request(
        '/api/admin/export/rich',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.amendments).toEqual([])
      expect(body.supplements).toEqual([])
      expect(body.votes).toEqual([])
    })

    it('skips untracked stub bills (match_type null)', async () => {
      // Lightweight stubs outside the keyword set would balloon the central
      // fan-out (one read per bill) for no useful rich data — exclude them.
      await seedBill({
        billNumber: 'HB 300',
        title: 'Stub Bill',
        state: 'RI',
        externalId: 'legiscan:1001',
        matchType: null,
      })
      centralRichByBill['legiscan:1001'] = {
        amendments: [{ amendmentId: 1, adopted: false, chamber: 'H', date: null, title: 't', description: null, mime: null, url: null, stateLink: null }],
        supplements: [],
        votes: [],
      }

      const res = await app.request(
        '/api/admin/export/rich',
        { headers: { Cookie: adminCookie } },
        env,
      )
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.amendments).toEqual([])
    })
  })
})
