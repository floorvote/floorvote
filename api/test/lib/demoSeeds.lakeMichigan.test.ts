import { describe, it, expect } from 'vitest'
import { DEMO_SEEDS, resolveDemoSeed } from '../../src/lib/demoSeeds'

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
