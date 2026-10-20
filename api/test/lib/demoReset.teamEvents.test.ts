import { describe, it, expect, vi, beforeEach } from 'vitest'
import { env, SELF } from 'cloudflare:test'
import { clearDb, seedBill, seedUser, seedSession } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS } from '../../src/lib/demoSeeds'
import { LM_COMPANION_BILLS } from '../../src/lib/demoSeeds/lakeMichigan/bills'
import { centralFetch } from '../../src/lib/centralFetch'
import type { FieldChangeEvent } from '../../../shared/teamFields'

// The team-history half of the demo (#861): a reset clears the field changes
// visitors made and writes the seed's, as the `field_changed` team events the
// app itself writes, so the bill page's activity lines render them.

vi.mock('../../src/lib/centralFetch', () => ({ centralFetch: vi.fn() }))

const seed = DEMO_SEEDS['lake-michigan']
const idOf = (externalId: string) => `bill-${externalId}`

// The tracked bills that have a real identical companion (#861), which a group
// will form on once the operator delivers them.
const COMPANION_BILLS = [
  'legiscan:2006749', 'legiscan:1979645', 'legiscan:2006944', 'legiscan:2052600', 'legiscan:2061476',
  'legiscan:1910159', 'legiscan:1933798', 'legiscan:2058690',
]

const rows = async (type?: string) =>
  (await env.DB.prepare(
    `SELECT id, bill_id, type, actor_user_id, metadata, created_at FROM team_events ${type ? 'WHERE type = ?' : ''} ORDER BY created_at, rowid`,
  ).bind(...(type ? [type] : [])).all()).results as Array<{
    id: string; bill_id: string; type: string; actor_user_id: string | null; metadata: string; created_at: string
  }>

async function seedSeedBills() {
  for (const [i, p] of seed.priorities.entries()) {
    await seedBill({ id: idOf(p.externalId), externalId: p.externalId, billNumber: `B${1000 + i}`, title: `Bill ${i}`, state: 'MI', priority: null })
  }
}

