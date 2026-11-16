import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import React from 'react'
import userEvent from '@testing-library/user-event'

// The Emails box in Settings, right after New matches: the admin's one switch for email to members, and the day the
// week ahead email goes out. Each saves at once. Everything else about these emails is each person's own choice.

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement('a', { href: to }, children),
}))
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))
vi.mock('../../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.com', name: 'Admin', role: 'admin' }, loading: false }),
}))
const { demo, patchConfig } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false }, patchConfig: vi.fn() }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => ({ config: { states: ['RI'] }, multiState: false, loading: false, patchConfig }),
}))
vi.mock('../../components/SettingsNav', () => ({
  SettingsNav: () => React.createElement('div', { 'data-testid': 'settings-nav' }),
}))
vi.mock('../../components/ResizableTextarea', () => ({
  ResizableTextarea: ({ value, onChange, ...rest }: React.ComponentProps<'textarea'>) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}))
vi.mock('../../components/HintText', () => ({
  HintText: ({ text }: { text: string }) => React.createElement('span', null, text),
}))
vi.mock('../../components/RichTextEditor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}))
vi.mock('../../components/BillBadge', () => ({ BillBadge: () => null }))
vi.mock('../../lib/exportData', () => ({ exportAllData: vi.fn() }))

import { apiFetch } from '../../lib/api'
import { Config } from './Config'
import { createUnsavedRegistry, UnsavedTextContext } from '../../lib/unsavedText'

const mockFetch = vi.mocked(apiFetch)

const BASE_CONFIG = {
  keywords: [],
  association_name: 'Test Org',
  ai_context: '',
  relevance_question: '',
  tag_taxonomy: [] as { name: string; description?: string }[],
  matched_bills_count: 7,
  prioritized_bills_count: 3,
}

type Put = Record<string, unknown>
function mockConfig(extra: Record<string, unknown> = {}, onPut?: (body: Put) => unknown) {
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config' && init?.method === 'PUT') {
      const body = JSON.parse(init.body as string) as Put
      if (onPut) return onPut(body)
      return {}
    }
    if (path === '/admin/config') return { ...BASE_CONFIG, ...extra }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    throw new Error('unexpected path: ' + path)
  })
}

function renderConfig() {
  render(<UnsavedTextContext.Provider value={createUnsavedRegistry()}><Config /></UnsavedTextContext.Provider>)
}

const COPY = 'The email digest, the week ahead email, and emails about mentions and replies. Each person chooses which of these they get on their Notifications tab. Sign-in links and invites always send.'
const DAY_COPY = 'The day the week ahead email goes out, so you know when events need to be on the calendar.'
const CONFIRM = 'Turn off email to members? No one will get the email digest, the week ahead email, or comment emails until you turn it back on. Sign-in links and invites still send.'
const SAVE_ERROR = "Couldn't save that change. Try again."
const toggle = () => screen.findByRole('switch', { name: 'Send email to members' })
const daySelect = () => screen.findByRole('combobox', { name: 'Week ahead email day' })
const puts = () => mockFetch.mock.calls.filter(([p, init]) => p === '/admin/config' && (init as RequestInit | undefined)?.method === 'PUT')
const putBodies = () => puts().map(([, init]) => JSON.parse((init as RequestInit).body as string) as Put)

beforeEach(() => {
  vi.resetAllMocks()
  patchConfig.mockReset()
  demo.demoLocked = false
  mockConfig()
})

