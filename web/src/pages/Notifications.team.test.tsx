import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Notifications } from './Notifications'
import * as api from '../lib/api'

// "For your whole coalition": the switches that stop an email for every
// person, saved through /admin/config as the admin Notifications tab did.

const auth = vi.hoisted(() => ({ role: 'admin' as 'admin' | 'owner' }))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'A', role: auth.role, title: null,
      canVote: true, emailDigestEnabled: true, emailDigestMatchesEnabled: true, emailWeekAheadEnabled: true, emailRepliesEnabled: true,
      lastSeenFeed: null, isLastOwner: false,
    },
    loading: false, authError: false,
    setTitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setEmailRepliesEnabled: () => {},
    setEmailDigestMatchesEnabled: () => {}, setEmailWeekAheadEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))

const START = { 'email-digest': { enabled: true, settings: { frequency: 'daily', weeklyDay: '1' } }, 'week-ahead': { enabled: true, settings: { weeklyDay: '1' } } }

function mock(over: { modules?: Record<string, unknown>; conversationEmails?: boolean } = {}) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/config') return { modules: over.modules ?? START, mentionEmailsEnabled: over.conversationEmails ?? true } as never
    if (path === '/views') return { views: [] } as never
    if (path === '/roles') return [] as never
    return {} as never
  })
}

async function renderTeam() {
  render(<MemoryRouter><Notifications /></MemoryRouter>)
  const heading = await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' })
  return within(heading.parentElement as HTMLElement)
}

function puts() {
  return vi.mocked(api.apiFetch).mock.calls.filter(([p, o]) => p === '/admin/config' && (o as { method?: string } | undefined)?.method === 'PUT')
    .map(([, o]) => JSON.parse((o as { body: string }).body) as Record<string, unknown>)
}

beforeEach(() => {
  vi.restoreAllMocks()
  auth.role = 'admin'
  Element.prototype.scrollIntoView = vi.fn()
  mock()
})

