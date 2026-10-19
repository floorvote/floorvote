import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'
import { clearKeywordMatchCorpus, CORPUS_TTL_MS } from '../../src/lib/keywordMatchSummary'

vi.mock('../../src/lib/centralFetch', () => ({
  centralFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
}))

vi.mock('../../src/lib/email', async (importOriginal) =>
  (await import('../mail')).withFakeSender(await importOriginal<typeof import('../../src/lib/email')>()))

vi.mock('../../src/cron/sync', () => ({
  registerWithCentral: vi.fn().mockResolvedValue(undefined),
}))

type Summary = { total: number; matched: number; newlyMatched: number; unmatched: number }

describe('POST /admin/keyword-match-summary', () => {
  let adminCookie: string

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.clearAllMocks()
    clearKeywordMatchCorpus()
    await getDb(env.DB).delete(associationConfig)
    const adminId = await seedUser({ role: 'admin', email: 'admin@example.com', name: 'Admin User' })
    adminCookie = `session=${await seedSession(adminId)}`
  })

  async function saveKeywords(keywords: string[]) {
    await getDb(env.DB).insert(associationConfig).values({ key: 'keywords', value: JSON.stringify(keywords) })
  }

  async function summary(keywords: unknown, cookie = adminCookie) {
    return await app.request('/api/admin/keyword-match-summary', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords }),
    }, env)
  }

  async function summarize(keywords: unknown) {
    const res = await summary(keywords)
    expect(res.status).toBe(200)
    return await res.json() as Summary
  }

  it('counts matches over every bill, analyzed or not, with the shared matcher', async () => {
    await seedBill({ externalId: 'legiscan:1', title: 'Election Reform Act', billNumber: 'HB 1', matchType: 'keyword', aiProcessedAt: '2026-01-01 00:00:00' })
    await seedBill({ externalId: 'legiscan:2', title: 'Election Day Holiday', billNumber: 'HB 2', matchType: null })
    await seedBill({ externalId: 'legiscan:3', title: 'Road Maintenance', billNumber: 'HB 3', matchType: null })
    await seedBill({ externalId: 'legiscan:4', title: 'Tax Credits', billNumber: 'HB 4', matchType: 'manual' })
    expect(await summarize(['election'])).toMatchObject({ total: 4, matched: 2 })
  })

  it('matches on the description and the bill number, as saving would', async () => {
    await seedBill({ externalId: 'legiscan:1', title: 'Unrelated', abstract: 'Relating to voter registration', billNumber: 'HB 1', matchType: null })
    await seedBill({ externalId: 'legiscan:2', title: 'Unrelated', billNumber: 'HB 1019', matchType: null })
    await seedBill({ externalId: 'legiscan:3', title: 'Unrelated', billNumber: 'SB 7', matchType: null })
    expect(await summarize(['voter registration', 'hb 1019'])).toMatchObject({ total: 3, matched: 2 })
  })

  it('leaves out member drafts, which are not bills the instance tracks', async () => {
    await seedBill({ externalId: 'legiscan:1', title: 'Election Reform', matchType: null })
    await seedBill({ title: 'Election Draft', isDraft: true, matchType: null })
    expect(await summarize(['election'])).toMatchObject({ total: 1, matched: 1 })
  })

  it('reports zero matches for an empty list', async () => {
    await seedBill({ externalId: 'legiscan:1', title: 'Election Reform', matchType: 'keyword' })
    expect(await summarize([])).toEqual({ total: 1, matched: 0, newlyMatched: 0, unmatched: 0 })
  })

  it('reports an instance with no bills as zero of zero', async () => {
    expect(await summarize(['election'])).toEqual({ total: 0, matched: 0, newlyMatched: 0, unmatched: 0 })
  })

  describe('versus the saved keywords', () => {
    beforeEach(async () => {
      await seedBill({ externalId: 'legiscan:1', title: 'Election Reform', matchType: 'keyword' })
      await seedBill({ externalId: 'legiscan:2', title: 'Health Care Access', matchType: 'keyword' })
      await seedBill({ externalId: 'legiscan:3', title: 'Water Quality Standards', matchType: null })
      await seedBill({ externalId: 'legiscan:4', title: 'Road Maintenance', matchType: null })
      await saveKeywords(['election', 'health care'])
    })

    it('counts bills the proposed list would newly match and unmatch', async () => {
      // election stays, health care goes, water quality is new.
      expect(await summarize(['election', 'water quality'])).toEqual({ total: 4, matched: 2, newlyMatched: 1, unmatched: 1 })
    })

    it('reports no change when the proposed list matches the same bills', async () => {
      expect(await summarize(['election', 'health care'])).toEqual({ total: 4, matched: 2, newlyMatched: 0, unmatched: 0 })
    })

    it('judges against what the saved keywords match, not against stored match types', async () => {
      // Bill 2 is stored as a keyword match, but only the saved list's matches are the baseline.
      await getDb(env.DB).delete(associationConfig)
      await saveKeywords(['election'])
      expect(await summarize(['election', 'health care'])).toMatchObject({ newlyMatched: 1, unmatched: 0 })
    })

    it('treats an empty proposed list as unmatching everything the saved list matched', async () => {
      expect(await summarize([])).toEqual({ total: 4, matched: 0, newlyMatched: 0, unmatched: 2 })
    })

    it('treats a missing saved list as matching nothing', async () => {
      await getDb(env.DB).delete(associationConfig)
      expect(await summarize(['election'])).toEqual({ total: 4, matched: 1, newlyMatched: 1, unmatched: 0 })
    })

    it('ignores blank lines, whitespace, and case in the proposed list', async () => {
      expect(await summarize(['  ELECTION  ', '', '   ', 'Health Care'])).toEqual({ total: 4, matched: 2, newlyMatched: 0, unmatched: 0 })
    })
  })

  describe('the wildcard', () => {
    beforeEach(async () => {
      await seedBill({ externalId: 'legiscan:1', title: 'Election Reform', matchType: null })
      await seedBill({ externalId: 'legiscan:2', title: 'Road Maintenance', matchType: null })
      await seedBill({ externalId: 'legiscan:3', title: 'Tax Credits', matchType: null })
    })

    it('counts every bill for a lone *', async () => {
      expect(await summarize(['*'])).toEqual({ total: 3, matched: 3, newlyMatched: 3, unmatched: 0 })
    })

    it('counts every bill for a lone run of asterisks', async () => {
      expect(await summarize(['***'])).toMatchObject({ matched: 3 })
    })

    it('ignores * alongside other keywords, as the matcher does', async () => {
      expect(await summarize(['election', '*'])).toMatchObject({ matched: 1 })
    })

    it('still treats * as alone when the rest of the list is blank', async () => {
      expect(await summarize(['*', '', '  '])).toMatchObject({ matched: 3 })
    })

    it('counts only the unmatched bills as new when the saved list is already *', async () => {
      await saveKeywords(['*'])
      expect(await summarize(['election'])).toEqual({ total: 3, matched: 1, newlyMatched: 0, unmatched: 2 })
    })
  })

  it('counts correctly across more bills than one read batch', async () => {
    // One statement, since D1 caps bound variables per query.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 2299)
       INSERT INTO bills (id, external_id, bill_number, title, state)
       SELECT printf('bulk-%05d', i), 'legiscan:' || i, 'HB ' || i,
              CASE WHEN i % 10 = 0 THEN 'Election Reform' ELSE 'Road Maintenance' END, 'RI'
       FROM n`,
    ).run()
    expect(await summarize(['election'])).toMatchObject({ total: 2300, matched: 230 })
  })

  describe('the cached bill corpus', () => {
    // An env whose DB counts the statements that read bill text, so a test can
    // tell a cache hit from a re-read.
    function countingEnv() {
      const state = { billReads: 0 }
      const DB = new Proxy(env.DB, {
        get(target, prop) {
          if (prop === 'prepare') {
            return (query: string) => {
              if (query.includes('"abstract"')) state.billReads++
              return target.prepare(query)
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return { state, env: { ...env, DB } as typeof env }
    }

    async function countWith(e: typeof env, keywords: string[]) {
      const res = await app.request('/api/admin/keyword-match-summary', {
        method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords }),
      }, e)
      expect(res.status).toBe(200)
      return await res.json() as Summary
    }

    beforeEach(async () => {
      await seedBill({ externalId: 'legiscan:1', title: 'Election Reform', matchType: null })
      await seedBill({ externalId: 'legiscan:2', title: 'Road Maintenance', matchType: null })
    })

    it('reads the bills once for a run of requests, even as the keywords change', async () => {
      const { state, env: counted } = countingEnv()
      expect(await countWith(counted, ['election'])).toMatchObject({ total: 2, matched: 1 })
      expect(await countWith(counted, ['election', 'road'])).toMatchObject({ total: 2, matched: 2 })
      expect(await countWith(counted, ['road'])).toMatchObject({ total: 2, matched: 1 })
      expect(state.billReads).toBe(1)
    })

    it('reads again when a bill has been added since', async () => {
      const { state, env: counted } = countingEnv()
      await countWith(counted, ['election'])
      await seedBill({ externalId: 'legiscan:3', title: 'Election Day Holiday', matchType: null })
      expect(await countWith(counted, ['election'])).toMatchObject({ total: 3, matched: 2 })
      expect(state.billReads).toBe(2)
    })

    it('reads again when a bill has been removed since', async () => {
      const { state, env: counted } = countingEnv()
      await countWith(counted, ['election'])
      await env.DB.prepare('DELETE FROM bills WHERE external_id = ?').bind('legiscan:1').run()
      expect(await countWith(counted, ['election'])).toMatchObject({ total: 1, matched: 0 })
      expect(state.billReads).toBe(2)
    })

    it('reads again once the TTL has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const { state, env: counted } = countingEnv()
        await countWith(counted, ['election'])
        vi.setSystemTime(Date.now() + CORPUS_TTL_MS - 1000)
        await countWith(counted, ['election'])
        expect(state.billReads).toBe(1)
        vi.setSystemTime(Date.now() + 2000)
        await countWith(counted, ['election'])
        expect(state.billReads).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not count member drafts when judging whether the cache is fresh', async () => {
      const { state, env: counted } = countingEnv()
      await countWith(counted, ['election'])
      await seedBill({ title: 'Election Draft', isDraft: true, matchType: null })
      expect(await countWith(counted, ['election'])).toMatchObject({ total: 2, matched: 1 })
      expect(state.billReads).toBe(1)
    })
  })

  it('makes no central calls', async () => {
    await seedBill({ externalId: 'legiscan:1', title: 'Election Reform', matchType: null })
    await summarize(['election'])
    expect(centralFetch).not.toHaveBeenCalled()
  })

  it('refuses a non-admin member', async () => {
    const memberId = await seedUser({ role: 'member', email: 'member@example.com', name: 'Member' })
    const res = await summary(['election'], `session=${await seedSession(memberId)}`)
    expect(res.status).toBe(403)
  })

  it('refuses a request with no session', async () => {
    const res = await app.request('/api/admin/keyword-match-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: ['x'] }),
    }, env)
    expect(res.status).toBe(401)
  })

  it('rejects a body whose keywords are not a list of strings', async () => {
    expect((await summary('election')).status).toBe(400)
    expect((await summary([1, 2])).status).toBe(400)
    expect((await summary(undefined)).status).toBe(400)
  })
})