describe('Config: the Emails box', () => {
  it('is an h2 section right after New matches, in the same style', async () => {
    renderConfig()
    const heading = await screen.findByRole('heading', { level: 2, name: 'Emails' })
    const newMatches = screen.getByRole('heading', { level: 2, name: 'New matches' })
    const titles = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    expect(titles.indexOf('Emails')).toBe(titles.indexOf('New matches') + 1)
    expect(heading.style.fontSize).toBe(newMatches.style.fontSize)
    expect(heading.style.fontWeight).toBe(newMatches.style.fontWeight)
    expect(heading.parentElement?.style.padding).toBe(newMatches.parentElement?.style.padding)
  })

  it.each([
    ['true', { notification_emails_enabled: true }],
    ['omitted', {}],
  ])('shows "Send email to members" on when /admin/config says %s, with what it covers', async (_l, extra) => {
    mockConfig(extra)
    renderConfig()
    expect(await toggle()).toBeChecked()
    expect(screen.getByText(COPY)).toBeInTheDocument()
  })

  it('shows it off when the admin turned it off', async () => {
    mockConfig({ notification_emails_enabled: false })
    renderConfig()
    await waitFor(async () => expect(await toggle()).not.toBeChecked())
  })

  it('asks before turning it off, and leaves it on and sends nothing when cancelled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderConfig()
    await userEvent.click(await toggle())
    expect(confirm).toHaveBeenCalledWith(CONFIRM)
    expect(await toggle()).toBeChecked()
    expect(puts()).toHaveLength(0)
    expect(patchConfig).not.toHaveBeenCalled()
  })

  it('turns it off when confirmed: saves it and tells the rest of the app', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderConfig()
    await userEvent.click(await toggle())
    await waitFor(() => expect(putBodies()).toEqual([{ notification_emails_enabled: false }]))
    expect(await toggle()).not.toBeChecked()
    expect(patchConfig).toHaveBeenCalledWith({ notificationEmailsEnabled: false })
  })

  it('turns it on at once with no confirm', async () => {
    mockConfig({ notification_emails_enabled: false })
    const confirm = vi.spyOn(window, 'confirm')
    renderConfig()
    const sw = await toggle()
    await waitFor(() => expect(sw).not.toBeChecked())
    await userEvent.click(sw)
    await waitFor(() => expect(putBodies()).toEqual([{ notification_emails_enabled: true }]))
    expect(confirm).not.toHaveBeenCalled()
    expect(patchConfig).toHaveBeenCalledWith({ notificationEmailsEnabled: true })
    expect(await toggle()).toBeChecked()
  })

  it('puts the switch back and says so when the save fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockConfig({}, () => { throw new Error('offline') })
    renderConfig()
    await userEvent.click(await toggle())
    expect(await screen.findByText(SAVE_ERROR)).toBeInTheDocument()
    expect(await toggle()).toBeChecked()
    expect(patchConfig).not.toHaveBeenCalled()
  })

  it.each([
    [5, 'Friday'],
    [0, 'Sunday'],
  ])('shows the saved week ahead day (%i) as %s, with the seven days to pick from and what it is for', async (day, name) => {
    mockConfig({ week_ahead_day: day })
    renderConfig()
    const select = await daySelect()
    await waitFor(() => expect(select).toHaveDisplayValue(name))
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
    expect(screen.getByText(DAY_COPY)).toBeInTheDocument()
  })

  it('saves a new day and tells the rest of the app', async () => {
    mockConfig({ week_ahead_day: 5 })
    renderConfig()
    const select = await daySelect()
    await waitFor(() => expect(select).toHaveDisplayValue('Friday'))
    await userEvent.selectOptions(select, 'Monday')
    await waitFor(() => expect(putBodies()).toEqual([{ week_ahead_day: 1 }]))
    expect(patchConfig).toHaveBeenCalledWith({ weekAheadDay: 1 })
    expect(select).toHaveDisplayValue('Monday')
  })

  it('puts the day back and says so when the save fails', async () => {
    mockConfig({ week_ahead_day: 5 }, () => { throw new Error('offline') })
    renderConfig()
    const select = await daySelect()
    await waitFor(() => expect(select).toHaveDisplayValue('Friday'))
    await userEvent.selectOptions(select, 'Monday')
    expect(await screen.findByText(SAVE_ERROR)).toBeInTheDocument()
    expect(select).toHaveDisplayValue('Friday')
    expect(patchConfig).not.toHaveBeenCalled()
  })

  it('disables both controls in a locked demo', async () => {
    demo.demoLocked = true
    renderConfig()
    expect(await toggle()).toBeDisabled()
    expect(await daySelect()).toBeDisabled()
  })
})
