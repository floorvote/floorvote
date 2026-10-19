import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb, appFetch, seedUser, seedSession } from '../helpers'

// #449: a member includes a saved view in their digest. The subscription is the
// member's own and rides on the view: one row per member and view, removed with
// either. Seam: the routes over HTTP.

type Dto = { id: string; name: string; subscribed: boolean }

describe('saved view digest subscriptions', () => {
  let adminCookie: string
  let ada: string
  let adaCookie: string
  let ben: string
  let benCookie: string

  beforeEach(async () => {
    await clearDb()
    const admin = await seedUser({ role: 'admin', email: 'admin@example.com' })
    adminCookie = `session=${await seedSession(admin)}`
    ada = await seedUser({ role: 'member', email: 'ada@example.com' })
    adaCookie = `session=${await seedSession(ada)}`
    ben = await seedUser({ role: 'member', email: 'ben@example.com' })
    benCookie = `session=${await seedSession(ben)}`
    await env.DB.prepare(`INSERT INTO saved_views (id, name, query, slug, created_by, display_order) VALUES ('v1', 'Transportation', 'state=RI', 'transportation', ?, 0), ('v2', 'Elections', 'state=UT', 'elections', ?, 1)`).bind(admin, admin).run()
  })

  const put = (id: string, subscribed: unknown, cookie = adaCookie) =>
    appFetch(`/api/views/${id}/subscription`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ subscribed }) })
  const views = async (cookie = adaCookie) =>
    ((await (await appFetch('/api/views', { headers: { Cookie: cookie } })).json()) as { views: Dto[] }).views
  const subscribedIds = async (cookie = adaCookie) => (await views(cookie)).filter(v => v.subscribed).map(v => v.id)

  it('lists every view as not subscribed until the member subscribes', async () => {
    expect((await views()).map(v => [v.id, v.subscribed])).toEqual([['v1', false], ['v2', false]])
  })

  it('subscribes a member to a view, and the list says so', async () => {
    const res = await put('v1', true)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subscribed: true })
    expect(await subscribedIds()).toEqual(['v1'])
  })

  it('unsubscribes through the same route', async () => {
    await put('v1', true)
    const res = await put('v1', false)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subscribed: false })
    expect(await subscribedIds()).toEqual([])
  })

  it('is idempotent: subscribing twice or unsubscribing a view never subscribed to both succeed', async () => {
    expect((await put('v1', true)).status).toBe(200)
    expect((await put('v1', true)).status).toBe(200)
    expect(await subscribedIds()).toEqual(['v1'])
    expect((await put('v2', false)).status).toBe(200)
    expect(await subscribedIds()).toEqual(['v1'])
  })

  it('keeps one member\'s subscriptions to themselves', async () => {
    expect((await put('v1', true)).status).toBe(200)
    expect(await subscribedIds(adaCookie)).toEqual(['v1'])
    expect(await subscribedIds(benCookie)).toEqual([])
    expect((await put('v2', true, benCookie)).status).toBe(200)
    expect(await subscribedIds(adaCookie)).toEqual(['v1'])
    expect(await subscribedIds(benCookie)).toEqual(['v2'])
  })

  it('lets an admin subscribe too', async () => {
    expect((await put('v1', true, adminCookie)).status).toBe(200)
    expect(await subscribedIds(adminCookie)).toEqual(['v1'])
  })

  it('refuses a view that does not exist, and subscribes to nothing', async () => {
    const res = await put('no-such-view', true)
    expect(res.status).toBe(404)
    expect(await subscribedIds()).toEqual([])
  })

  it('refuses a view that was deleted', async () => {
    await put('v1', true)
    expect((await appFetch('/api/admin/views/v1', { method: 'DELETE', headers: { Cookie: adminCookie } })).status).toBe(204)
    expect((await put('v1', true)).status).toBe(404)
    expect((await put('v1', false)).status).toBe(404)
  })

  it('refuses a request without a session', async () => {
    const res = await appFetch('/api/views/v1/subscription', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscribed: true }) })
    expect(res.status).toBe(401)
  })

  it.each([[undefined], ['yes'], [1], [null]])('refuses a body whose subscribed is %j', async (bad) => {
    const res = await put('v1', bad)
    expect(res.status).toBe(400)
    expect(await subscribedIds()).toEqual([])
  })

  it('removes every subscriber\'s subscription when the view is deleted', async () => {
    await put('v1', true); await put('v1', true, benCookie); await put('v2', true)
    expect((await appFetch('/api/admin/views/v1', { method: 'DELETE', headers: { Cookie: adminCookie } })).status).toBe(204)
    const rows = await env.DB.prepare('SELECT view_id, user_id FROM saved_view_subscriptions ORDER BY view_id').all()
    expect(rows.results).toEqual([{ view_id: 'v2', user_id: ada }])
    expect(await subscribedIds(adaCookie)).toEqual(['v2'])
    expect(await subscribedIds(benCookie)).toEqual([])
  })

  it('keeps a subscription through a rename and a filter change, since it rides on the view', async () => {
    await put('v1', true)
    await appFetch('/api/admin/views/v1', { method: 'PUT', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Roads', query: 'state=UT' }) })
    expect(await subscribedIds()).toEqual(['v1'])
  })
})
