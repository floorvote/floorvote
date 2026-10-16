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
