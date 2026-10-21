import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// #598: the page is four cards, in this order: Profile, Notifications, Appearance, Account.

const auth = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))

vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

function signIn(role: 'member' | 'admin' | 'owner') {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false,
  }
}

function mockConfig(modules: Record<string, unknown>) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => (path === '/config' ? { modules } : {}) as never)
}

const BOTH_ON = { 'email-digest': { enabled: true }, 'week-ahead': { enabled: true } }
const COLOR_BUTTON = /^(System|Light|Dark)$/

function cardOf(name: string): HTMLElement {
  return screen.getByRole('heading', { name }).parentElement as HTMLElement
}

function inOrder(...nodes: Node[]) {
  for (let i = 0; i < nodes.length - 1; i++) {
    expect(nodes[i].compareDocumentPosition(nodes[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
}

const repliesName = /replies on bills you've commented on/i
const digestName = /recent bill activity/i
const matchesName = /include newly matched bills/i
const weekAheadName = /upcoming hearings and events/i

describe.each(['member', 'admin', 'owner'] as const)('Profile card regrouping, as a %s', (role) => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    Element.prototype.scrollIntoView = vi.fn()
    signIn(role)
    mockConfig(BOTH_ON)
  })
  afterEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
  })

  it('renders four cards headed Profile, Notifications, Appearance, and Account, in that order', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Profile', 'Notifications', 'Appearance', 'Account'])
  })

  it('has no card called "Your Email"', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'Your Email' })).not.toBeInTheDocument()
  })

  it('orders Notifications like Team notifications: the digest (with its option nested), the week-ahead email, then replies last', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const replies = screen.getByRole('switch', { name: repliesName })
    const digest = screen.getByRole('switch', { name: digestName })
    const weekAhead = screen.getByRole('switch', { name: weekAheadName })
    inOrder(digest, weekAhead, replies)
    if (role === 'member') {
      const matches = screen.getByRole('switch', { name: matchesName })
      inOrder(digest, matches, weekAhead, replies)
      expect(document.getElementById('setting-email-digest')).toContainElement(matches)
      expect(document.getElementById('setting-week-ahead')).not.toContainElement(matches)
    } else {
      expect(screen.queryByRole('switch', { name: matchesName })).not.toBeInTheDocument()
    }
  })

  it('keeps the three email settings, and the always-sent line, inside Notifications', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const card = within(cardOf('Notifications'))
    expect(card.getByRole('switch', { name: repliesName })).toBeInTheDocument()
    expect(card.getByRole('switch', { name: digestName })).toBeInTheDocument()
    expect(card.getByRole('switch', { name: weekAheadName })).toBeInTheDocument()
    expect(card.getByText(/^You'll always get an email when someone mentions you/)).toBeInTheDocument()
  })

  it('puts the color mode control only in Appearance, once', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const groups = screen.getAllByRole('group', { name: 'Color mode' })
    expect(groups).toHaveLength(1)
    expect(cardOf('Appearance')).toContainElement(groups[0])
    for (const other of ['Profile', 'Notifications', 'Account']) {
      expect(within(cardOf(other)).queryByRole('button', { name: COLOR_BUTTON }), other).not.toBeInTheDocument()
    }
    expect(screen.getAllByRole('button', { name: COLOR_BUTTON })).toHaveLength(3)
  })

  it('keeps every setting id, each in the card it belongs to', () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const notifications = cardOf('Notifications')
    for (const id of ['setting-email-replies', 'setting-email-digest', 'setting-week-ahead']) {
      const el = document.getElementById(id)
      expect(el, id).not.toBeNull()
      expect(notifications).toContainElement(el as HTMLElement)
    }
    const colorMode = document.getElementById('setting-color-mode')
    expect(colorMode).not.toBeNull()
    expect(cardOf('Appearance')).toContainElement(colorMode as HTMLElement)
    expect(colorMode).toContainElement(screen.getByRole('group', { name: 'Color mode' }))
  })

  it('still lands /account#setting-email-digest on the digest, inside Notifications', async () => {
    render(<MemoryRouter initialEntries={['/account#setting-email-digest']}><Profile /></MemoryRouter>)
    const row = document.getElementById('setting-email-digest') as HTMLElement
    expect(cardOf('Notifications')).toContainElement(row)
    expect(row).toContainElement(screen.getByRole('switch', { name: digestName }))
    await vi.waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('switches the color mode from the Appearance card', async () => {
    render(<MemoryRouter><Profile /></MemoryRouter>)
    const appearance = within(cardOf('Appearance'))
    await userEvent.setup().click(appearance.getByRole('button', { name: 'Dark' }))
    expect(localStorage.getItem('fv:color-mode')).toBe('dark')
    expect(appearance.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(appearance.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('Profile card regrouping with admin-disabled modules', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    signIn('member')
  })

  it.each([
    ['the digest off', { 'email-digest': { enabled: false }, 'week-ahead': { enabled: true } }],
    ['the week-ahead off', { 'email-digest': { enabled: true }, 'week-ahead': { enabled: false } }],
    ['both off', { 'email-digest': { enabled: false }, 'week-ahead': { enabled: false } }],
  ])('keeps the four cards and their contents with %s', async (_label, modules) => {
    mockConfig(modules)
    render(<MemoryRouter><Profile /></MemoryRouter>)
    await screen.findAllByText('Turned off by your coalition.')
    expect(screen.getAllByRole('heading').map(h => h.textContent)).toEqual(['Profile', 'Notifications', 'Appearance', 'Account'])
    const notifications = within(cardOf('Notifications'))
    expect(notifications.getByRole('switch', { name: repliesName })).toBeInTheDocument()
    expect(notifications.getByRole('switch', { name: digestName })).toBeInTheDocument()
    expect(notifications.getByRole('switch', { name: weekAheadName })).toBeInTheDocument()
    const appearance = within(cardOf('Appearance'))
    expect(appearance.getByRole('group', { name: 'Color mode' })).toBeInTheDocument()
    expect(appearance.getByRole('button', { name: 'Dark' })).not.toBeDisabled()
  })
})