describe('Notifications: for everyone on your team', () => {
  it('says the settings apply to every person, and never says "instance"', async () => {
    const team = await renderTeam()
    await team.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })
    expect(team.getByText('These settings apply to everyone. Turning an email off stops it for every person.')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/instance/i)
  })

  it('describes each team switch in plain words', async () => {
    const team = await renderTeam()
    expect(await team.findByText('One email that sums up what changed on your bills since the last one.')).toBeInTheDocument()
    expect(team.getByText("Next week's hearings on your coalition's priority bills and events on your coalition calendar.")).toBeInTheDocument()
    expect(team.getByText('Emails when someone mentions a member, a role, @admins, or @everyone, and when someone replies on a bill a member commented on. Members still see mentions and replies in FloorVote when this is off.')).toBeInTheDocument()
  })

  it('draws the digest as one flat choice of four, each with its description, and no digest switch', async () => {
    const team = await renderTeam()
    const group = await team.findByRole('group', { name: 'Send the email digest' })
    // One flat group: no nested question, and nothing but the four radios.
    expect(within(group).queryByRole('group')).not.toBeInTheDocument()
    const choices = within(group).getAllByRole('radio')
    expect(choices.map(r => r.getAttribute('aria-labelledby') && document.getElementById(r.getAttribute('aria-labelledby') as string)?.textContent)).toEqual(['Priority bills, new bills, and saved views', 'Priority bills and saved views', 'Saved views only', 'Off'])
    expect(within(group).getByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toHaveAccessibleDescription('Each person can unsubscribe from any of them.')
    expect(within(group).getByRole('radio', { name: 'Priority bills and saved views' })).toHaveAccessibleDescription('Admins still get new bills by default, and members can turn them on.')
    expect(within(group).getByRole('radio', { name: 'Saved views only' })).toHaveAccessibleDescription('Includes only the saved views each person follows.')
    expect(within(group).getByRole('radio', { name: 'Off' })).toHaveAccessibleDescription('')
    expect(team.queryByRole('switch', { name: 'Send the email digest' })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Should members get these as well/)
    expect(within(group).getByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toBeChecked()
  })

  it('reads the stored settings: enabled off is Off, teamUpdates off is Saved views only, newBillsDefault off is the second choice, anything else the first', async () => {
    for (const [modules, expected] of [
      [START, 'Priority bills, new bills, and saved views'],
      [{ ...START, 'email-digest': { enabled: true, settings: { frequency: 'daily', newBillsDefault: true } } }, 'Priority bills, new bills, and saved views'],
      [{ ...START, 'email-digest': { enabled: true, settings: { frequency: 'daily', newBillsDefault: false } } }, 'Priority bills and saved views'],
      [{ ...START, 'email-digest': { enabled: true, settings: { frequency: 'daily', teamUpdates: false, newBillsDefault: false } } }, 'Saved views only'],
      [{ ...START, 'email-digest': { enabled: true, settings: { frequency: 'daily', teamUpdates: false } } }, 'Saved views only'],
      [{ ...START, 'email-digest': { enabled: false, settings: { frequency: 'daily', teamUpdates: true } } }, 'Off'],
    ] as const) {
      mock({ modules })
      const { unmount } = render(<MemoryRouter><Notifications /></MemoryRouter>)
      const heading = await screen.findByRole('heading', { level: 2, name: 'For your whole coalition' })
      const team = within(heading.parentElement as HTMLElement)
      await waitFor(() => expect(team.getByRole('radio', { name: expected })).toBeChecked())
      unmount()
    }
  })

  it('saves Saved views only as enabled with teamUpdates off, after a confirm, keeping the schedule', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('radio', { name: 'Saved views only' }))
    expect(confirm).toHaveBeenCalledWith('Switch the email digest to saved views only for everyone? This stops priority bills and new bills for all members, not just you. Members still get the saved views they follow.')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect((puts()[0].modules as Record<string, unknown>)['email-digest']).toEqual({ enabled: true, settings: { frequency: 'daily', weeklyDay: '1', teamUpdates: false } })
  })

  it('does not save Saved views only when the confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('radio', { name: 'Saved views only' }))
    expect(puts()).toEqual([])
    expect(team.getByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toBeChecked()
  })

  it('saves Off as the module disabled, after the same confirm as before', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('radio', { name: 'Off' }))
    expect(confirm).toHaveBeenCalledWith('Turn off the email digest for everyone? This stops it for all members, not just you. Members can also opt out individually on their Notifications tab.')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect((puts()[0].modules as Record<string, { enabled: boolean }>)['email-digest'].enabled).toBe(false)
  })

  it('saves the first choice from Saved views only with no confirm, and Saved views only from Off with none either', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mock({ modules: { ...START, 'email-digest': { enabled: true, settings: { frequency: 'daily', teamUpdates: false } } } })
    const team = await renderTeam()
    await waitFor(() => expect(team.getByRole('radio', { name: 'Saved views only' })).toBeChecked())
    await userEvent.click(team.getByRole('radio', { name: 'Priority bills, new bills, and saved views' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect((puts()[0].modules as Record<string, unknown>)['email-digest']).toEqual({ enabled: true, settings: { frequency: 'daily', teamUpdates: true, newBillsDefault: true } })
    expect(confirm).not.toHaveBeenCalled()
    await userEvent.click(team.getByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(puts()).toHaveLength(2))
    confirm.mockClear()
    await userEvent.click(team.getByRole('radio', { name: 'Saved views only' }))
    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(puts()).toHaveLength(3))
    expect((puts()[2].modules as Record<string, unknown>)['email-digest']).toEqual({ enabled: true, settings: { frequency: 'daily', teamUpdates: false, newBillsDefault: true } })
  })

  it('puts the conversation switch under the existing mention_emails_enabled key', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('switch', { name: 'Send emails about comments' }))
    await waitFor(() => expect(puts()).toEqual([{ mention_emails_enabled: false }]))
  })

  it('confirms before turning the comment emails off, without the opt-out sentence', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('switch', { name: 'Send emails about comments' }))
    expect(confirm).toHaveBeenCalledWith('Turn off comment emails for everyone? This stops them for all members, not just you.')
  })

  it('confirms before turning the week ahead email off, then saves the module', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('switch', { name: 'Send the week ahead email' }))
    expect(confirm).toHaveBeenCalledWith('Turn off the week ahead email for everyone? This stops it for all members, not just you. Members can also opt out individually on their Notifications tab.')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect((puts()[0].modules as Record<string, { enabled: boolean }>)['week-ahead'].enabled).toBe(false)
  })

  it('does not save when the confirm is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('switch', { name: 'Send emails about comments' }))
    expect(puts()).toEqual([])
    expect(team.getByRole('switch', { name: 'Send emails about comments' })).toBeChecked()
  })

  it('turns an email on without a confirm', async () => {
    mock({ conversationEmails: false })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await waitFor(() => expect(team.getByRole('switch', { name: 'Send emails about comments' })).not.toBeChecked())
    await userEvent.click(team.getByRole('switch', { name: 'Send emails about comments' }))
    await waitFor(() => expect(puts()).toEqual([{ mention_emails_enabled: true }]))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('saves the week ahead day', async () => {
    const team = await renderTeam()
    const [day] = await team.findAllByRole('combobox', { name: 'Day of week' })
    await userEvent.selectOptions(day, '5')
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect((puts()[0].modules as Record<string, { settings: Record<string, string> }>)['week-ahead'].settings.weeklyDay).toBe('5')
  })

  it('disables the schedule selects of an email that is off', async () => {
    mock({ modules: { 'email-digest': { enabled: false, settings: { frequency: 'daily' } }, 'week-ahead': { enabled: false } } })
    const team = await renderTeam()
    await waitFor(() => expect(team.getByRole('combobox', { name: 'Day of week' })).toBeDisabled())
    for (const s of team.getAllByRole('combobox')) expect(s).toBeDisabled()
  })

  it('boxes each team setting with an id of its own, apart from the ids the email footers link to', async () => {
    const team = await renderTeam()
    await team.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })
    for (const id of ['setting-email-digest', 'setting-week-ahead', 'setting-email-replies']) {
      expect(screen.getByRole('heading', { level: 2, name: 'For your whole coalition' }).parentElement).not.toContainElement(document.getElementById(id))
    }
  })

  it('shows an owner the same team section', async () => {
    auth.role = 'owner'
    const team = await renderTeam()
    expect(await team.findByRole('radio', { name: 'Priority bills, new bills, and saved views' })).toBeInTheDocument()
  })
})

