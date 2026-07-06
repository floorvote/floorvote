import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { runSync, shouldSyncState } from '../../src/cron/sync'
import migration0001 from '../../migrations/0001_initial.sql?raw'
import migration0003 from '../../migrations/0003_openstates_migration.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map((s) =>
      s.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim(),
    )
    .filter((s) => s.length > 0)
    .map((s) => s + ';')
  return { name, queries }
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0003, '0003_openstates_migration'),
  ])
})

describe('shouldSyncState', () => {
  it('returns true when never synced', () => {
    expect(shouldSyncState(null, 24)).toBe(true)
  })

  it('returns false when synced within frequency window', () => {
    const recentlyISO = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    expect(shouldSyncState(recentlyISO, 24)).toBe(false)
  })

  it('returns true when last sync is older than frequency', () => {
    const oldISO = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    expect(shouldSyncState(oldISO, 24)).toBe(true)
  })
})

describe('runSync', () => {
  it('queues new matching bills to ingestor for keyword-filtered tenants', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'nj:222', state: 'NJ', identifier: '222',
      yearStart: 2026, yearEnd: 2027, sessionName: '2026 Session',
      isCurrent: true, sineDie: false, lastSyncedAt: null,
    })
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'test-nj', keyword: 'election' },
    ])
    await db.insert(schema.tenants).values({
      tenantId: 'test-nj', name: 'Acme NJ', stateCoverage: JSON.stringify(['NJ']),
      ingestionMode: 'keyword-filtered', active: true,
    })

    const queued: unknown[] = []
    const mockProvider = {
      fetchSessions: vi.fn().mockResolvedValue([
        { identifier: '222', name: '2026 Session', classification: 'primary', startDate: '2026-01-07', endDate: '' },
      ]),
      fetchBillDetail: vi.fn(),
      fetchKeywordMatches: vi.fn(),
      fetchUpdatedBills: vi.fn().mockImplementation(async function* () {
        yield {
          id: 'ocd-bill/aaa', state: 'NJ', session: '222', number: 'A1',
          title: 'Election Law Reform', abstract: null, status: 'introduced',
          statusDate: null, lastAction: 'Introduced', lastActionDate: '2026-01-15',
          url: 'https://openstates.org/nj/bills/222/A1/', stateUrl: null,
          sponsors: [], versions: [], updatedAt: '2026-01-15T00:00:00Z',
        }
        yield {
          id: 'ocd-bill/bbb', state: 'NJ', session: '222', number: 'A2',
          title: 'Vehicle Registration Fee', abstract: null, status: 'introduced',
          statusDate: null, lastAction: 'Introduced', lastActionDate: '2026-01-15',
          url: 'https://openstates.org/nj/bills/222/A2/', stateUrl: null,
          sponsors: [], versions: [], updatedAt: '2026-01-15T00:00:00Z',
        }
      }),
    }

    const mockEnv = {
      ...env,
      INGESTOR_QUEUE: { sendBatch: async (msgs: unknown[]) => { queued.push(...msgs) } },
    } as any

    await runSync(mockEnv, db, mockProvider)

    expect(queued).toHaveLength(1)
    expect((queued[0] as any).body.billId).toBe('ocd-bill/aaa')

    const allBills = await db.select().from(schema.bills).all()
    expect(allBills).toHaveLength(2)
    const tenantBills = await db.select().from(schema.billTenants).all()
    expect(tenantBills).toHaveLength(1)
  })

  it('queues all bills for ingestionMode=all tenants regardless of keywords', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'ri:2026', state: 'RI', identifier: '2026',
      yearStart: 2026, yearEnd: 2026, sessionName: '2026 Session',
      isCurrent: true, sineDie: false, lastSyncedAt: null,
    })
    await db.insert(schema.tenants).values({
      tenantId: 'ri', name: 'RI', stateCoverage: JSON.stringify(['RI']),
      ingestionMode: 'all', active: true,
    })

    const queued: unknown[] = []
    const mockProvider = {
      fetchSessions: vi.fn().mockResolvedValue([
        { identifier: '2026', name: '2026 Session', classification: 'primary', startDate: '2026-01-07', endDate: '' },
      ]),
      fetchBillDetail: vi.fn(),
      fetchKeywordMatches: vi.fn(),
      fetchUpdatedBills: vi.fn().mockImplementation(async function* () {
        yield {
          id: 'ocd-bill/ccc', state: 'RI', session: '2026', number: 'HB1',
          title: 'Unrelated Bill', abstract: null, status: 'introduced',
          statusDate: null, lastAction: null, lastActionDate: null,
          url: '', stateUrl: null, sponsors: [], versions: [],
          updatedAt: '2026-01-15T00:00:00Z',
        }
      }),
    }

    const mockEnv = {
      ...env,
      INGESTOR_QUEUE: { sendBatch: async (msgs: unknown[]) => { queued.push(...msgs) } },
    } as any

    await runSync(mockEnv, db, mockProvider)

    expect(queued).toHaveLength(1)
    const tenantBills = await db.select().from(schema.billTenants).all()
    expect(tenantBills).toHaveLength(1)
    expect(tenantBills[0].matchedKeyword).toBeNull()
  })
})

describe('session discovery', () => {
  it('inserts new sessions from provider', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.tenants).values({
      tenantId: 'ri', name: 'RI', stateCoverage: JSON.stringify(['RI']),
      ingestionMode: 'all', active: true,
    })

    const mockProvider = {
      fetchSessions: vi.fn().mockResolvedValue([
        { identifier: '2026', name: '2026 Regular Session', classification: 'primary', startDate: '2026-01-07', endDate: '' },
        { identifier: '2025', name: '2025 Regular Session', classification: 'primary', startDate: '2025-01-07', endDate: '2025-06-30' },
      ]),
      fetchUpdatedBills: vi.fn().mockImplementation(async function* () {}),
      fetchBillDetail: vi.fn(),
      fetchKeywordMatches: vi.fn(),
    }

    const mockEnv = {
      ...env,
      INGESTOR_QUEUE: { sendBatch: async () => {} },
    } as any

    await runSync(mockEnv, db, mockProvider)

    const allSessions = await db.select().from(schema.sessions).all()
    expect(allSessions).toHaveLength(2)
    expect(allSessions.find(s => s.sessionId === 'ri:2026')?.isCurrent).toBe(true)
    expect(allSessions.find(s => s.sessionId === 'ri:2025')?.sineDie).toBe(true)
  })
})
