import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../lib/api'

// The Notifications page: each person's own email settings, the same for every role. An admin's switch for turning
// all of them off lives on Config. Here it only shows as a line at the top, with every control disabled.

const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown> }))
const demo = vi.hoisted(() => ({ demoLocked: false }))
const cfg = vi.hoisted(() => ({ config: {} as Record<string, unknown> | null }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: cfg.config, multiState: false, loading: false }),
}))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: demo.demoLocked, demoLocked: demo.demoLocked, settled: true }),
}))

const views = [
  { id: 'v1', name: 'Transportation', subscribed: true },
  { id: 'v2', name: 'Elections', subscribed: false },
  { id: 'v3', name: 'Courts', subscribed: true },
]

function signIn(role: 'member' | 'admin' | 'owner', over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role, title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailDigestWeeklyDay: null, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

function mock(over: { views?: unknown } = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/views') return { views: over.views ?? [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
}

function renderPage(url = '/notifications') {
  return render(<MemoryRouter initialEntries={[url]}><Notifications /></MemoryRouter>)
}

beforeEach(() => {
  vi.restoreAllMocks()
  demo.demoLocked = false
  cfg.config = { orgNoun: 'coalition', notificationEmailsEnabled: true, weekAheadDay: 5 }
  document.title = 'FloorVote'
  Element.prototype.scrollIntoView = vi.fn()
  mock()
})

const T = 'New bills that may be relevant to your coalition'
const SAVED_VIEWS = "A saved view is a filtered list of bills. Follow one with the envelope beside it in the Views menu on the Bills page."
// The line holds a link, so match the element whose whole text is the line, not its own text nodes alone.
const savedViewsLine = () => screen.findByText((_, el) => el?.tagName === 'DIV' && el.textContent === SAVED_VIEWS)
const REPLIES = 'Someone replies on a bill you commented on'
const OFF_LINE = "Your coalition has turned off email to members, so none of these emails are sent."
const card = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement
const digestMenu = () => screen.getByRole('button', { name: /^How often: / })

describe.each(['member', 'admin', 'owner'] as const)('the Notifications page, as a %s', (role) => {
  beforeEach(() => signIn(role))

  it('is personal only: no team section, no "Turned off by" notes, no default note, no radios, no info icons', async () => {
    renderPage()
    await screen.findByRole('switch', { name: T })
    expect(screen.queryByText(/your whole/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Turned off by/)).not.toBeInTheDocument()
    expect(screen.queryByText(/default/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'About new bills' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'About saved views you follow' })).not.toBeInTheDocument()
  })

  it('has one page heading and three cards, each titled by an h2, with no headings inside them', async () => {
    renderPage()
    await screen.findByRole('switch', { name: T })
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Notifications'])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Email digest', 'Week ahead email', 'Comments'])
    expect(screen.queryAllByRole('heading', { level: 3 })).toEqual([])
    expect(document.title).toBe('Notifications | FloorVote')
  })

  it('shows every switch on and How often at Every morning for someone with the defaults', async () => {
    renderPage()
    await screen.findByRole('switch', { name: T })
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeChecked()
    expect(screen.getAllByRole('switch')).toHaveLength(4)
    expect(digestMenu()).toHaveAccessibleName('How often: Every morning')
  })

  it('gives each card its own box, in the order digest, week ahead, comments', async () => {
    renderPage()
    await screen.findByRole('switch', { name: T })
    const boxes = ['Email digest', 'Week ahead email', 'Comments'].map(card)
    expect(boxes[0].compareDocumentPosition(boxes[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(boxes[1].compareDocumentPosition(boxes[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const b of boxes) expect(b.parentElement?.closest('section')).toBeNull()
    expect(document.getElementById('setting-email-digest')).toBe(boxes[0])
    expect(document.getElementById('setting-week-ahead')).toBe(boxes[1])
  })

  it('puts the explanation of each digest part in view, with no info icons', async () => {
    renderPage()
    expect(await savedViewsLine()).toBeInTheDocument()
    expect(screen.getByText('One email that sums up what changed on your bills since the last one.')).toBeInTheDocument()
    // The digest card no longer says when it's sent; How often beside the heading says that.
    expect(screen.queryByText(/Sent only when something changed/)).not.toBeInTheDocument()
    // The priority part and New bills each have their title alone, no line under it.
    expect(screen.queryByText(/^Status changes, hearings/)).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Changes to bills marked as priorities by your coalition' })).toHaveAccessibleDescription('')
    expect(screen.queryByText(/just matched/)).not.toBeInTheDocument()
    expect(screen.getByRole('switch', { name: T })).toHaveAccessibleDescription('')
  })

  it.each([[5, 'Friday'], [1, 'Monday']])('says the week ahead email is sent on its day (%i)', async (day, word) => {
    cfg.config = { orgNoun: 'coalition', notificationEmailsEnabled: true, weekAheadDay: day }
    renderPage()
    expect(await screen.findByText(`Next week's hearings on your coalition's priority bills and events on your coalition calendar. Sent every ${word} morning.`)).toBeInTheDocument()
  })

  // The app reads its settings once, after the page first draws. Until then the day isn't known, so the sentence that
  // names it waits rather than showing Friday, the default, on an instance with another day.
  it('leaves out the day until the app settings arrive', async () => {
    cfg.config = null
    renderPage()
    expect(await screen.findByText("Next week's hearings on your team's priority bills and events on your team calendar.")).toBeInTheDocument()
    expect(screen.queryByText(/Sent every/)).not.toBeInTheDocument()
  })

  it('links "Bills page" in the saved views line to the Bills page', async () => {
    renderPage()
    const line = await savedViewsLine()
    expect(within(line).getByRole('link', { name: 'Bills page' })).toHaveAttribute('href', '/bills')
  })

  it('names the new bills switch by its visible title', async () => {
    renderPage()
    const sw = await screen.findByRole('switch', { name: T })
    expect(document.getElementById(sw.getAttribute('aria-labelledby') as string)).toHaveTextContent(T)
  })

  it('lets each part be turned off on its own: new bills stays on with the priority part off', async () => {
    signIn(role, { emailDigestEnabled: false })
    renderPage()
    expect(await screen.findByRole('switch', { name: 'Changes to bills marked as priorities by your coalition' })).not.toBeChecked()
    expect(screen.getByRole('switch', { name: T })).toBeChecked()
    expect(screen.getByRole('switch', { name: T })).not.toBeDisabled()
  })

  it('shows "Someone mentions you" as always on, with no switch, and a reply switch', async () => {
    renderPage()
    await screen.findByRole('switch', { name: T })
    const comments = card('Comments')
    const mention = within(comments).getByText('Someone mentions you').parentElement?.parentElement as HTMLElement
    expect(within(mention).getByText('Always on')).toBeInTheDocument()
    expect(within(mention).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(comments).getAllByRole('switch')).toHaveLength(1)
    expect(within(comments).getByRole('switch', { name: 'Someone replies on a bill you commented on' })).toBeChecked()
  })

  it.each([
    ['setting-email-digest', 'Changes to bills marked as priorities by your coalition'],
    ['setting-week-ahead', 'Get the week ahead email'],
    ['setting-email-replies', 'Someone replies on a bill you commented on'],
  ])('lands #%s on its setting and flashes it', async (id, name) => {
    renderPage(`/notifications#${id}`)
    const row = document.getElementById(id) as HTMLElement
    expect(row).toContainElement(await screen.findByRole('switch', { name }))
    await waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('lands #setting-saved-views on the saved views you follow, and flashes it', async () => {
    mock({ views })
    renderPage('/notifications#setting-saved-views')
    const row = document.getElementById('setting-saved-views') as HTMLElement
    expect(row).toContainElement(await screen.findByRole('list', { name: 'Saved views you follow' }))
    await waitFor(() => expect(row.style.boxShadow).not.toBe(''))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('shows no email-off line while email to members is on, or when the setting is missing', async () => {
    const first = renderPage()
    await screen.findByRole('switch', { name: T })
    expect(screen.queryByText(/has turned off email to members/)).not.toBeInTheDocument()
    first.unmount()
    cfg.config = { orgNoun: 'coalition' }
    renderPage()
    await screen.findByRole('switch', { name: T })
    expect(screen.queryByText(/has turned off email to members/)).not.toBeInTheDocument()
    for (const sw of screen.getAllByRole('switch')) expect(sw).not.toBeDisabled()
  })
})

describe('the saved views you follow', () => {
  beforeEach(() => signIn('member'))

  it('shows two followed views as chips, with no count beside the title, and removing one sends the unfollow and drops its chip', async () => {
    mock({ views })
    renderPage()
    const digest = document.getElementById('setting-email-digest') as HTMLElement
    const list = await within(digest).findByRole('list', { name: 'Saved views you follow' })
    expect(within(digest).queryByText(/^\d+ views?$/)).not.toBeInTheDocument()
    expect(within(list).getAllByRole('listitem').map(li => li.textContent?.replace('×', ''))).toEqual(['Transportation', 'Courts'])

    await userEvent.click(within(digest).getByRole('button', { name: 'Remove Transportation' }))

    expect(api.apiFetch).toHaveBeenCalledWith('/views/v1/subscription', { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1))
    expect(within(digest).queryByText(/^\d+ views?$/)).not.toBeInTheDocument()
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
    vi.mocked(api.apiFetch).mockImplementation(async (path: string) => {
      if (path === '/views') throw new Error('boom')
      if (path === '/roles') return [] as never
      return {} as never
    })
    renderPage()
    expect(await screen.findByText("Couldn't load the saved views you follow.")).toBeInTheDocument()
    expect(screen.queryByText(/You don't follow any saved views yet/)).not.toBeInTheDocument()
  })
})

describe('when the admin turned off email to members', () => {
  beforeEach(() => {
    cfg.config = { orgNoun: 'coalition', notificationEmailsEnabled: false, weekAheadDay: 5 }
  })

  it('tells a member in one line, with no link to Config', async () => {
    signIn('member')
    renderPage()
    expect(await screen.findByText(OFF_LINE)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Turn it back on in Config' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Turn it back on/)).not.toBeInTheDocument()
  })

  it.each(['admin', 'owner'] as const)('tells an %s the same, then links to Config to turn it back on', async (role) => {
    signIn(role)
    renderPage()
    const line = (await screen.findByText(OFF_LINE, { exact: false })).closest('div') as HTMLElement
    expect(line).toHaveTextContent(`${OFF_LINE} Turn it back on in Config`)
    expect(within(line).getByRole('link', { name: 'Turn it back on in Config' })).toHaveAttribute('href', '/admin/config')
  })

  it('puts the line under the page heading, above the cards', async () => {
    signIn('member')
    renderPage()
    const line = await screen.findByText(OFF_LINE)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line.compareDocumentPosition(card('Email digest')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each(['member', 'admin'] as const)('disables every email switch, the How often menu, and the view chips for a %s, and dims those cards', async (role) => {
    signIn(role)
    mock({ views })
    renderPage()
    await screen.findByRole('button', { name: 'Remove Courts' })
    for (const sw of screen.getAllByRole('switch').filter(sw => sw.getAttribute('aria-label') !== REPLIES)) expect(sw).toBeDisabled()
    expect(digestMenu()).toBeDisabled()
    for (const b of screen.getAllByRole('button', { name: /^Remove / })) expect(b).toBeDisabled()
    for (const name of ['Email digest', 'Week ahead email']) expect(Number(card(name).style.opacity)).toBeLessThan(1)
    // The person's own choices stay as saved.
    expect(screen.getByRole('switch', { name: T })).toBeChecked()
  })

  // Replies also reach people in FloorVote, so their switch still does something with email off. It stays live, and
  // its card isn't dimmed, so nothing looks off that isn't.
  it('leaves the replies switch working, and its card undimmed, and saves a change to it', async () => {
    signIn('member')
    renderPage()
    await screen.findByText(OFF_LINE)
    expect(Number(card('Comments').style.opacity || 1)).toBe(1)
    const replies = screen.getByRole('switch', { name: REPLIES })
    expect(replies).toBeEnabled()
    await userEvent.click(replies)
    await waitFor(() => expect(vi.mocked(api.apiFetch)).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailRepliesEnabled: false }) }))
    expect(replies).not.toBeChecked()
  })

  it('sends nothing when a disabled switch or its sentence is clicked', async () => {
    signIn('member')
    renderPage()
    await screen.findByText(OFF_LINE)
    await userEvent.click(screen.getByText(T))
    await userEvent.click(screen.getByRole('switch', { name: T }))
    expect(vi.mocked(api.apiFetch).mock.calls.filter(([, o]) => (o as { method?: string } | undefined)?.method === 'PATCH')).toEqual([])
  })

  it('says a mention shows in FloorVote, with no "Always on" label, and uses the app-only reply wording', async () => {
    signIn('member')
    renderPage()
    await screen.findByText(OFF_LINE)
    const comments = card('Comments')
    expect(within(comments).getByText("You'll see it in FloorVote.")).toBeInTheDocument()
    expect(within(comments).queryByText(/You'll always get an email/)).not.toBeInTheDocument()
    expect(within(comments).queryByText('Always on')).not.toBeInTheDocument()
    const row = document.getElementById('setting-email-replies') as HTMLElement
    expect(within(row).getByText('You get these in FloorVote. To stop them on one bill, select “Mute comments” on that bill.')).toBeInTheDocument()
    expect(row.textContent).not.toMatch(/email/i)
  })

  it('keeps the email half of the reply description while email is on', async () => {
    cfg.config = { orgNoun: 'coalition', notificationEmailsEnabled: true }
    signIn('member')
    renderPage()
    const row = document.getElementById('setting-email-replies') as HTMLElement
    expect(await within(row).findByText('You get these in FloorVote and by email. To stop them on one bill, select “Mute comments” on that bill.')).toBeInTheDocument()
  })
})

describe('the Notifications page, on a demo', () => {
  it.each(['admin', 'member'] as const)('disables every switch, the How often menu, and chip button for %s, and says it is a demo', async (role) => {
    demo.demoLocked = true
    signIn(role)
    mock({ views })
    renderPage()
    await screen.findByRole('button', { name: 'Remove Courts' })
    const controls = [...screen.getAllByRole('switch'), digestMenu(), screen.getByRole('button', { name: 'Remove Courts' })]
    expect(controls.length).toBeGreaterThan(3)
    for (const c of controls) expect(c).toBeDisabled()
    expect(screen.getByText('This is a demo — settings are read-only.')).toBeInTheDocument()
    expect(screen.queryByText(/has turned off email to members/)).not.toBeInTheDocument()
  })
})
