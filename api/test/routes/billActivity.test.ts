import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { count, eq } from 'drizzle-orm'
import { resetDb, applyMigrations, seedUser, seedSession, seedBill } from '../helpers'
import { getDb } from '../../src/db/client'
import { comments, customFieldDefinitions, notifications, teamEvents, users } from '../../src/db/schema'
import { syncIdenticalCompanions } from '../../src/lib/companionGroups'
import { centralFetch } from '../../src/lib/centralFetch'

// A bill's team activity, as the bill page's comment thread reads it: every
// field_changed team event a person made on the bill or its companion group,
// oldest first, with the actor's name. The thread shows only changes people
// made, so an older AI tags event (no actor) is left out. Grouped and split
// events stay in groupingEvents.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

type FieldEvent = {
  id: string
  createdAt: string
  actorId: string
  actorName: string
  billId: string
  billNumber: string
  field: string
  fieldId?: string
  label: string
  old: string | string[] | null
  new: string | string[] | null
  fieldType?: string
}
type Detail = {
  fieldEvents: FieldEvent[]
  groupingEvents: Array<{ type: string; actorName: string | null }>
  comments: Array<{ id: string }>
  commentsTotal: number
}

describe('a bill page\'s team activity', () => {
  const cookie: Record<string, string> = {}
  const user: Record<string, string> = {}
  const db = () => getDb(env.DB)

  async function as(name: string, path: string, init: RequestInit = {}) {
    return SELF.fetch(`https://x/api${path}`, {
      ...init,
      headers: { Cookie: cookie[name], 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
  }
  async function detail(billId: string, name = 'ann'): Promise<Detail> {
    const res = await as(name, `/bills/${billId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as Detail
    expect(body).toHaveProperty('fieldEvents')
    return body
  }

  type Change = { field: string; fieldId?: string; label: string; old: string | string[] | null; new: string | string[] | null }
  const priorityChange = (from: string | null, to: string | null): Change => ({ field: 'priority', label: 'priority', old: from, new: to })
  async function fieldEvent(id: string, billId: string, actor: string | null, createdAt: string, change: Change) {
    await db().insert(teamEvents).values({ id, billId, type: 'field_changed', actorUserId: actor, metadata: JSON.stringify(change), createdAt })
  }

  const group = () => syncIdenticalCompanions(db(), 'legiscan:1713', [{ sastBillId: 190, kind: 'identical' }])
  const split = () => syncIdenticalCompanions(db(), 'legiscan:1713', [])

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    for (const [name, role] of [['ann', 'member'], ['ben', 'member'], ['ada', 'admin']] as const) {
      user[name] = await seedUser({ name, email: `${name}@example.com`, role })
      cookie[name] = `session=${await seedSession(user[name])}`
    }
    await db().insert(customFieldDefinitions).values([
      { id: 'cf1', name: 'Committee', slug: 'committee', type: 'dropdown', options: JSON.stringify(['Energy', 'Labor']) },
      { id: 'cf2', name: 'Urgent', slug: 'urgent', type: 'binary' },
    ])
    await seedBill({ id: 'a190', billNumber: 'A190', state: 'NJ', externalId: 'legiscan:190' })
    await seedBill({ id: 'b1713', billNumber: 'S1713', state: 'NJ', externalId: 'legiscan:1713' })
    await seedBill({ id: 'h9', billNumber: 'H9', state: 'NJ', externalId: 'legiscan:9' })
  })

  describe('on a bill in no group', () => {
    it('returns its field changes oldest first, whatever order they were written in, with who made each and what changed', async () => {
      await fieldEvent('e2', 'h9', user.ben, '2026-10-12 12:00:00', priorityChange('medium', 'high'))
      await fieldEvent('e1', 'h9', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'medium'))
      await fieldEvent('e3', 'h9', user.ada, '2026-10-14 12:00:00', { field: 'position', label: 'position', old: 'Support', new: null })
      expect((await detail('h9')).fieldEvents).toEqual([
        { id: 'e1', createdAt: '2026-10-10 12:00:00', actorId: user.ann, actorName: 'ann', billId: 'h9', billNumber: 'H9', field: 'priority', label: 'priority', old: null, new: 'medium' },
        { id: 'e2', createdAt: '2026-10-12 12:00:00', actorId: user.ben, actorName: 'ben', billId: 'h9', billNumber: 'H9', field: 'priority', label: 'priority', old: 'medium', new: 'high' },
        { id: 'e3', createdAt: '2026-10-14 12:00:00', actorId: user.ada, actorName: 'ada', billId: 'h9', billNumber: 'H9', field: 'position', label: 'position', old: 'Support', new: null },
      ])
    })

    it('returns no field changes for a bill with none', async () => {
      expect((await detail('h9')).fieldEvents).toEqual([])
    })

    it('leaves out a tags change, which the AI analysis wrote with no actor before the thread stopped showing them', async () => {
      await fieldEvent('robot', 'h9', null, '2026-10-10 12:00:00', { field: 'tags', label: 'tags', old: [], new: ['Energy', 'Labor'] })
      await fieldEvent('ann-change', 'h9', user.ann, '2026-10-11 12:00:00', priorityChange(null, 'low'))
      expect((await detail('h9')).fieldEvents.map(e => e.id)).toEqual(['ann-change'])
    })

    it('leaves out a tags change even when a person is named as its actor', async () => {
      await fieldEvent('odd', 'h9', user.ann, '2026-10-10 12:00:00', { field: 'tags', label: 'tags', old: ['Energy'], new: ['Labor'] })
      expect((await detail('h9')).fieldEvents).toEqual([])
    })

    it('leaves out a change no one made (no actor), whatever the field', async () => {
      await fieldEvent('system', 'h9', null, '2026-10-10 12:00:00', priorityChange(null, 'high'))
      expect((await detail('h9')).fieldEvents).toEqual([])
    })

    it('breaks a same-second tie by the order the events were written', async () => {
      await fieldEvent('z-first', 'h9', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('a-second', 'h9', user.ann, '2026-10-10 12:00:00', priorityChange('low', 'high'))
      expect((await detail('h9')).fieldEvents.map(e => e.id)).toEqual(['z-first', 'a-second'])
    })

    it('serves the changes the routes record: priority, position, a custom field, and a cleared custom field', async () => {
      expect((await as('ada', '/bills/h9/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })).status).toBe(200)
      expect((await as('ada', '/bills/h9/position', { method: 'POST', body: JSON.stringify({ position: 'Amend' }) })).status).toBe(200)
      expect((await as('ada', '/bills/h9/custom-fields', { method: 'PUT', body: JSON.stringify({ cf1: 'Energy', cf2: '1' }) })).status).toBe(200)
      expect((await as('ada', '/bills/h9/custom-fields', { method: 'PUT', body: JSON.stringify({ cf1: null }) })).status).toBe(200)
      const events = (await detail('h9')).fieldEvents
      expect(events.map(e => [e.field, e.label, e.old, e.new, e.actorName, e.fieldType])).toEqual([
        ['priority', 'priority', null, 'high', 'ada', undefined],
        ['position', 'position', null, 'Amend', 'ada', undefined],
        ['customField', 'Committee', null, 'Energy', 'ada', 'dropdown'],
        ['customField', 'Urgent', null, '1', 'ada', 'binary'],
        ['customField', 'Committee', 'Energy', null, 'ada', 'dropdown'],
      ])
    })

    it("gives a custom field's id, and leaves out the id of a field that has none", async () => {
      await fieldEvent('e1', 'h9', user.ann, '2026-10-10 12:00:00', { field: 'customField', fieldId: 'cf1', label: 'Committee', old: null, new: 'Labor' })
      await fieldEvent('e2', 'h9', user.ann, '2026-10-11 12:00:00', priorityChange(null, 'low'))
      const [cf, pr] = (await detail('h9')).fieldEvents
      expect(cf.fieldId).toBe('cf1')
      expect('fieldId' in pr).toBe(false)
    })

    it('keeps the name a custom field had when it was set, with no type, after the field is deleted', async () => {
      await fieldEvent('e1', 'h9', user.ann, '2026-10-10 12:00:00', { field: 'customField', fieldId: 'gone', label: 'Old committee', old: null, new: 'Labor' })
      const [e] = (await detail('h9')).fieldEvents
      expect(e).toMatchObject({ label: 'Old committee', fieldId: 'gone', new: 'Labor' })
      expect(e.fieldType).toBeUndefined()
    })

    it('shows the same changes to a member and an admin', async () => {
      await fieldEvent('e1', 'h9', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'high'))
      const asMember = (await detail('h9', 'ann')).fieldEvents
      expect(asMember).toHaveLength(1)
      expect((await detail('h9', 'ada')).fieldEvents).toEqual(asMember)
      expect((await detail('h9', 'ben')).fieldEvents).toEqual(asMember)
    })

    it('returns no event of another type, and none of another bill', async () => {
      await db().insert(teamEvents).values({ id: 'x1', billId: 'h9', type: 'something_else', actorUserId: user.ann, metadata: '{}', createdAt: '2026-10-10 12:00:00' })
      await fieldEvent('other', 'a190', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      expect((await detail('h9')).fieldEvents).toEqual([])
    })

    it('skips an event whose metadata cannot be read instead of failing the page', async () => {
      await db().insert(teamEvents).values({ id: 'bad', billId: 'h9', type: 'field_changed', actorUserId: user.ann, metadata: 'not json', createdAt: '2026-10-10 12:00:00' })
      await fieldEvent('good', 'h9', user.ann, '2026-10-11 12:00:00', priorityChange(null, 'low'))
      expect((await detail('h9')).fieldEvents.map(e => e.id)).toEqual(['good'])
    })
  })

  // A member's activity is hidden from member-facing surfaces while they are deactivated (lib/accountDeletion.ts),
  // as their comments are.
  describe('by a deactivated member', () => {
    const deactivate = (name: string) => db().update(users).set({ deactivatedAt: '2026-10-13 12:00:00' }).where(eq(users.id, user[name])).run()
    const reactivate = (name: string) => db().update(users).set({ deactivatedAt: null }).where(eq(users.id, user[name])).run()

    it('hides their field changes, as it hides their comments, and shows an active member\'s', async () => {
      await db().insert(comments).values({ id: 'c-ben', billId: 'h9', userId: user.ben, content: '<p>x</p>', createdAt: '2026-10-10 11:00:00' })
      await fieldEvent('ben-change', 'h9', user.ben, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('ann-change', 'h9', user.ann, '2026-10-11 12:00:00', priorityChange('low', 'high'))
      await deactivate('ben')
      const d = await detail('h9', 'ann')
      expect(d.comments.map(c => c.id)).toEqual([])
      expect(d.fieldEvents.map(e => e.id)).toEqual(['ann-change'])
    })

    it('shows them again once the member is reactivated', async () => {
      await fieldEvent('ben-change', 'h9', user.ben, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await deactivate('ben')
      expect((await detail('h9')).fieldEvents).toEqual([])
      await reactivate('ben')
      expect((await detail('h9')).fieldEvents.map(e => e.id)).toEqual(['ben-change'])
    })

    it('leaves them out of a companion group\'s changes too, and still leaves out the AI\'s tags', async () => {
      await group()
      await fieldEvent('ben-on-companion', 'b1713', user.ben, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('ann-on-companion', 'b1713', user.ann, '2026-10-10 13:00:00', priorityChange('low', 'high'))
      await fieldEvent('robot', 'b1713', null, '2026-10-11 12:00:00', { field: 'tags', label: 'tags', old: [], new: ['Energy'] })
      await deactivate('ben')
      expect((await detail('a190')).fieldEvents.map(e => e.id)).toEqual(['ann-on-companion'])
    })

    it('does not count them in what is served, so a run of three with one of them hidden is two', async () => {
      await fieldEvent('a1', 'h9', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('b1', 'h9', user.ben, '2026-10-10 13:00:00', priorityChange('low', 'medium'))
      await fieldEvent('a2', 'h9', user.ann, '2026-10-10 14:00:00', priorityChange('medium', 'high'))
      await deactivate('ben')
      expect((await detail('h9')).fieldEvents.map(e => e.id)).toEqual(['a1', 'a2'])
    })

    it('leaves an active member\'s changes as they were', async () => {
      await fieldEvent('ann-change', 'h9', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await deactivate('ben')
      expect((await detail('h9')).fieldEvents.map(e => [e.id, e.actorName])).toEqual([['ann-change', 'ann']])
    })
  })

  describe('on a bill in a companion group', () => {
    beforeEach(async () => { await group() })

    it("returns the group's changes made on either bill, oldest first, each naming the bill where it was set", async () => {
      await fieldEvent('own', 'a190', user.ann, '2026-10-12 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('companion', 'b1713', user.ben, '2026-10-11 12:00:00', priorityChange('low', 'high'))
      for (const id of ['a190', 'b1713']) {
        expect((await detail(id)).fieldEvents.map(e => [e.id, e.billId, e.billNumber])).toEqual([
          ['companion', 'b1713', 'S1713'],
          ['own', 'a190', 'A190'],
        ])
      }
    })

    it("leaves out another group's changes and an ungrouped bill's", async () => {
      await fieldEvent('mine', 'a190', user.ann, '2026-10-10 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('stranger', 'h9', user.ann, '2026-10-10 13:00:00', priorityChange(null, 'low'))
      expect((await detail('a190')).fieldEvents.map(e => e.id)).toEqual(['mine'])
    })

    it('stops returning a companion\'s changes once the group splits, and takes them back when it forms again', async () => {
      await fieldEvent('own', 'a190', user.ann, '2026-10-12 12:00:00', priorityChange(null, 'low'))
      await fieldEvent('companion', 'b1713', user.ben, '2026-10-11 12:00:00', priorityChange(null, 'high'))
      await split()
      expect((await detail('a190')).fieldEvents.map(e => e.id)).toEqual(['own'])
      expect((await detail('b1713')).fieldEvents.map(e => e.id)).toEqual(['companion'])
      await group()
      expect((await detail('a190')).fieldEvents.map(e => e.id)).toEqual(['companion', 'own'])
    })

    it('returns one change, the bill\'s own, when a bulk edit of both bills recorded the same change on each', async () => {
      await fieldEvent('on-companion', 'b1713', user.ann, '2026-10-12 12:00:00', priorityChange('low', 'high'))
      await fieldEvent('on-own', 'a190', user.ann, '2026-10-12 12:00:00', priorityChange('low', 'high'))
      expect((await detail('a190')).fieldEvents.map(e => [e.id, e.billId])).toEqual([['on-own', 'a190']])
      expect((await detail('b1713')).fieldEvents.map(e => [e.id, e.billId])).toEqual([['on-companion', 'b1713']])
    })

    it('keeps both changes when they differ in who, when, or what', async () => {
      await fieldEvent('a1', 'a190', user.ann, '2026-10-12 12:00:00', priorityChange('low', 'high'))
      await fieldEvent('b-who', 'b1713', user.ben, '2026-10-12 12:00:00', priorityChange('low', 'high'))
      await fieldEvent('b-when', 'b1713', user.ann, '2026-10-12 12:00:01', priorityChange('low', 'high'))
      await fieldEvent('b-what', 'b1713', user.ann, '2026-10-12 12:00:00', priorityChange('low', 'medium'))
      await fieldEvent('b-field', 'b1713', user.ann, '2026-10-12 12:00:00', { field: 'position', label: 'position', old: 'low', new: 'high' })
      expect((await detail('a190')).fieldEvents.map(e => e.id).sort()).toEqual(['a1', 'b-field', 'b-what', 'b-when', 'b-who'])
    })

    it('keeps grouped and split events in groupingEvents only, and does not repeat a companion\'s', async () => {
      await split()
      await group()
      await fieldEvent('f1', 'b1713', user.ann, '2026-10-12 12:00:00', priorityChange(null, 'low'))
      const d = await detail('a190')
      expect(d.groupingEvents.map(e => e.type)).toEqual(['grouped', 'split', 'grouped'])
      expect(d.fieldEvents.map(e => e.id)).toEqual(['f1'])
    })
  })

  describe('beside comments and notifications', () => {
    it('leaves the comment count a count of comments, and returns a deleted comment nowhere', async () => {
      await db().insert(comments).values([
        { id: 'c1', billId: 'h9', userId: user.ann, content: '<p>one</p>', createdAt: '2026-10-10 12:00:00' },
        { id: 'c2', billId: 'h9', userId: user.ann, content: '<p>two</p>', createdAt: '2026-10-11 12:00:00', deletedAt: '2026-10-11 13:00:00', deletedBy: user.ann },
      ])
      await fieldEvent('e1', 'h9', user.ann, '2026-10-10 13:00:00', priorityChange(null, 'low'))
      await fieldEvent('e2', 'h9', user.ann, '2026-10-12 13:00:00', priorityChange('low', 'high'))
      const d = await detail('h9')
      expect(d.comments.map(c => c.id)).toEqual(['c1'])
      expect(d.commentsTotal).toBe(1)
      expect(d.fieldEvents.map(e => e.id)).toEqual(['e1', 'e2'])
    })

    it('sends no notification for a change, or for reading the page', async () => {
      expect((await as('ada', '/bills/h9/priority', { method: 'PATCH', body: JSON.stringify({ priority: 'high' }) })).status).toBe(200)
      await detail('h9', 'ann')
      expect((await db().select({ n: count() }).from(notifications).get())?.n).toBe(0)
      expect((await db().select({ n: count() }).from(teamEvents).where(eq(teamEvents.type, 'field_changed')).get())?.n).toBe(1)
    })
  })
})