describe('demo reset and team field changes', () => {
  beforeEach(async () => {
    await clearDb()
    vi.mocked(centralFetch).mockReset()
    vi.mocked(centralFetch).mockRejectedValue(new Error('central unreachable'))
    await seedSeedBills()
  })

  it('deletes the field changes a visitor made and the grouping lines, which would drift', async () => {
    await runDemoReset(env.DB, seed)
    const bill = idOf('legiscan:2061476')
    for (const [id, type] of [['visitor-fc', 'field_changed'], ['old-grouped', 'grouped'], ['old-split', 'split']]) {
      await env.DB.prepare(`INSERT INTO team_events (id, bill_id, type, actor_user_id, metadata) VALUES (?, ?, ?, 'demo-user', '{}')`)
        .bind(id, bill, type).run()
    }

    await runDemoReset(env.DB, seed)

    // Nothing but the seed's own field changes remains.
    const seedIds = new Set((seed.teamFieldChanges ?? []).map(c => c.id))
    const left = await rows()
    expect(left.length).toBeGreaterThan(0)
    for (const r of left) expect(r.type === 'field_changed' && seedIds.has(r.id), r.id).toBe(true)
  })

  it('writes each seeded change in the shape the app writes, once, however often it resets', async () => {
    await runDemoReset(env.DB, seed)
    await runDemoReset(env.DB, seed)

    const written = await rows('field_changed')
    expect(seed.teamFieldChanges.length).toBeGreaterThanOrEqual(8)
    expect(written).toHaveLength(seed.teamFieldChanges.length)
    for (const c of seed.teamFieldChanges) {
      const row = written.find(r => r.id === c.id)!
      expect(row.bill_id).toBe(idOf(c.externalId))
      expect(row.actor_user_id).toBe(c.userId)
      const meta = JSON.parse(row.metadata) as Record<string, unknown>
      expect(Object.keys(meta).sort()).toEqual(c.field === 'customField'
        ? ['field', 'fieldId', 'label', 'new', 'old']
        : ['field', 'label', 'new', 'old'])
      expect(meta.field).toBe(c.field)
      expect(meta.old).toBe(c.old)
      expect(meta.new).toBe(c.new)
    }
    const label = (id: string) => JSON.parse(written.find(r => r.id === id)!.metadata).label
    const cf = seed.teamFieldChanges.find(c => c.field === 'customField')!
    expect(label(cf.id)).toBe(seed.customFields.find(f => f.id === cf.fieldId)!.name)
    expect(label(seed.teamFieldChanges.find(c => c.field === 'priority')!.id)).toBe('priority')
    expect(label(seed.teamFieldChanges.find(c => c.field === 'position')!.id)).toBe('position')
  })

  it("serves a seeded bill's changes in fieldEvents, newest last, with the persona as actor", async () => {
    await runDemoReset(env.DB, seed)
    const viewer = await seedUser({ role: 'admin' })
    const cookie = `session=${await seedSession(viewer)}`
    const [bill] = COMPANION_BILLS.map(e => seed.teamFieldChanges.filter(c => c.externalId === e)).sort((a, b) => b.length - a.length)
    expect(bill.length).toBeGreaterThanOrEqual(2)

    const res = await SELF.fetch(`https://x/api/bills/${idOf(bill[0].externalId)}`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const { fieldEvents } = await res.json() as { fieldEvents: FieldChangeEvent[] }

    expect(fieldEvents).toHaveLength(bill.length)
    const times = fieldEvents.map(e => Date.parse(e.createdAt.replace(' ', 'T') + 'Z'))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    const persona = new Map(seed.users.map(u => [u.id, u.name]))
    for (const e of fieldEvents) {
      const source = bill.find(c => c.id === e.id)!
      expect(e.actorId).toBe(source.userId)
      expect(e.actorName).toBe(persona.get(source.userId))
      expect(e.old).toBe(source.old)
      expect(e.new).toBe(source.new)
    }
  })

  it('no-ops a seeded change whose bill is not in the tenant', async () => {
    await env.DB.prepare('DELETE FROM bills WHERE id = ?').bind(idOf('legiscan:2006749')).run()
    await runDemoReset(env.DB, seed)
    const missing = seed.teamFieldChanges.filter(c => c.externalId === 'legiscan:2006749')
    expect(missing.length).toBeGreaterThan(0)
    expect(await rows('field_changed')).toHaveLength(seed.teamFieldChanges.length - missing.length)
  })
})

describe('the lake-michigan seed team field changes', () => {
  const changes = seed.teamFieldChanges
  const key = (c: { externalId: string; field: string; fieldId?: string }) => `${c.externalId}|${c.field}|${c.fieldId ?? ''}`
  const chain = (k: string) => changes.filter(c => key(c) === k).sort((a, b) => b.daysAgo - a.daysAgo)

  it('lands several changes on the bills that will be grouped, by several personas', () => {
    const onCompanions = changes.filter(c => COMPANION_BILLS.includes(c.externalId))
    expect(onCompanions.length).toBeGreaterThanOrEqual(6)
    expect(new Set(onCompanions.map(c => c.externalId)).size).toBeGreaterThanOrEqual(4)
    expect(new Set(changes.map(c => c.userId)).size).toBeGreaterThanOrEqual(3)
    expect(new Set(changes.map(c => c.field))).toEqual(new Set(['priority', 'position', 'customField']))
  })

  it("ends each field's history on the value the seed sets", () => {
    expect(changes.length).toBeGreaterThan(0)
    for (const k of new Set(changes.map(key))) {
      const last = chain(k).at(-1)!
      const current =
        last.field === 'priority' ? seed.priorities.find(p => p.externalId === last.externalId)?.priority
        : last.field === 'position' ? seed.positions.find(p => p.externalId === last.externalId)?.position
        : seed.customFieldValues.find(v => v.externalId === last.externalId && v.fieldId === last.fieldId)?.value
      expect(last.new, k).toBe(current)
    }
  })

  it('chains each change from the one before it, from the people the seed names', () => {
    expect(changes.length).toBeGreaterThan(0)
    for (const k of new Set(changes.map(key))) {
      chain(k).forEach((c, i, all) => { if (i > 0) expect(c.old, c.id).toBe(all[i - 1].new) })
    }
    const users = new Set(seed.users.map(u => u.id))
    const fields = new Map(seed.customFields.map(f => [f.id, f]))
    for (const c of changes) {
      expect(users.has(c.userId), c.id).toBe(true)
      if (c.field === 'customField') expect(fields.has(c.fieldId!), c.id).toBe(true)
    }
    expect(new Set(changes.map(c => c.id)).size).toBe(changes.length)
  })

  // The thread sorts comments and activity lines together by time, so a change reads
  // as part of the conversation only when the seed dates it among the comments (#879).
  // `minutesLater` is the sub-day offset that makes same-day ordering possible.
  type Timed = { daysAgo: number; minutesLater?: number }
  const minutesAgo = (t: Timed) => t.daysAgo * 1440 - (t.minutesLater ?? 0)
  const COMPANION_OF = new Map(LM_COMPANION_BILLS.map(c => [c.externalId, c.companionOf]))
  const billsWithChanges = [...new Set(changes.map(c => c.externalId))]
  // A change on a group's tracked bill can be explained by a comment on either bill.
  const groupOf = (externalId: string) =>
    new Set([externalId, ...LM_COMPANION_BILLS.filter(c => c.companionOf === externalId).map(c => c.externalId)])

  it('dates every bill\'s changes among its comments, with a comment before the first change and one after it', () => {
    expect(billsWithChanges.length).toBeGreaterThanOrEqual(8)
    for (const externalId of billsWithChanges) {
      const earliest = Math.max(...changes.filter(c => c.externalId === externalId).map(minutesAgo))
      const times = seed.comments.filter(c => c.externalId === externalId).map(minutesAgo)
      if (times.length < 2) continue
      expect(times.some(t => t > earliest), `${externalId}: a comment before the first change`).toBe(true)
      expect(times.some(t => t < earliest), `${externalId}: a comment after the first change`).toBe(true)
    }
  })

  it('pairs at least two-thirds of the changes with a comment by the same persona within the hour', () => {
    const paired = changes.filter(c => seed.comments.some(m =>
      groupOf(c.externalId).has(m.externalId) && m.userId === c.userId && Math.abs(minutesAgo(m) - minutesAgo(c)) <= 60))
    expect(paired.length / changes.length).toBeGreaterThanOrEqual(2 / 3)
  })

  it('times each seeded priority and position, and the position row, at the change that set it', () => {
    expect(COMPANION_OF.size).toBe(4)
    for (const externalId of billsWithChanges) {
      const priority = chain(key({ externalId, field: 'priority' })).at(-1)
      if (priority) {
        const event = seed.feedEvents.find(e => e.type === 'priority_set' && e.externalId === externalId)!
        expect([event.userId, minutesAgo(event)], `${externalId} priority_set`).toEqual([priority.userId, minutesAgo(priority)])
      }
      const position = chain(key({ externalId, field: 'position' })).at(-1)
      if (position) {
        const event = seed.feedEvents.find(e => e.type === 'position_set' && e.externalId === externalId)!
        expect([event.userId, minutesAgo(event)], `${externalId} position_set`).toEqual([position.userId, minutesAgo(position)])
        const row = seed.positions.find(p => p.externalId === externalId)!
        expect([row.setBy, minutesAgo(row)], `${externalId} official position`).toEqual([position.userId, minutesAgo(position)])
      }
      for (const field of changes.filter(c => c.externalId === externalId && c.field === 'customField')) {
        const value = seed.customFieldValues.find(v => v.externalId === externalId && v.fieldId === field.fieldId)!
        expect(value.daysAgo, `${externalId} ${field.fieldId}`).toBe(field.daysAgo)
      }
    }
  })
})
