import { displayName } from './chipStyles'

export type MentionViewer = { id: string; role: 'member' | 'admin' | 'owner' }

type MentionUser = { id: string; name: string; email: string; subtitle: string | null; role?: 'member' | 'admin' | 'owner' }
type MentionRole = { id: string; name: string; members: unknown[] }

/**
 * The @-mention suggestions for what the member has typed after the @. The group
 * mentions come first: @admins is open to every member, and @everyone to an
 * admin or owner. Then people (four, with a "more" row for the rest), then roles
 * (three, likewise).
 */
export function mentionSuggestionItems({ query, users, roles, viewer }: {
  query: string
  users: MentionUser[]
  roles: MentionRole[]
  viewer: MentionViewer | null
}) {
  const q = query.toLowerCase()
  const others = users.filter(u => u.id !== viewer?.id)

  const filteredUsers = users
    .filter(u => displayName(u).toLowerCase().includes(q) || (u.subtitle && u.subtitle.toLowerCase().includes(q)))
  const matchedUsers = filteredUsers
    .slice(0, 4)
    .map(u => ({ ...u, type: 'user' as const }))
  if (filteredUsers.length > 4) matchedUsers.push({ id: '__more_users__', name: '', email: '', subtitle: `${filteredUsers.length - 4} more`, type: 'user' as const })

  const filteredRoles = roles.filter(r => r.name.toLowerCase().includes(q))
  const matchedRoles = filteredRoles
    .slice(0, 3)
    .map(r => ({ id: r.id, name: r.name, memberCount: r.members.length, type: 'role' as const }))
  if (filteredRoles.length > 3) matchedRoles.push({ id: '__more_roles__', name: `${filteredRoles.length - 3} more`, memberCount: 0, type: 'role' as const })

  const adminsItems = 'admins'.includes(q)
    ? [{ id: 'all' as const, memberCount: others.filter(u => u.role === 'admin' || u.role === 'owner').length, type: 'admins' as const }]
    : []
  const everyoneItems = (viewer?.role === 'admin' || viewer?.role === 'owner') && 'everyone'.includes(q)
    ? [{ id: 'all' as const, memberCount: others.length, type: 'everyone' as const }]
    : []

  return [...everyoneItems, ...adminsItems, ...matchedUsers, ...matchedRoles]
}
