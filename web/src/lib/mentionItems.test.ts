import { describe, it, expect } from 'vitest'
import { mentionSuggestionItems, type MentionViewer } from './mentionItems'

// The @-mention suggestions the composer offers for a typed query. Two group
// mentions sit above people and roles: @admins is open to every member, and
// @everyone only to an admin or owner.

const users = [
  { id: 'u1', name: 'Sam Member', email: 'sam@example.com', title: null, role: 'member' as const },
  { id: 'u2', name: 'Dana Admin', email: 'dana@example.com', title: null, role: 'admin' as const },
  { id: 'u3', name: 'Olive Owner', email: 'olive@example.com', title: null, role: 'owner' as const },
  { id: 'u4', name: 'Pat Member', email: 'pat@example.com', title: null, role: 'member' as const },
]

const suggest = (query: string, viewer: MentionViewer) =>
  mentionSuggestionItems({ query, users, roles: [], viewer })

describe('mentionSuggestionItems', () => {
  it('offers @admins to a standard member, counting the admins and owners', () => {
    const items = suggest('adm', { id: 'u1', role: 'member' })
    const admins = items.find(i => i.type === 'admins')
    expect(admins).toBeDefined()
    expect(admins!.memberCount).toBe(2)
  })

  it('does not count the viewer among the admins', () => {
    const admins = suggest('admins', { id: 'u2', role: 'admin' }).find(i => i.type === 'admins')
    expect(admins!.memberCount).toBe(1)
  })

  it('offers @admins on an empty query and leaves it out when the query does not match', () => {
    expect(suggest('', { id: 'u1', role: 'member' }).some(i => i.type === 'admins')).toBe(true)
    expect(suggest('zzz', { id: 'u1', role: 'member' }).some(i => i.type === 'admins')).toBe(false)
  })

  it('offers @everyone only to an admin or owner', () => {
    expect(suggest('every', { id: 'u1', role: 'member' }).some(i => i.type === 'everyone')).toBe(false)
    expect(suggest('every', { id: 'u2', role: 'admin' }).some(i => i.type === 'everyone')).toBe(true)
    expect(suggest('every', { id: 'u3', role: 'owner' }).some(i => i.type === 'everyone')).toBe(true)
  })

  it('lists the group mentions before people', () => {
    const types = suggest('', { id: 'u2', role: 'admin' }).map(i => i.type)
    expect(types.indexOf('everyone')).toBeLessThan(types.indexOf('user'))
    expect(types.indexOf('admins')).toBeLessThan(types.indexOf('user'))
  })
})

// Typed text also matches the start of a member's email address. Addresses stay
// hidden in the list except on a person who matched by email alone. The
// directory (GET /users) already sends every member's email to every member, so
// the matching is done here.
describe('mentionSuggestionItems, matching by email', () => {
  const people = [
    { id: 'p1', name: 'Jordan Lee', email: 'jdoe@example.org', title: null, role: 'member' as const },
    { id: 'p2', name: 'Jo Doe', email: 'jo.d@example.org', title: null, role: 'member' as const },
    { id: 'p3', name: 'Sam Member', email: 'sam@example.com', title: null, role: 'member' as const },
    { id: 'p4', name: 'Alex Smith', email: 'sam.alex@example.com', title: null, role: 'member' as const },
  ]
  const viewer: MentionViewer = { id: 'p3', role: 'member' }
  const found = (query: string, from = people) =>
    mentionSuggestionItems({ query, users: from, roles: [], viewer })
      .filter(i => i.type === 'user') as Array<(typeof people)[number] & { matchedByEmail?: boolean }>

  it('suggests a member whose email starts with the typed text, with the address marked as the reason', () => {
    const result = found('jdoe')
    expect(result.map(p => p.id)).toEqual(['p1'])
    expect(result[0].matchedByEmail).toBe(true)
    expect(result[0].email).toBe('jdoe@example.org')
  })

  it('matches the full address, ignoring case', () => {
    expect(found('JDoe@Example.org').map(p => p.id)).toEqual(['p1'])
  })

  it('does not match text from the middle of an address', () => {
    expect(found('example')).toEqual([])
    expect(found('doe@')).toEqual([])
  })

  it('does not mark a name match as an email match', () => {
    const result = found('jordan')
    expect(result.map(p => p.id)).toEqual(['p1'])
    expect(result[0].matchedByEmail).toBeFalsy()
  })

  it('does not mark a match on both name and email as an email match', () => {
    const sam = found('sam').find(p => p.id === 'p3')
    expect(sam).toBeDefined()
    expect(sam!.matchedByEmail).toBeFalsy()
  })

  it('ranks name matches above email-only matches', () => {
    // "sam" is Sam Member's name and the start of Alex Smith's address; Alex is first in the directory.
    expect(found('sam', [people[3], people[2]]).map(p => p.id)).toEqual(['p3', 'p4'])
  })

  it('suggests nobody when neither name nor email matches', () => {
    expect(found('zzz')).toEqual([])
  })

  it('leaves role, @admins, and @everyone suggestions unchanged', () => {
    const roles = [{ id: 'r1', name: 'Jdoe Team', members: [{}, {}] }]
    const admin: MentionViewer = { id: 'p3', role: 'admin' }
    const items = mentionSuggestionItems({ query: 'jdoe', users: people, roles, viewer: admin })
    expect(items.filter(i => i.type === 'role')).toEqual([{ id: 'r1', name: 'Jdoe Team', memberCount: 2, type: 'role' }])
    expect(items.some(i => i.type === 'everyone' || i.type === 'admins')).toBe(false)
    const all = mentionSuggestionItems({ query: '', users: people, roles, viewer: admin })
    expect(all.filter(i => i.type === 'everyone' || i.type === 'admins').map(i => i.type)).toEqual(['everyone', 'admins'])
  })
})
