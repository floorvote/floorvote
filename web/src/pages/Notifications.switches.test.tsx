import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Notifications } from './Notifications'
import * as api from '../lib/api'

// Every switch on the Notifications page saves as it did on the Account page,
// takes a click on its sentence, has a 24px target, and shows a keyboard focus ring.

const auth = vi.hoisted(() => ({ user: {} as Record<string, unknown> }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition', notificationEmailsEnabled: true, weekAheadDay: 5 }, multiState: false, loading: false }),
}))

const mobileCss = readFileSync(resolve(__dirname, '../styles/mobile.css'), 'utf8')

function signIn(over: Record<string, unknown> = {}) {
  auth.user = {
    id: 'u1', email: 'a@b.c', name: 'A', role: 'member', title: null,
    canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
    lastSeenFeed: null, isLastOwner: false, ...over,
  }
}

function mockConfig() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/views') return { views: [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
}

function patches() {
  return vi.mocked(api.apiFetch).mock.calls.filter(([, opts]) => (opts as { method?: string } | undefined)?.method === 'PATCH')
}

const renderPage = () => render(<MemoryRouter><Notifications /></MemoryRouter>)

// A switch's name, a line of its visible sentence to click, and the field it saves.
const SWITCHES = [
  { key: 'priority bills', name: 'Changes to priority bills', sentence: /^Status changes, hearings, positions, and comments/, field: 'emailDigestEnabled' },
  { key: 'new bills', name: "New bills that may be relevant to your coalition", sentence: /^New bills that may be relevant to your coalition$/, field: 'emailDigestMatchesEnabled' },
  { key: 'week ahead', name: 'Get the week ahead email', sentence: /^Next week's hearings on your coalition's priority bills/, field: 'emailWeekAheadEnabled' },
  { key: 'replies', name: 'Someone replies on a bill you commented on', sentence: /^You get these in FloorVote and by email/, field: 'emailRepliesEnabled' },
]

describe('Notifications: your switches', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    signIn()
    mockConfig()
  })

  it.each(SWITCHES)('saves the $key switch as $field', async ({ name, field }) => {
    renderPage()
    const sw = await screen.findByRole('switch', { name })
    expect(sw).toBeChecked()

    await userEvent.click(sw)

    await waitFor(() => expect(sw).not.toBeChecked())
    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ [field]: false }) })
    expect(patches()).toHaveLength(1)
  })

  it.each(SWITCHES)('puts the $key switch back when saving fails', async ({ name }) => {
    renderPage()
    const sw = await screen.findByRole('switch', { name })
    vi.mocked(api.apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') throw new Error('boom')
      return {} as never
    })
    await userEvent.click(sw)
    await waitFor(() => expect(patches()).toHaveLength(1))
    await waitFor(() => expect(sw).toBeChecked())
  })

  it.each(SWITCHES)('reflects a saved off choice on the $key switch', async ({ name, field }) => {
    signIn({ [field]: false })
    renderPage()
    expect(await screen.findByRole('switch', { name })).not.toBeChecked()
  })

  it.each(SWITCHES)('toggles the $key switch when its visible sentence is clicked, and back on a second click', async ({ name, sentence }) => {
    renderPage()
    const sw = await screen.findByRole('switch', { name })
    await userEvent.click(screen.getByText(sentence))
    await waitFor(() => expect(sw).not.toBeChecked())
    await userEvent.click(screen.getByText(sentence))
    await waitFor(() => expect(sw).toBeChecked())
  })

  it.each(SWITCHES)('makes the $key switch hit target at least 24px tall and wide', async ({ name }) => {
    renderPage()
    const control = (await screen.findByRole('switch', { name })).parentElement as HTMLElement
    expect(parseFloat(control.style.height)).toBeGreaterThanOrEqual(24)
    expect(parseFloat(control.style.width)).toBeGreaterThanOrEqual(24)
  })

  it.each(SWITCHES)('toggles the $key switch from the keyboard', async ({ name }) => {
    renderPage()
    const sw = await screen.findByRole('switch', { name })
    sw.focus()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(sw).not.toBeChecked())
  })

  it.each(SWITCHES)('marks the $key input so its track takes the focus ring', async ({ name }) => {
    renderPage()
    const sw = await screen.findByRole('switch', { name })
    expect(sw).toHaveClass('fv-switch-input')
    const track = sw.nextElementSibling as HTMLElement
    expect(track.tagName).toBe('SPAN')
    expect(track.style.inset).toBe('0px')
  })

  it('draws the ring on the track only for keyboard focus', () => {
    expect(mobileCss).toMatch(/\.fv-switch-input:focus-visible\s*\+\s*span\s*\{[^}]*outline:\s*2px solid var\(--fv-focus-ring\)/)
    expect(mobileCss).not.toMatch(/\.fv-switch-input:focus\s*\+/)
  })

  it('does not toggle one switch when another switch sentence is clicked', async () => {
    renderPage()
    const replies = await screen.findByRole('switch', { name: SWITCHES[3].name })
    const week = screen.getByRole('switch', { name: SWITCHES[2].name })
    await userEvent.click(screen.getByText(SWITCHES[0].sentence))
    expect(replies).toBeChecked()
    expect(week).toBeChecked()
  })

  it('keeps the new bills switch available with the priority switch off, and saves it', async () => {
    signIn({ emailDigestEnabled: false })
    renderPage()
    const sw = await screen.findByRole('switch', { name: "New bills that may be relevant to your coalition" })
    expect(sw).not.toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Changes to priority bills' })).not.toBeChecked()
    await userEvent.click(screen.getByText(SWITCHES[1].sentence))
    await waitFor(() => expect(sw).not.toBeChecked())
    expect(api.apiFetch).toHaveBeenCalledWith('/users/me', { method: 'PATCH', body: JSON.stringify({ emailDigestMatchesEnabled: false }) })
  })

  it('names the new bills switch by its visible title', async () => {
    renderPage()
    const sw = await screen.findByRole('switch', { name: "New bills that may be relevant to your coalition" })
    expect(document.getElementById(sw.getAttribute('aria-labelledby') as string)).toHaveTextContent('New bills that may be relevant to your coalition')
  })
})
