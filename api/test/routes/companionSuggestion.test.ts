import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { asc, eq } from 'drizzle-orm'
import { app } from '../../src/index'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { billGroupOverrides, bills, companionSuggestionDismissals, teamEvents } from '../../src/db/schema'
import { centralFetch } from '../../src/lib/centralFetch'

// Companion suggestions from matching titles (#521). On an admin's bill page,
// when another bill in the instance has the same title key (central's key for
// the bill's type and normalized title, served only in opted-in states), is in
// the same session and the other chamber, and is the only such bill, the page
// offers "Possibly the same as S2505. Group them?". Accepting is the manual
// "Group with…" action itself (POST /bills/:id/group). Dismissing keeps the
// pair from ever being suggested again on this instance.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

const KEY = 'B|an act relating to elections and the registration of voters'
const OTHER_KEY = 'B|an act relating to the licensing of commercial fishing vessels'

type Suggestion = { billId: string; billNumber: string; state: string; sessionSlug: string | null } | null
type Detail = { companionSuggestion?: Suggestion; groupBills: Array<{ billId: string }> }

describe('companion suggestions from matching titles', () => {
  const cookie: Record<string, string> = {}
  const user: Record<string, string> = {}
  const db = () => getDb(env.DB)
  const send = vi.fn()
  let envOverrides: Record<string, unknown> = {}
  const testEnv = () => ({ ...env, TENANT_ID: 'test-org', BILL_QUEUE: { send, sendBatch: vi.fn() }, ...envOverrides }) as unknown as typeof env

  // What central serves for each bill on a page view, by handle: the title key it
  // computes from the bill's provider vocabulary today, and the chamber.
  const central = new Map<string, { titleKey: string | null; body: string | null }>()

  async function as(name: string, path: string, init: RequestInit = {}) {
    return app.request(`/api${path}`, {
      ...init,
      headers: { Cookie: cookie[name], 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    }, testEnv())
  }
  async function detail(billId: string, name = 'ada'): Promise<Detail> {
    const res = await as(name, `/bills/${billId}`)
    expect(res.status).toBe(200)
    return await res.json() as Detail
  }
  const suggestionOn = async (billId: string, name = 'ada') => (await detail(billId, name)).companionSuggestion
  const groupWith = (name: string, billId: string, withBillId: string) =>
    as(name, `/bills/${billId}/group`, { method: 'POST', body: JSON.stringify({ withBillId }) })
  const dismiss = (name: string, billId: string, withBillId: unknown) =>
    as(name, `/bills/${billId}/companion-suggestion/dismiss`, { method: 'POST', body: JSON.stringify({ withBillId }) })

  /**
   * A bill as a delivery from central leaves it: its title key and chamber
   * stored, and the same served by central on a page view.
   */
  async function bill(id: string, opts: {
    number: string
    chamber: string | null
    key?: string | null
    centralKey?: string | null
    sessionId?: string
    matchType?: 'keyword' | 'manual' | null
    state?: string
  }) {
    const handle = `legiscan:${id.replace(/\D/g, '')}`
    await seedBill({
      id, billNumber: opts.number, state: opts.state ?? 'PA', externalId: handle,
      sessionId: opts.sessionId ?? 'pa:2026', sessionSlug: '2025-2026',
      matchType: opts.matchType === undefined ? 'keyword' : opts.matchType,
    })
    const key = opts.key === undefined ? KEY : opts.key
    await env.DB.prepare('UPDATE bills SET title_key = ?, chamber = ? WHERE id = ?').bind(key, opts.chamber, id).run()
    central.set(handle, { titleKey: opts.centralKey === undefined ? key : opts.centralKey, body: opts.chamber })
  }

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    send.mockReset()
    envOverrides = {}
    central.clear()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockImplementation(async (_env, path: string) => {
      const id = /\/bills\/(?:legiscan:)?(\d+)/.exec(path)?.[1]
      const served = id ? central.get(`legiscan:${id}`) : undefined
      return new Response(JSON.stringify(served ?? {}), { status: 200 })
    })
    for (const [name, role] of [['ann', 'member'], ['ada', 'admin'], ['olive', 'owner'], ['abe', 'admin']] as const) {
      user[name] = await seedUser({ name, email: `${name}@example.com`, role })
      cookie[name] = `session=${await seedSession(user[name])}`
    }
  })

  describe('a matching pair', () => {
    it('is suggested on each bill\'s page, naming the other', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect(await suggestionOn('h100')).toEqual({ billId: 's200', billNumber: 'SB200', state: 'PA', sessionSlug: '2025-2026' })
      expect(await suggestionOn('s200')).toEqual({ billId: 'h100', billNumber: 'HB100', state: 'PA', sessionSlug: '2025-2026' })
    })

    it('is suggested to an owner too', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect(await suggestionOn('h100', 'olive')).toEqual(expect.objectContaining({ billId: 's200' }))
    })

    it('is suggested when only one of the two bills is tracked', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S', matchType: null })
      expect(await suggestionOn('h100')).toEqual(expect.objectContaining({ billId: 's200' }))
      expect(await suggestionOn('s200')).toEqual(expect.objectContaining({ billId: 'h100' }))
    })

    it('is suggested in an Assembly and Senate legislature, since any two chambers count', async () => {
      await bill('a100', { number: 'A100', chamber: 'A' })
      await bill('s200', { number: 'S200', chamber: 'S' })
      expect(await suggestionOn('a100')).toEqual(expect.objectContaining({ billId: 's200' }))
    })
  })

  describe('no suggestion', () => {
    // Each case is a variation of the matching pair, so each control shows the pair would be suggested otherwise.
    async function pair() {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect(await suggestionOn('h100')).toEqual(expect.objectContaining({ billId: 's200' }))
    }

    it('for a standard member, who never sees the suggestion', async () => {
      await pair()
      const res = await detail('h100', 'ann')
      expect(res.companionSuggestion ?? null).toBeNull()
    })

    it('when a third bill shares the title', async () => {
      await pair()
      await bill('s300', { number: 'SB300', chamber: 'S' })
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
      expect(await suggestionOn('s300')).toBeNull()
    })

    it('when many bills share the title', async () => {
      await pair()
      for (let i = 3; i <= 9; i++) await bill(`s${i}00`, { number: `SB${i}00`, chamber: i % 2 ? 'S' : 'H' })
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for two bills in the same chamber', async () => {
      await pair()
      await env.DB.prepare("UPDATE bills SET chamber = 'H' WHERE id = 's200'").run()
      central.set('legiscan:200', { titleKey: KEY, body: 'H' })
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a pair in different sessions', async () => {
      await pair()
      await env.DB.prepare("UPDATE bills SET session_id = 'pa:2024' WHERE id = 's200'").run()
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a pair of different bill types, whose keys differ', async () => {
      await pair()
      await env.DB.prepare("UPDATE bills SET title_key = 'CB|an act relating to elections and the registration of voters' WHERE id = 's200'").run()
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a pair whose titles differ', async () => {
      await pair()
      await env.DB.prepare('UPDATE bills SET title_key = ? WHERE id = ?').bind(OTHER_KEY, 's200').run()
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a pair in different states with the same session id', async () => {
      await pair()
      await env.DB.prepare("UPDATE bills SET state = 'ZZ' WHERE id = 's200'").run()
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a pair already grouped', async () => {
      await pair()
      expect((await groupWith('ada', 'h100', 's200')).status).toBe(200)
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('for a bill already in a group with another bill, on either page', async () => {
      await pair()
      await bill('s300', { number: 'SB300', chamber: 'S', key: OTHER_KEY })
      expect((await groupWith('ada', 'h100', 's300')).status).toBe(200)
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('for a pair an admin split', async () => {
      await pair()
      expect((await groupWith('ada', 'h100', 's200')).status).toBe(200)
      expect((await as('ada', '/bills/h100/split', { method: 'POST' })).status).toBe(200)
      expect((await detail('h100')).groupBills.map(b => b.billId)).toEqual(['h100'])
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('for a dismissed pair', async () => {
      await pair()
      expect((await dismiss('ada', 'h100', 's200')).status).toBe(200)
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('for a pair where neither bill is tracked', async () => {
      await pair()
      await env.DB.prepare('UPDATE bills SET match_type = NULL').run()
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('when central serves the bill no key, as for a state not opted in, even if a key is still stored', async () => {
      await pair()
      // A state opted out since the last delivery: the stored keys still match, but central's read today says no.
      central.set('legiscan:100', { titleKey: null, body: 'H' })
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a resolution, which central serves no key', async () => {
      await bill('h100', { number: 'HR100', chamber: 'H', key: null })
      await bill('s200', { number: 'SR200', chamber: 'S', key: null })
      await bill('h300', { number: 'HB300', chamber: 'H' })
      await bill('s400', { number: 'SB400', chamber: 'S' })
      expect(await suggestionOn('h300')).toEqual(expect.objectContaining({ billId: 's400' }))
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('when central can\'t be reached', async () => {
      await pair()
      vi.mocked(centralFetch).mockResolvedValue(new Response('down', { status: 503 }))
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('on a demo instance, where grouping by hand is denied', async () => {
      await pair()
      envOverrides = { DEMO_MODE: 'true' }
      expect(await suggestionOn('h100')).toBeNull()
    })

    it('for a bill whose companion has no stored key yet, as before its next delivery', async () => {
      await pair()
      await env.DB.prepare('UPDATE bills SET title_key = NULL WHERE id = ?').bind('s200').run()
      expect(await suggestionOn('h100')).toBeNull()
    })
  })

  describe('accepting', () => {
    it('groups the pair exactly as "Group with…" does: a link override and grouping events naming the admin', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      const suggestion = await suggestionOn('h100')
      expect(suggestion).toEqual(expect.objectContaining({ billId: 's200' }))

      const res = await groupWith('ada', 'h100', suggestion!.billId)
      expect(res.status).toBe(200)
      expect((await res.json() as { groupBills: Array<{ billId: string }> }).groupBills.map(b => b.billId)).toEqual(['h100', 's200'])

      expect(await db().select({ billId: billGroupOverrides.billId, otherBillId: billGroupOverrides.otherBillId, kind: billGroupOverrides.kind, actor: billGroupOverrides.actorUserId })
        .from(billGroupOverrides).all()).toEqual([{ billId: 'h100', otherBillId: 's200', kind: 'link', actor: user.ada }])
      const events = await db().select({ billId: teamEvents.billId, type: teamEvents.type, actor: teamEvents.actorUserId })
        .from(teamEvents).orderBy(asc(teamEvents.billId)).all()
      expect(events).toEqual([
        { billId: 'h100', type: 'grouped', actor: user.ada },
        { billId: 's200', type: 'grouped', actor: user.ada },
      ])
      const keys = await db().select({ id: bills.id, k: bills.groupKey }).from(bills).orderBy(asc(bills.id)).all()
      expect(keys).toEqual([{ id: 'h100', k: 'h100' }, { id: 's200', k: 'h100' }])
    })

    it('from both pages at once, by two admins, groups the pair once', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      const [a, b] = await Promise.all([groupWith('ada', 'h100', 's200'), groupWith('abe', 's200', 'h100')])
      // Whichever lands second finds the two already one group, or finds nothing left to do.
      expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([200]))
      for (const s of [a.status, b.status]) expect([200, 409]).toContain(s)
      expect(await db().select().from(billGroupOverrides).all()).toHaveLength(1)
      const keys = await db().select({ id: bills.id, k: bills.groupKey }).from(bills).orderBy(asc(bills.id)).all()
      expect(keys).toEqual([{ id: 'h100', k: 'h100' }, { id: 's200', k: 'h100' }])
      const events = await db().select({ billId: teamEvents.billId, type: teamEvents.type }).from(teamEvents).all()
      expect(events.filter(e => e.billId === 'h100')).toEqual([{ billId: 'h100', type: 'grouped' }])
      expect(events.filter(e => e.billId === 's200')).toEqual([{ billId: 's200', type: 'grouped' }])
      expect(await suggestionOn('h100')).toBeNull()
    })
  })

  describe('dismissing', () => {
    it('removes the suggestion for that pair, and keeps it removed through later deliveries', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect((await dismiss('ada', 's200', 'h100')).status).toBe(200)
      expect(await db().select({ billId: companionSuggestionDismissals.billId, otherBillId: companionSuggestionDismissals.otherBillId, actor: companionSuggestionDismissals.actorUserId })
        .from(companionSuggestionDismissals).all()).toEqual([{ billId: 'h100', otherBillId: 's200', actor: user.ada }])
      // A later delivery rewrites the keys as they were. The dismissal stands.
      await env.DB.prepare('UPDATE bills SET title_key = ?').bind(KEY).run()
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('s200')).toBeNull()
    })

    it('leaves another pair suggested', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      await bill('h300', { number: 'HB300', chamber: 'H', key: OTHER_KEY })
      await bill('s400', { number: 'SB400', chamber: 'S', key: OTHER_KEY })
      expect((await dismiss('ada', 'h100', 's200')).status).toBe(200)
      expect(await suggestionOn('h100')).toBeNull()
      expect(await suggestionOn('h300')).toEqual(expect.objectContaining({ billId: 's400' }))
    })

    it('doesn\'t keep the bills from being grouped by hand', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect((await dismiss('ada', 'h100', 's200')).status).toBe(200)
      expect((await groupWith('ada', 'h100', 's200')).status).toBe(200)
    })

    it('is idempotent', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect((await dismiss('ada', 'h100', 's200')).status).toBe(200)
      expect((await dismiss('abe', 's200', 'h100')).status).toBe(200)
      expect(await db().select().from(companionSuggestionDismissals).all()).toHaveLength(1)
    })

    it('goes with either bill when it is deleted', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect((await dismiss('ada', 'h100', 's200')).status).toBe(200)
      await env.DB.prepare('PRAGMA foreign_keys = ON').run()
      await db().delete(bills).where(eq(bills.id, 's200'))
      expect(await db().select().from(companionSuggestionDismissals).all()).toEqual([])
    })

    it('is refused to a standard member', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      await bill('s200', { number: 'SB200', chamber: 'S' })
      expect((await dismiss('ann', 'h100', 's200')).status).toBe(403)
      expect(await db().select().from(companionSuggestionDismissals).all()).toEqual([])
    })

    it('is refused for a missing bill, the bill itself, or no bill named', async () => {
      await bill('h100', { number: 'HB100', chamber: 'H' })
      expect((await dismiss('ada', 'h100', 'nope')).status).toBe(404)
      expect((await dismiss('ada', 'nope', 'h100')).status).toBe(404)
      expect((await dismiss('ada', 'h100', 'h100')).status).toBe(400)
      expect((await dismiss('ada', 'h100', undefined)).status).toBe(400)
      expect(await db().select().from(companionSuggestionDismissals).all()).toEqual([])
    })
  })
})
