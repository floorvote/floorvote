import { env, applyD1Migrations, reset } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { runKeywordSweep } from '../../src/cron/keywordSweep'
import migration0001 from '../../migrations/0001_initial.sql?raw'
import migration0003 from '../../migrations/0003_openstates_migration.sql?raw'

function parseMigration(sql: string, name: string) {
  const queries = sql
    .split(';')
    .map(s => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)
    .map(s => s + ';')
  return { name, queries }
}

beforeEach(async () => {
  await reset()
  await applyD1Migrations(env.DB, [
    parseMigration(migration0001, '0001_initial'),
    parseMigration(migration0003, '0003_openstates_migration'),
  ])
})

describe('runKeywordSweep', () => {
  it('finds body-text-only keyword matches and queues them', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'nj:222', state: 'NJ', identifier: '222',
      yearStart: 2026, yearEnd: 2027, sessionName: '2026',
      isCurrent: true, sineDie: false,
    })
    await db.insert(schema.tenants).values({
      tenantId: 'test-nj', name: 'Acme NJ', stateCoverage: JSON.stringify(['NJ']),
      ingestionMode: 'keyword-filtered', active: true,
    })
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'test-nj', keyword: 'ballot' },
    ])

    const queued: unknown[] = []
    const mockProvider = {
      fetchSessions: vi.fn(),
      fetchBillDetail: vi.fn(),
      fetchUpdatedBills: vi.fn(),
      fetchKeywordMatches: vi.fn().mockImplementation(async function* () {
        yield {
          id: 'ocd-bill/new-match', state: 'NJ', session: '222', number: 'A99',
          title: 'Transportation Bill', abstract: null, status: 'introduced',
          statusDate: null, lastAction: null, lastActionDate: null,
          url: '', stateUrl: null, sponsors: [], versions: [],
          updatedAt: '2026-05-13T00:00:00Z',
        }
      }),
    }

    const mockEnv = {
      ...env,
      INGESTOR_QUEUE: { sendBatch: async (msgs: unknown[]) => { queued.push(...msgs) } },
    } as any

    await runKeywordSweep(mockEnv, db, mockProvider)

    expect(queued).toHaveLength(1)
    expect((queued[0] as any).body.billId).toBe('ocd-bill/new-match')
    const linked = await db.select().from(schema.billTenants).all()
    expect(linked).toHaveLength(1)
    expect(linked[0].matchedKeyword).toBe('ballot')
  })

  it('skips bills already linked to the tenant', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'nj:222', state: 'NJ', identifier: '222',
      yearStart: 2026, yearEnd: 2027, sessionName: '2026',
      isCurrent: true, sineDie: false,
    })
    await db.insert(schema.tenants).values({
      tenantId: 'test-nj', name: 'Acme NJ', stateCoverage: JSON.stringify(['NJ']),
      ingestionMode: 'keyword-filtered', active: true,
    })
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'test-nj', keyword: 'ballot' },
    ])
    await db.insert(schema.bills).values({
      billId: 'ocd-bill/existing', sessionId: 'nj:222', state: 'NJ',
      number: 'A1', title: 'Ballot Act',
    })
    await db.insert(schema.billTenants).values({
      billId: 'ocd-bill/existing', tenantId: 'test-nj', matchedKeyword: 'ballot',
    })

    const queued: unknown[] = []
    const mockProvider = {
      fetchSessions: vi.fn(),
      fetchBillDetail: vi.fn(),
      fetchUpdatedBills: vi.fn(),
      fetchKeywordMatches: vi.fn().mockImplementation(async function* () {
        yield {
          id: 'ocd-bill/existing', state: 'NJ', session: '222', number: 'A1',
          title: 'Ballot Act', abstract: null, status: 'introduced',
          statusDate: null, lastAction: null, lastActionDate: null,
          url: '', stateUrl: null, sponsors: [], versions: [],
          updatedAt: '2026-05-13T00:00:00Z',
        }
      }),
    }

    const mockEnv = {
      ...env,
      INGESTOR_QUEUE: { sendBatch: async (msgs: unknown[]) => { queued.push(...msgs) } },
    } as any

    await runKeywordSweep(mockEnv, db, mockProvider)

    expect(queued).toHaveLength(0)
  })

  it('skips ingestionMode=all tenants', async () => {
    const db = drizzle(env.DB, { schema })

    await db.insert(schema.sessions).values({
      sessionId: 'ri:2026', state: 'RI', identifier: '2026',
      yearStart: 2026, yearEnd: 2026, sessionName: '2026',
      isCurrent: true, sineDie: false,
    })
    await db.insert(schema.tenants).values({
      tenantId: 'ri', name: 'RI', stateCoverage: JSON.stringify(['RI']),
      ingestionMode: 'all', active: true,
    })
    await db.insert(schema.keywordRegistry).values([
      { tenantId: 'ri', keyword: 'election' },
    ])

    const mockProvider = {
      fetchSessions: vi.fn(),
      fetchBillDetail: vi.fn(),
      fetchUpdatedBills: vi.fn(),
      fetchKeywordMatches: vi.fn(),
    }

    await runKeywordSweep({ ...env } as any, db, mockProvider)

    expect(mockProvider.fetchKeywordMatches).not.toHaveBeenCalled()
  })
})
