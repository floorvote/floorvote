import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../lib/api'

// The Notifications page: every email setting in one place. Admins and owners
// see "For your whole coalition" first, then everyone sees "Your notifications"
// in the same order.

const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown> }))
const demo = vi.hoisted(() => ({ demoLocked: false }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demo.demoLocked, demoLocked: demo.demoLocked, settled: true }),
}))

const BOTH_ON = { 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '1' } }, 'week-ahead': { enabled: true, settings: { weeklyDay: '1' } } }

const views = [
  { id: 'v1', name: 'Transportation', subscribed: true },
  { id: 'v2', name: 'Elections', subscribed: false },
  { id: 'v3', name: 'Courts', subscribed: true },
]

function signIn(role: 'member' | 'admin' | 'owner', over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

function mock(over: { modules?: Record<string, unknown>; conversationEmails?: boolean; views?: unknown } = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/config') return { modules: over.modules ?? BOTH_ON, mentionEmailsEnabled: over.conversationEmails ?? true } as never
    if (path === '/admin/config' && (!init || init.method === undefined)) return { modules: over.modules ?? BOTH_ON, mention_emails_enabled: over.conversationEmails ?? true } as never
    if (path === '/views') return { views: over.views ?? [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
}

function renderPage(url = '/notifications') {
  return render(<MemoryRouter initialEntries={[url]}><Notifications /></MemoryRouter>)
}

const teamSection = () => screen.getByRole('heading', { level: 2, name: 'For your whole coalition' }).parentElement as HTMLElement
const yourSection = () => screen.getByRole('heading', { level: 2, name: 'Your notifications' }).parentElement as HTMLElement

beforeEach(() => {
  vi.restoreAllMocks()
  demo.demoLocked = false
  document.title = 'FloorVote'
  Element.prototype.scrollIntoView = vi.fn()
})

const T = 'New bills that may be relevant to your coalition'

describe('the Notifications page, as a member', () => {
  beforeEach(() => { signIn('member'); mock() })

  it('shows "Your notifications" and no team section', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Your notifications' })
    expect(screen.queryByRole('heading', { name: 'For your whole coalition' })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Send the email digest' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('puts no intro line under "Your notifications"', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Your notifications' })
    expect(screen.queryByText('The emails you get, and what is in each one.')).not.toBeInTheDocument()
  })

  it('has one top-level heading and sets the page title', async () => {
    renderPage()
    const h1s = await screen.findAllByRole('heading', { level: 1 })
    expect(h1s.map(h => h.textContent)).toEqual(['Notifications'])
    expect(document.title).toBe('Notifications | FloorVote')
  })

  it('lists the email digest, the week ahead email, and comments, in that order', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Your notifications' })
    const headings = within(yourSection()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(headings).toEqual(['Email digest', 'Week ahead email', 'Comments'])
  })

  it('defines the digest in one line and says it is sent only when something changed', async () => {
    renderPage()
    expect(await screen.findByText('One email that sums up what changed on your bills since the last one. Sent only when something changed.')).toBeInTheDocument()
  })

  it('says the week ahead email is sent on its day', async () => {
    mock({ modules: { ...BOTH_ON, 'week-ahead': { enabled: true, settings: { weeklyDay: '3' } } } })
    renderPage()
    expect(await screen.findByText("Next week's hearings on your coalition's priority bills and events on your coalition calendar. Sent every Wednesday morning.")).toBeInTheDocument()
  })

  it.each(['hovering', 'focusing'])('names the new bills switch by its title and explains it on %s the info icon, with no description line', async (how) => {
    renderPage()
    const sw = await screen.findByRole('switch', { name: T })
    expect(sw).toBeChecked()
    expect(document.getElementById('setting-email-digest')).toContainElement(sw)
    const tipText = "Bills that just matched your coalition's keywords."
    expect(screen.queryByText(tipText)).not.toBeInTheDocument()
    const info = screen.getByRole('button', { name: 'About new bills' })
    if (how === 'hovering') await userEvent.hover(info)
    else act(() => { info.focus() })
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent(tipText)
    expect(info).toHaveAccessibleDescription(tipText)
  })

  it('splits the digest into three parts: changes to priority bills, new bills, and the saved views you follow', async () => {
    mock({ views })
    renderPage()
    const digest = document.getElementById('setting-email-digest') as HTMLElement
    expect(await within(digest).findByRole('switch', { name: 'Changes to priority bills' })).toBeChecked()
    expect(within(digest).getByText('Status changes, hearings, positions, and comments on bills your coalition marked as a priority.')).toBeInTheDocument()
    expect(within(digest).getByRole('switch', { name: T })).toBeChecked()
    expect(within(digest).getByText('Saved views you follow')).toBeInTheDocument()
    expect(within(digest).getByText("You'll get an email with what changed in each one you follow.")).toBeInTheDocument()
    const titles = ['Changes to priority bills', T, 'Saved views you follow'].map(t => within(digest).getByText(t))
    expect(titles[0].compareDocumentPosition(titles[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(titles[1].compareDocumentPosition(titles[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // #1036: a member who hasn't chosen follows the team's default ("Admins get new bills, which are new keyword matches, by default. Should members get these as well?").
  const withNewBillsDefault = (on: boolean) => ({ ...BOTH_ON, 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '1', newBillsDefault: on } } })

  it.each([
    ['Yes, members get notified about new bills', true],
    ['No, members only get notified about prioritized bills and saved views they follow', false],
  ])('shows a member with no choice the new bills switch as the default, %s, with "Your coalition\'s default."', async (_l, on) => {
    signIn('member', { emailDigestMatchesEnabled: null })
    mock({ modules: withNewBillsDefault(on) })
    renderPage()
    await screen.findByText('One email that sums up what changed on your bills since the last one. Sent only when something changed.')
    const sw = screen.getByRole('switch', { name: T })
    expect((sw as HTMLInputElement).checked).toBe(on)
    expect(sw).toHaveAccessibleDescription(expect.stringContaining("Your coalition's default."))
    expect(within(document.getElementById('setting-email-digest') as HTMLElement).getByText("Your coalition's default.")).toBeInTheDocument()
  })

  it('drops "Your coalition\'s default." once the member flips the switch, and keeps their choice when the default changes', async () => {
    signIn('member', { emailDigestMatchesEnabled: null })
    mock({ modules: withNewBillsDefault(false) })
    const before = renderPage()
    const sw = await screen.findByRole('switch', { name: T })
    expect(await screen.findByText("Your coalition's default.")).toBeInTheDocument()

    await userEvent.click(sw)

    await waitFor(() => expect(sw).toBeChecked())
    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailDigestMatchesEnabled: true }) })
    expect(screen.queryByText("Your coalition's default.")).not.toBeInTheDocument()
    before.unmount()

    // The choice is saved. The default changes to new bills and back to "No, members only get notified about prioritized bills and saved views they follow": the choice stays put.
    for (const on of [true, false]) {
      signIn('member', { emailDigestMatchesEnabled: true })
      mock({ modules: withNewBillsDefault(on) })
      const after = renderPage()
      await screen.findByText('One email that sums up what changed on your bills since the last one. Sent only when something changed.')
      expect(screen.getByRole('switch', { name: T })).toBeChecked()
      expect(screen.queryByText("Your coalition's default.")).not.toBeInTheDocument()
      after.unmount()
    }
  })

  it('shows a member with no choice no new bills switch and no "Your coalition\'s default." until the team settings answer', async () => {
    signIn('member', { emailDigestMatchesEnabled: null })
    let answer: (config: unknown) => void = () => {}
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/config') return new Promise((resolve) => { answer = resolve }) as never
      if (path === '/views') return { views: [] } as never
      if (path === '/roles') return [] as never
      return {} as never
    })
    renderPage()
    // The page is up, and the team's settings haven't answered: the default isn't known yet.
    expect(await screen.findByRole('switch', { name: 'Changes to priority bills' })).toBeInTheDocument()
    expect(screen.getByText(T)).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: T })).not.toBeInTheDocument()
    expect(screen.queryByText("Your coalition's default.")).not.toBeInTheDocument()

    await act(async () => { answer({ modules: withNewBillsDefault(false), mentionEmailsEnabled: true }) })

    const sw = await screen.findByRole('switch', { name: T })
    expect(sw).not.toBeChecked()
    expect(screen.getByText("Your coalition's default.")).toBeInTheDocument()
  })

  it('lets each part be turned off on its own: new bills stays on with the priority part off', async () => {
    signIn('member', { emailDigestEnabled: false })
    renderPage()
    expect(await screen.findByRole('switch', { name: 'Changes to priority bills' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: T })).toBeChecked()
    expect(screen.getByRole('switch', { name: T })).not.toBeDisabled()
  })

  it('shows "Someone mentions you" as always on, with no switch, and a reply switch', async () => {
    renderPage()
    const comments = await within(yourSection()).findByRole('heading', { level: 3, name: 'Comments' })
    const card = comments.parentElement as HTMLElement
    const mention = within(card).getByText('Someone mentions you').parentElement?.parentElement as HTMLElement
    expect(within(mention).getByText('Always on')).toBeInTheDocument()
    expect(within(mention).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(card).getAllByRole('switch')).toHaveLength(1)
    expect(within(card).getByRole('switch', { name: 'Someone replies on a bill you commented on' })).toBeChecked()
  })

  it('shows a member the setting ids the email footers link to', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Your notifications' })
    for (const id of ['setting-email-digest', 'setting-week-ahead', 'setting-email-replies']) {
      expect(yourSection(), id).toContainElement(document.getElementById(id))
    }
  })

  it.each([
    ['setting-email-digest', 'Changes to priority bills'],
    ['setting-week-ahead', 'Get the week ahead email'],
    ['setting-email-replies', 'Someone replies on a bill you commented on'],
  ])('lands #%s on its setting and flashes it', async (id, name) => {
    renderPage(`/notifications#${id}`)
    const row = document.getElementById(id) as HTMLElement
    expect(row).toContainElement(await screen.findByRole('switch', { name }))
    await waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('shows two followed views as chips with "2 views", and removing one sends the unfollow and drops its chip', async () => {
    mock({ views })
    renderPage()
    const digest = document.getElementById('setting-email-digest') as HTMLElement
    expect(await within(digest).findByText('2 views')).toBeInTheDocument()
    const list = within(digest).getByRole('list', { name: 'Saved views you follow' })
    expect(within(list).getAllByRole('listitem').map(li => li.textContent?.replace('×', ''))).toEqual(['Transportation', 'Courts'])

    await userEvent.click(within(digest).getByRole('button', { name: 'Remove Transportation' }))

    expect(api.apiFetch).toHaveBeenCalledWith('/views/v1/subscription', { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1))
    expect(within(digest).getByText('1 view')).toBeInTheDocument()
  })

  // The hover on "Saved views you follow": two sentences, ending in a period like the app's other InfoTooltip texts.
  const SAVED_VIEWS_TIP = "A saved view is a filtered list of bills. Follow one by clicking the envelope beside it in the Views menu on the Bills page. You get these even with the two parts above off, and a bill already under priority bills isn't repeated."

  it.each(['hovering', 'focusing'])('explains the saved views you follow on %s the info icon beside their label', async (how) => {
    mock({ views })
    renderPage()
    const row = document.getElementById('setting-saved-views') as HTMLElement
    const info = await within(row).findByRole('button', { name: 'About saved views you follow' })
    // Beside the label, not over the whole row.
    expect(within(row).getByText('Saved views you follow')).toContainElement(info)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    if (how === 'hovering') await userEvent.hover(info)
    else act(() => { info.focus() })

    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent(SAVED_VIEWS_TIP)
    expect(tip.textContent).toMatch(/[.]$/)
    expect(info).toHaveAccessibleDescription(SAVED_VIEWS_TIP)
  })

  it('says where to follow a view when the person follows none', async () => {
    mock({ views: views.map(v => ({ ...v, subscribed: false })) })
    renderPage()
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/views'))
    expect(screen.getByText('Saved views you follow')).toBeInTheDocument()
    expect(await screen.findByText("You don't follow any saved views yet.")).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Saved views you follow' })).not.toBeInTheDocument()
  })

  it('says the views could not be loaded, rather than that none are followed, when the read fails', async () => {
    mock()
    vi.mocked(api.apiFetch).mockImplementation(async (path: string) => {
      if (path === '/views') throw new Error('boom')
      if (path === '/config') return { modules: BOTH_ON, mentionEmailsEnabled: true } as never
      if (path === '/roles') return [] as never
      return {} as never
    })
    renderPage()
    expect(await screen.findByText("Couldn't load the saved views you follow.")).toBeInTheDocument()
    expect(screen.queryByText(/You don't follow any saved views yet/)).not.toBeInTheDocument()
  })

  it('lands #setting-saved-views on the saved views you follow, and flashes it', async () => {
    mock({ views })
    renderPage('/notifications#setting-saved-views')
    const row = document.getElementById('setting-saved-views') as HTMLElement
    expect(row).toContainElement(await screen.findByRole('list', { name: 'Saved views you follow' }))
    await waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it.each([
    ['the week ahead email', { 'email-digest': { enabled: true }, 'week-ahead': { enabled: false } }, 'setting-week-ahead', 'Get the week ahead email'],
  ])('reads "Turned off by your coalition." and disables the switch when your team turned off %s', async (_l, modules, id, name) => {
    mock({ modules })
    renderPage()
    const row = document.getElementById(id) as HTMLElement
    expect(await within(row).findByText('Turned off by your coalition.')).toBeInTheDocument()
    const sw = within(row).getByRole('switch', { name })
    expect(sw).toBeDisabled()
    expect(sw).not.toBeChecked() // the team's off shows. The person's own choice stays saved.
    expect(screen.getAllByText('Turned off by your coalition.')).toHaveLength(1)
  })

  it('under Saved views only, reads "Turned off by your coalition." on the priority and new bills rows and leaves the followed views editable', async () => {
    mock({ modules: { 'email-digest': { enabled: true, settings: { frequency: 'daily', teamUpdates: false } }, 'week-ahead': { enabled: true } }, views })
    renderPage()
    const digest = document.getElementById('setting-email-digest') as HTMLElement
    await within(digest).findByRole('list', { name: 'Saved views you follow' })
    expect(within(digest).getAllByText('Turned off by your coalition.')).toHaveLength(2)
    expect(within(digest).getByRole('switch', { name: 'Changes to priority bills' })).toBeDisabled()
    expect(within(digest).getByRole('switch', { name: T })).toBeDisabled()
    expect(within(digest).getByRole('switch', { name: T })).not.toBeChecked() // the team's off shows. The person's own choice stays saved.
    expect(within(digest).getByRole('button', { name: 'Remove Transportation' })).not.toBeDisabled()
    // The saved views row is not turned off.
    expect(within(document.getElementById('setting-saved-views') as HTMLElement).queryByText('Turned off by your coalition.')).not.toBeInTheDocument()
  })

  it('under Saved views only, still removes a followed view', async () => {
    mock({ modules: { 'email-digest': { enabled: true, settings: { teamUpdates: false } } }, views })
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Transportation' }))
    expect(api.apiFetch).toHaveBeenCalledWith('/views/v1/subscription', { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
  })

  it('under Off, reads "Turned off by your coalition." on all three parts, including the views', async () => {
    mock({ modules: { 'email-digest': { enabled: false }, 'week-ahead': { enabled: true } }, views })
    renderPage()
    const digest = document.getElementById('setting-email-digest') as HTMLElement
    await waitFor(() => expect(within(digest).getAllByText('Turned off by your coalition.')).toHaveLength(3))
    expect(within(digest).getByRole('switch', { name: 'Changes to priority bills' })).toBeDisabled()
    expect(within(digest).getByRole('switch', { name: T })).toBeDisabled()
    const row = document.getElementById('setting-saved-views') as HTMLElement
    const note = within(row).getByText('Turned off by your coalition.')
    // The followed views stay, below the note, so someone can still unfollow. The info icon goes.
    const list = await within(row).findByRole('list', { name: 'Saved views you follow' })
    expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(row).queryByRole('button', { name: 'About saved views you follow' })).not.toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: 'Remove Transportation' }))
    expect(api.apiFetch).toHaveBeenCalledWith('/views/v1/subscription', { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1))
  })

  it('under Off, dims the views description and note but keeps the followed chips at full strength', async () => {
    mock({ modules: { 'email-digest': { enabled: false }, 'week-ahead': { enabled: true } }, views })
    renderPage()
    const row = document.getElementById('setting-saved-views') as HTMLElement
    const list = await within(row).findByRole('list', { name: 'Saved views you follow' })
    for (let el: HTMLElement | null = list; el && el !== document.body; el = el.parentElement) expect(el.style.opacity).not.toBe('0.55')
    expect(within(row).getByText('Turned off by your coalition.').closest('[style*="opacity"]')).not.toBeNull()
  })
  it('reads "Turned off by your coalition." under Comments when the team turned comment emails off, and keeps the reply switch usable for FloorVote itself', async () => {
    mock({ conversationEmails: false })
    renderPage()
    const comments = (await within(yourSection()).findByRole('heading', { level: 3, name: 'Comments' })).parentElement as HTMLElement
    expect(await within(comments).findByText('Comment emails are turned off by your coalition.')).toBeInTheDocument()
    expect(within(comments).queryByText('Always on')).not.toBeInTheDocument()
    expect(within(comments).getByRole('switch', { name: 'Someone replies on a bill you commented on' })).not.toBeDisabled()
  })

  // A switch the team turned off shows off, though the person's own choice (on here) stays saved and nothing is sent.
  it.each([
    ['chose Saved views only', { 'email-digest': { enabled: true, settings: { frequency: 'daily', teamUpdates: false } }, 'week-ahead': { enabled: true } }, ['Changes to priority bills', T]],
    ['turned the digest off', { 'email-digest': { enabled: false }, 'week-ahead': { enabled: true } }, ['Changes to priority bills', T]],
    ['turned the week ahead email off', { 'email-digest': { enabled: true }, 'week-ahead': { enabled: false } }, ['Get the week ahead email']],
  ])('shows each switch the team turned off as off and disabled when the team %s', async (_l, modules, names) => {
    mock({ modules })
    renderPage()
    await waitFor(() => expect(screen.getByRole('switch', { name: names[0] })).toBeDisabled())
    for (const name of names) {
      const sw = screen.getByRole('switch', { name })
      expect(sw, name).not.toBeChecked()
      expect(sw, name).toBeDisabled()
      expect(sw.closest('label'), name).toHaveTextContent('Turned off by your coalition.')
    }
    expect(api.apiFetch).not.toHaveBeenCalledWith('/users/me', expect.anything())
  })

  it('shows a member with no choice "New bills" off when the team turned it off, with "Turned off by your coalition." and not "Your coalition\'s default."', async () => {
    signIn('member', { emailDigestMatchesEnabled: null })
    mock({ modules: { 'email-digest': { enabled: true, settings: { frequency: 'daily', teamUpdates: false, newBillsDefault: true } }, 'week-ahead': { enabled: true } } })
    renderPage()
    const sw = await screen.findByRole('switch', { name: T })
    await waitFor(() => expect(sw).toBeDisabled())
    expect(sw).not.toBeChecked()
    expect(sw.closest('label')).toHaveTextContent('Turned off by your coalition.')
    expect(screen.queryByText("Your coalition's default.")).not.toBeInTheDocument()
  })

  it.each([true, false])('keeps the reply switch at the person\'s own choice (%s), and usable, when the team turned comment emails off', async (own) => {
    signIn('member', { emailRepliesEnabled: own })
    mock({ conversationEmails: false })
    renderPage()
    const comments = (await within(yourSection()).findByRole('heading', { level: 3, name: 'Comments' })).parentElement as HTMLElement
    await within(comments).findByText('Comment emails are turned off by your coalition.')
    const sw = within(comments).getByRole('switch', { name: 'Someone replies on a bill you commented on' })
    expect((sw as HTMLInputElement).checked).toBe(own)
    expect(sw).not.toBeDisabled()
  })

  it('drops the email half of the reply description when the team turned comment emails off, and keeps it when they are on', async () => {
    mock({ conversationEmails: false })
    const off = renderPage()
    const row = document.getElementById('setting-email-replies') as HTMLElement
    expect(await within(row).findByText('You get these in FloorVote. To stop them on one bill, select \u201cMute comments\u201d on that bill.')).toBeInTheDocument()
    expect(row.textContent).not.toMatch(/email/i)
    off.unmount()
    mock({ conversationEmails: true })
    renderPage()
    const on = document.getElementById('setting-email-replies') as HTMLElement
    expect(await within(on).findByText('You get these in FloorVote and by email. To stop them on one bill, select \u201cMute comments\u201d on that bill.')).toBeInTheDocument()
  })

  it('shows no "Turned off" note when every email is on', async () => {
    renderPage()
    await screen.findByText('Always on')
    expect(screen.queryByText(/Turned off by/)).not.toBeInTheDocument()
  })
})

describe.each(['admin', 'owner'] as const)('the Notifications page, as an %s', (role) => {
  beforeEach(() => { signIn(role); mock() })

  it('shows "For your whole coalition" above "Your notifications"', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Your notifications' })
    const team = screen.getByRole('heading', { level: 2, name: 'For your whole coalition' })
    const yours = screen.getByRole('heading', { level: 2, name: 'Your notifications' })
    expect(team.compareDocumentPosition(yours) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lists the emails in the same order in both sections', async () => {
    renderPage()
    await screen.findByRole('heading', { level: 2, name: 'Your notifications' })
    const names = (el: HTMLElement) => within(el).getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    // The team's comment switch is titled for what it stops, emails. The personal card covers FloorVote too.
    expect(names(teamSection())).toEqual(['Email digest', 'Week ahead email', 'Comment emails'])
    expect(names(yourSection())).toEqual(['Email digest', 'Week ahead email', 'Comments'])
  })

  it('offers the team the digest choice, the week ahead switch and day, and "Send emails about comments"', async () => {
    renderPage()
    const team = within(await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' }).then(h => h.parentElement as HTMLElement))
    expect(await team.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toBeChecked()
    // How often, and which weekday, is each person's own: the team's one menu is the week ahead email's day.
    expect(team.getAllByRole('combobox').map(c => c.getAttribute('aria-label') ?? c.id)).toEqual(['notif-weekahead-weekday'])
    expect(team.getByRole('switch', { name: 'Send the week ahead email' })).toBeChecked()
    expect(team.getByRole('switch', { name: 'Send emails about comments' })).toBeChecked()
  })

  it('shows an admin or owner with no choice "New bills" on, with no "Your coalition\'s default.", when members don\'t get them', async () => {
    signIn(role, { emailDigestMatchesEnabled: null })
    mock({ modules: { ...BOTH_ON, 'email-digest': { enabled: true, settings: { frequency: 'weekly', weeklyDay: '1', newBillsDefault: false } } } })
    renderPage()
    await screen.findByText('One email that sums up what changed on your bills since the last one. Sent only when something changed.')
    expect(screen.getByRole('switch', { name: T })).toBeChecked()
    expect(screen.queryByText("Your coalition's default.")).not.toBeInTheDocument()
  })

  it('shows "New bills" to an admin or owner and saves it', async () => {
    renderPage()
    const sw = await screen.findByRole('switch', { name: T })
    expect(sw).toBeChecked()
    expect(document.getElementById('setting-email-digest')).toContainElement(sw)

    await userEvent.click(sw)

    await waitFor(() => expect(sw).not.toBeChecked())
    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailDigestMatchesEnabled: false }) })
  })

  it('asks to confirm before turning the digest off for the team, then shows the "Turned off" note in your own section', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()
    const team = within(await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' }).then(h => h.parentElement as HTMLElement))

    await userEvent.click(await team.findByRole('radio', { name: 'Off' }))

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe('Turn off the email digest for everyone? This stops it for all members, not just you. Members can also opt out individually on their Notifications tab.')
    const row = document.getElementById('setting-email-digest') as HTMLElement
    await waitFor(() => expect(within(row).getAllByText('Turned off by your coalition.')).toHaveLength(3))
    expect(within(row).getByRole('switch', { name: 'Changes to priority bills' })).toBeDisabled()
  })

  it('shows its own parts off while the team chose Saved views only, and its own choices again once the team is back to On', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()
    const team = within(await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' }).then(h => h.parentElement as HTMLElement))
    const priority = await screen.findByRole('switch', { name: 'Changes to priority bills' })
    const found = screen.getByRole('switch', { name: T })
    await team.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })
    expect([priority, found].map(s => (s as HTMLInputElement).checked)).toEqual([true, true])

    await userEvent.click(team.getByRole('radio', { name: 'Saved views only' }))

    await waitFor(() => expect(priority).toBeDisabled())
    expect([priority, found].map(s => (s as HTMLInputElement).checked)).toEqual([false, false])

    await userEvent.click(team.getByRole('radio', { name: 'Priority bills, new bills, and saved views' }))

    await waitFor(() => expect(priority).not.toBeDisabled())
    expect([priority, found].map(s => (s as HTMLInputElement).checked)).toEqual([true, true])
    expect(api.apiFetch).not.toHaveBeenCalledWith('/users/me', expect.anything())
  })

  it('keeps the email on when the confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPage()
    const team = within(await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' }).then(h => h.parentElement as HTMLElement))
    await userEvent.click(await team.findByRole('radio', { name: 'Off' }))
    expect(team.getByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toBeChecked()
    expect(api.apiFetch).not.toHaveBeenCalledWith('/admin/config', expect.objectContaining({ method: 'PUT' }))
    expect(screen.queryByText(/Turned off by/)).not.toBeInTheDocument()
  })
})

describe('the Notifications page, on a demo', () => {
  it.each(['admin', 'member'] as const)('disables every switch, select, and chip button for %s', async (role) => {
    demo.demoLocked = true
    signIn(role)
    mock({ views })
    renderPage()
    await screen.findByText('2 views')
    const controls = [...screen.getAllByRole('switch'), ...screen.queryAllByRole('combobox'), ...screen.queryAllByRole('radio'), screen.getByRole('button', { name: 'Remove Courts' })]
    // The digest's three choices, and what members get unless they change it.
    if (role === 'admin') expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(controls.length).toBeGreaterThan(3)
    for (const c of controls) expect(c).toBeDisabled()
    expect(screen.getByText('This is a demo — settings are read-only.')).toBeInTheDocument()
  })
})