// #1036: the four choices store enabled, teamUpdates and newBillsDefault together.
describe('Notifications: the four digest choices store the three settings', () => {
  const withDigest = (digest: Record<string, unknown>) => ({ ...START, 'email-digest': digest })
  const saved = () => (puts()[0].modules as Record<string, { enabled: boolean; settings: Record<string, unknown> }>)['email-digest']

  it('saves "Priority bills and saved views" as enabled, teamUpdates on, newBillsDefault off, with no confirm', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('radio', { name: 'Priority bills and saved views' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(saved()).toEqual({ enabled: true, settings: { frequency: 'daily', weeklyDay: '1', teamUpdates: true, newBillsDefault: false } })
    expect(team.getByRole('radio', { name: 'Priority bills and saved views' })).toBeChecked()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('saves "Priority bills, new bills, and saved views" as enabled, teamUpdates on, newBillsDefault on, with no confirm, moving up from the second choice', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mock({ modules: withDigest({ enabled: true, settings: { frequency: 'daily', newBillsDefault: false } }) })
    const team = await renderTeam()
    await waitFor(() => expect(team.getByRole('radio', { name: 'Priority bills and saved views' })).toBeChecked())
    await userEvent.click(team.getByRole('radio', { name: 'Priority bills, new bills, and saved views' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(saved().settings).toMatchObject({ teamUpdates: true, newBillsDefault: true })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('leaves newBillsDefault as it is for Saved views only, and the rest as they are for Off', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mock({ modules: withDigest({ enabled: true, settings: { frequency: 'daily', newBillsDefault: false } }) })
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('radio', { name: 'Saved views only' }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(saved()).toEqual({ enabled: true, settings: { frequency: 'daily', newBillsDefault: false, teamUpdates: false } })
    await userEvent.click(team.getByRole('radio', { name: 'Off' }))
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect((puts()[1].modules as Record<string, { enabled: boolean; settings: Record<string, unknown> }>)['email-digest']).toEqual({ enabled: false, settings: { frequency: 'daily', newBillsDefault: false, teamUpdates: false } })
  })

  it('asks before Saved views only from the second choice too', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mock({ modules: withDigest({ enabled: true, settings: { frequency: 'daily', newBillsDefault: false } }) })
    const team = await renderTeam()
    await userEvent.click(await team.findByRole('radio', { name: 'Saved views only' }))
    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
