import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MembersPopup } from './MembersPopup'
import type { Member } from './types'

function member(over: Partial<Member> & Pick<Member, 'id'>): Member {
  return {
    name: 'Member',
    email: `${over.id}@example.org`,
    subtitle: null,
    role: 'member',
    roles: [],
    ...over,
  }
}

const withRoles: Member[] = [
  member({ id: 'u3', name: 'Zoe Zimmer', role: 'member', roles: [{ id: 'r2', name: 'Treasurer' }, { id: 'r1', name: 'Chair' }] }),
  member({ id: 'u1', name: 'Alice Anders', role: 'member' }),
  member({ id: 'u2', name: 'Owen Owner', role: 'owner' }),
]

const noRoles: Member[] = withRoles.map(m => ({ ...m, roles: [] }))

function renderPopup(members: Member[], rolesLabel = 'Team roles', currentUserId = 'u1') {
  return render(
    <MembersPopup members={members} currentUserId={currentUserId} rolesLabel={rolesLabel} onClose={() => {}} />,
  )
}

function headerTexts() {
  return screen.getAllByRole('columnheader').map(th => th.textContent)
}

describe('MembersPopup', () => {
  it('renders the first three columns of the admin Members table', () => {
    renderPopup(withRoles)
    expect(headerTexts()).toEqual(['Name', 'Role', 'Team roles'])
  })

  it('labels the roles column from the org noun, not a constant', () => {
    renderPopup(withRoles, 'Chapter roles')
    expect(headerTexts()).toEqual(['Name', 'Role', 'Chapter roles'])
  })

  it('drops the roles column entirely when no member has a role', () => {
    renderPopup(noRoles)
    expect(headerTexts()).toEqual(['Name', 'Role'])
    // The mobile card treatment labels cells off data-label, so the labelled
    // card row must disappear with the column.
    expect(document.querySelector('td[data-label="Team roles"]')).toBeNull()
  })

  it('keeps the roles column as soon as one member has a role', () => {
    renderPopup([...noRoles.slice(0, 2), { ...noRoles[2], roles: [{ id: 'r1', name: 'Chair' }] }])
    expect(headerTexts()).toContain('Team roles')
    expect(document.querySelectorAll('td[data-label="Team roles"]').length).toBe(3)
  })

  it('pins the signed-in user first and badges them ME', () => {
    renderPopup(withRoles)
    const rows = screen.getAllByRole('row').slice(1) // drop the header row
    expect(within(rows[0]).getByText('Alice Anders')).toBeTruthy()
    expect(within(rows[0]).getByText('ME')).toBeTruthy()
    expect(screen.getAllByText('ME').length).toBe(1)
    // Then owner before member, then by name.
    expect(within(rows[1]).getByText('Owen Owner')).toBeTruthy()
    expect(within(rows[2]).getByText('Zoe Zimmer')).toBeTruthy()
  })

  it('renders account-role chips and sorted, read-only role chips', () => {
    renderPopup(withRoles)
    expect(screen.getByText('Owner')).toBeTruthy()
    expect(screen.getAllByText('Member').length).toBe(2)
    const roleCells = [...document.querySelectorAll('td[data-label="Team roles"]')]
    // Row order is self, owner, then by name — and chips sort alphabetically.
    // A member with no roles gets an em dash, not an empty cell: the column is
    // only present because someone has a role, and the mobile card would
    // otherwise show a bare "Team roles" label with nothing beside it.
    expect(roleCells.map(td => [...td.querySelectorAll('span')].map(s => s.textContent)))
      .toEqual([['—'], ['—'], ['Chair', 'Treasurer']])
    // Read-only: role editing is admin-only, so no remove-X and no "Add role".
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
    expect(screen.queryByText(/add role/i)).toBeNull()
  })

  it('shows the empty state when there are no members', () => {
    renderPopup([])
    expect(screen.getByText('No members found.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('uses the shared members-table class contract so mobile cards apply', () => {
    renderPopup(withRoles)
    const table = screen.getByRole('table')
    expect(table.className).toBe('members-table')
    expect(table.querySelectorAll('td.members-name-cell').length).toBe(3)
    expect(document.querySelectorAll('td[data-label="Role"]').length).toBe(3)
  })
})
