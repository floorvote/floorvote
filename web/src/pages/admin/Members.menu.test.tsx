import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { color } from '../../styles/tokens'

const SOLE_OWNER = {
  id: 'owner-1',
  email: 'owner@example.com',
  name: 'Sole Owner',
  role: 'owner' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: null,
  roles: [],
  canVote: true,
  voteCount: 0,
}

const OTHER_MEMBER = {
  id: 'member-1',
  email: 'member@example.com',
  name: 'Regular Member',
  role: 'member' as const,
  subtitle: null,
  createdAt: '2024-01-01T00:00:00Z',
  lastActive: '2024-01-01T00:00:00Z',
  deactivatedAt: null,
  hasLoggedIn: true,
  invitedBy: 'owner-1',
  roles: [],
  canVote: true,
  voteCount: 0,
}

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

function mockApi(members: unknown[] = [SOLE_OWNER], config: Record<string, unknown> = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/admin/members') return members as never
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return config as never
    return {} as never
  })
}

describe('Members "···" actions menu', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders no actions menu for the signed-in user\'s own (ME) row', async () => {
    mockApi()

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    // Wait for the row to render, then assert the self row's "···" is the
    // disabled span (no actions), never an enabled button.
    await screen.findByText(SOLE_OWNER.email)
    expect(screen.queryByRole('button', { name: '···' })).not.toBeInTheDocument()
    expect(screen.getByText('···').tagName).toBe('SPAN')
  })

  it('shows Deactivate in danger/red styling for a non-self member, with no separator in the menu', async () => {
    mockApi([SOLE_OWNER, OTHER_MEMBER], { accountDeletionEnabled: true })

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    // Only the non-self row has an enabled "···" button (the self row's is a disabled span).
    const actionsButton = await screen.findByRole('button', { name: '···' })
    fireEvent.click(actionsButton)

    const deactivateItem = (await screen.findByText('Deactivate')).closest('button')!
    expect(deactivateItem).toHaveStyle({ color: color.textErrorRed })

    // "Permanently delete" also renders (accountDeletionEnabled is true), confirming the
    // separator that used to sit between Deactivate and Delete is gone: every child of the
    // menu panel is a labeled item, never an empty divider.
    const deleteItem = (await screen.findByText('Permanently delete')).closest('button')!
    expect(deleteItem).toHaveStyle({ color: color.textErrorRed })

    // The menu panel is the role="menu" container; climb to it from any item.
    // (Item labels are wrapped in a <span>, and Deactivate/Permanently delete
    // additionally wrap in a HoverTooltip, so a direct parentElement is unreliable.)
    const loginActivityItem = await screen.findByText('Login activity')
    const menuPanel = loginActivityItem.closest('[role="menu"]')!
    const children = Array.from(menuPanel.children) as HTMLElement[]
    expect(children.length).toBeGreaterThan(1)
    expect(children.every(c => (c.textContent ?? '').trim().length > 0)).toBe(true)
  })

  it('dismisses the actions menu on backdrop click, without calling window.close', async () => {
    mockApi([SOLE_OWNER, OTHER_MEMBER])
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

    const { container } = render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    // Only the non-self row has an actions menu now that self items are removed.
    const actionsButton = await screen.findByRole('button', { name: '···' })
    fireEvent.click(actionsButton)
    expect(await screen.findByText('Login activity')).toBeInTheDocument()

    // The backdrop is the fixed full-screen overlay (inset: 0, zIndex: 100)
    // rendered alongside the menu — it has no role/label of its own, so we
    // find it by the inline style the component gives it.
    const backdrop = Array.from(container.querySelectorAll<HTMLDivElement>('div')).find(
      (el) => el.style.position === 'fixed' && el.style.inset === '0px' && el.style.zIndex === '100',
    )
    expect(backdrop).toBeTruthy()

    fireEvent.click(backdrop!)

    expect(screen.queryByText('Login activity')).not.toBeInTheDocument()
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it('shows an explanatory hover tooltip on Deactivate', async () => {
    mockApi([SOLE_OWNER, OTHER_MEMBER])

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const actionsButton = await screen.findByRole('button', { name: '···' })
    fireEvent.click(actionsButton)

    const deactivateItem = await screen.findByText('Deactivate')
    expect(screen.queryByText(/is logged out immediately/)).not.toBeInTheDocument()

    fireEvent.pointerEnter(deactivateItem, { pointerType: 'mouse' })

    expect(await screen.findByText(
      'The account is logged out immediately and its activity (votes, comments, and notes) is hidden. An Admin can reactivate it later.',
    )).toBeInTheDocument()
  })

  it('shows an explanatory hover tooltip on Permanently delete', async () => {
    mockApi([SOLE_OWNER, OTHER_MEMBER], { accountDeletionEnabled: true })

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const actionsButton = await screen.findByRole('button', { name: '···' })
    fireEvent.click(actionsButton)

    const deleteItem = await screen.findByText('Permanently delete')
    expect(screen.queryByText(/This cannot be undone/)).not.toBeInTheDocument()

    fireEvent.pointerEnter(deleteItem, { pointerType: 'mouse' })

    expect(await screen.findByText(
      'Permanently removes the account and all its activity (votes, comments, and notes). This cannot be undone.',
    )).toBeInTheDocument()
  })
})
