import { describe, it, expect } from 'vitest'
import { DEMO_SEEDS, resolveDemoSeed } from '../../src/lib/demoSeeds'
import { LM_BILLS } from '../../src/lib/demoSeeds/lakeMichigan/bills'
import { stripHtml, truncateWithEllipsis, COMMENT_PREVIEW_MAX } from '../../../shared/feedUtils'

describe('lake-michigan seed registration', () => {
  it('is registered under its slug', () => {
    const s = DEMO_SEEDS['lake-michigan']
    expect(s).toBeDefined()
    expect(s.slug).toBe('lake-michigan')
    expect(resolveDemoSeed('lake-michigan')).toBe(s)
  })

  it('is a multi-state seed covering the four states plus Congress', () => {
    expect(DEMO_SEEDS['lake-michigan'].stateCoverage).toEqual(['MI', 'WI', 'IL', 'IN', 'US'])
  })

  it('names the organization without the Demo prefix (the machinery adds it)', () => {
    const n = DEMO_SEEDS['lake-michigan'].associationName
    expect(n).toBe('Lake Michigan Alliance')
    expect(n).not.toContain('Demo')
  })

  it('carries one session per covered jurisdiction, with LegiScan identifiers', () => {
    const ids = DEMO_SEEDS['lake-michigan'].sessions.data.map(s => s.identifier).sort()
    // WI is 2197 (2025-2026 Regular Session), NOT 2264 (May 2026 special session).
    expect(ids).toEqual(['2176', '2183', '2197', '2199', '2234'])
  })

  it('tells the visitor it is read-only and fictional', () => {
    const b = DEMO_SEEDS['lake-michigan'].bannerText
    expect(b).toMatch(/read-only/i)
    expect(b).toMatch(/fictional/i)
  })

  it('ships no keyword that is empty or duplicated', () => {
    const k = DEMO_SEEDS['lake-michigan'].keywords
    expect(k.length).toBeGreaterThan(10)
    expect(k.every(x => x.trim().length > 0)).toBe(true)
    expect(new Set(k).size).toBe(k.length)
  })

  it('offers the standard position vocabulary', () => {
    expect(DEMO_SEEDS['lake-michigan'].positionVocabulary)
      .toEqual(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
  })

  it('leaves the optional widgets off so a visitor can turn them on', () => {
    const m = DEMO_SEEDS['lake-michigan'].modules
    expect(m['waiting-for-vote']).toBe(false)
    expect(m['upcoming-hearings']).toBe(false)
    expect(m['calendar']).toBe(true)
  })
})

describe('lake-michigan roster', () => {
  const s = DEMO_SEEDS['lake-michigan']

  it('has 15 staff, one of them the shared demo visitor account', () => {
    expect(s.users).toHaveLength(15)
    expect(s.users.filter(u => u.id === 'demo-user')).toHaveLength(1)
  })

  it('gives everyone a plain job title, not a Title · Org compound', () => {
    for (const u of s.users) {
      expect(u.subtitle.length).toBeGreaterThan(3)
      expect(u.subtitle).not.toContain('·')
    }
  })

  it('has three admins and the rest members', () => {
    expect(s.users.filter(u => u.role === 'admin')).toHaveLength(3)
  })

  it('has five jurisdiction teams and three single-word working groups', () => {
    const names = s.roles.map(r => r.name)
    expect(s.roles).toHaveLength(8)
    for (const t of ['Michigan Team', 'Wisconsin Team', 'Illinois Team', 'Indiana Team', 'Federal Team']) {
      expect(names).toContain(t)
    }
    for (const g of ['Infrastructure', 'Contaminants', 'Habitat']) {
      expect(names).toContain(g)
      expect(g.split(' ')).toHaveLength(1)
    }
  })

  it('puts every person on exactly one jurisdiction team', () => {
    const jur = new Set(s.roles.filter(r => r.name.endsWith(' Team')).map(r => r.id))
    for (const u of s.users) {
      const mine = s.userRoles.filter(ur => ur.userId === u.id && jur.has(ur.roleId))
      expect(mine, `${u.id} jurisdiction teams`).toHaveLength(1)
    }
  })

  it('references only real user and role ids in userRoles', () => {
    const uids = new Set(s.users.map(u => u.id))
    const rids = new Set(s.roles.map(r => r.id))
    for (const ur of s.userRoles) {
      expect(uids.has(ur.userId), `user ${ur.userId}`).toBe(true)
      expect(rids.has(ur.roleId), `role ${ur.roleId}`).toBe(true)
    }
  })

  it('defines five custom fields with Policy Concerns pinned', () => {
    expect(s.customFields).toHaveLength(5)
    const pinned = s.customFields.filter(f => f.pinned)
    expect(pinned).toHaveLength(1)
    expect(pinned[0].name).toBe('Policy Concerns')
    // The Working Group field and the working-group roles are meant to be ONE
    // vocabulary, so derive the expectation from the roles rather than restating a
    // literal — otherwise renaming a role leaves this passing while the two drift.
    const wg = s.customFields.find(f => f.slug === 'working-group')!
    const workingGroupRoles = s.roles.filter(r => !r.name.endsWith(' Team')).map(r => r.name)
    expect(workingGroupRoles).toHaveLength(3)
    expect(wg.options).toEqual(workingGroupRoles)
  })

  it('gives dropdowns options and non-dropdowns none', () => {
    for (const f of s.customFields) {
      if (f.type === 'dropdown') expect(Array.isArray(f.options)).toBe(true)
      else expect(f.options).toBeNull()
    }
  })
})

describe('lake-michigan bills', () => {
  const s = DEMO_SEEDS['lake-michigan']
  const extIds = () => s.priorities.map(p => p.externalId)

  it('tracks 20 bills, every one with a priority', () => {
    expect(s.priorities).toHaveLength(20)
    for (const p of s.priorities) {
      expect(['high', 'medium', 'low']).toContain(p.priority)
      expect(p.externalId).toMatch(/^legiscan:\d+$/)
    }
    expect(new Set(extIds()).size).toBe(20)
  })

  it('spans all five jurisdictions', () => {
    const byJur = new Map<string, number>()
    for (const b of LM_BILLS) byJur.set(b.jurisdiction, (byJur.get(b.jurisdiction) ?? 0) + 1)
    expect([...byJur.keys()].sort()).toEqual(['IL', 'IN', 'MI', 'US', 'WI'])
    expect(byJur.get('MI')).toBe(5)
    expect(byJur.get('WI')).toBe(4)
    expect(byJur.get('IL')).toBe(4)
    expect(byJur.get('IN')).toBe(3)
    expect(byJur.get('US')).toBe(4)
  })

  it('schedules hearings only on bills that are still live', () => {
    const live = new Set(LM_BILLS.filter(b => b.live).map(b => b.externalId))
    const hearings = s.calendarEvents.filter(e => e.source === 'hearing')
    expect(hearings.length).toBeGreaterThanOrEqual(6)
    for (const h of hearings) {
      expect(h.externalId, `hearing ${h.id} must be on a live bill`).not.toBeNull()
      expect(live.has(h.externalId!), `hearing ${h.id} on ${h.externalId}`).toBe(true)
      expect(h.offsetDays, `hearing ${h.id} must be upcoming`).toBeGreaterThan(0)
    }
  })

  it('references only known bills and users from bill-linked rows', () => {
    const known = new Set(extIds())
    const uids = new Set(s.users.map(u => u.id))
    for (const p of s.positions) {
      expect(known.has(p.externalId), `position ${p.id}`).toBe(true)
      expect(uids.has(p.setBy), `position setBy ${p.setBy}`).toBe(true)
    }
    for (const v of s.customFieldValues) {
      expect(known.has(v.externalId), `cfv ${v.externalId}`).toBe(true)
      expect(uids.has(v.setBy), `cfv setBy ${v.setBy}`).toBe(true)
    }
    for (const e of s.calendarEvents) {
      if (e.externalId !== null) expect(known.has(e.externalId), `event ${e.id}`).toBe(true)
    }
  })

  it('uses only defined custom field ids and valid dropdown options', () => {
    const byId = new Map(s.customFields.map(f => [f.id, f]))
    for (const v of s.customFieldValues) {
      const f = byId.get(v.fieldId)
      expect(f, `field ${v.fieldId}`).toBeDefined()
      if (f!.type === 'dropdown') expect(f!.options).toContain(v.value)
      if (f!.type === 'binary') expect(v.value).toBe('1')
    }
  })

  it('gives every bill_updated event a system author and real change records', () => {
    const upd = s.feedEvents.filter(e => e.type === 'bill_updated')
    expect(upd.length).toBeGreaterThanOrEqual(20)
    for (const e of upd) {
      expect(e.userId).toBe('system')
      const changes = (e.metadata as { changes?: unknown[] }).changes
      expect(Array.isArray(changes) && changes!.length > 0, `event ${e.id}`).toBe(true)
    }
  })
})

describe('lake-michigan derived feed events', () => {
  const s = DEMO_SEEDS['lake-michigan']

  it('emits exactly one comment_added event per comment', () => {
    const ev = s.feedEvents.filter(e => e.type === 'comment_added')
    expect(ev).toHaveLength(s.comments.length)
    const ids = ev.map(e => (e.metadata as { commentId: string }).commentId).sort()
    expect(ids).toEqual(s.comments.map(c => c.id).sort())
  })

  it('derives each preview from its comment, so they cannot drift', () => {
    const byId = new Map(s.comments.map(c => [c.id, c]))
    for (const e of s.feedEvents.filter(x => x.type === 'comment_added')) {
      const m = e.metadata as { commentId: string; preview: string }
      const c = byId.get(m.commentId)!
      expect(m.preview).toBe(truncateWithEllipsis(stripHtml(c.content), COMMENT_PREVIEW_MAX))
      expect(e.userId).toBe(c.userId)
      expect(e.externalId).toBe(c.externalId)
      expect(e.daysAgo).toBe(c.daysAgo)
    }
  })

  it('carries mentioned user ids on events whose comment mentions someone', () => {
    for (const e of s.feedEvents.filter(x => x.type === 'comment_added')) {
      const m = e.metadata as { commentId: string; mentionedUserIds?: string[] }
      const expected = s.mentions.filter(x => x.commentId === m.commentId).map(x => x.userId).sort()
      expect((m.mentionedUserIds ?? []).slice().sort()).toEqual(expected)
    }
  })

  it('gives every feed event a unique id and a known bill', () => {
    const ids = s.feedEvents.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const known = new Set(s.priorities.map(p => p.externalId))
    for (const e of s.feedEvents) expect(known.has(e.externalId), `event ${e.id}`).toBe(true)
  })
})
