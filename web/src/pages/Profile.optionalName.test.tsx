import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Profile } from './Profile'
import * as api from '../lib/api'

// The Profile name is optional, and a set name can be cleared (#233): saving
// with a blank name sends it as a clear, shows "Saved", and leaves the field
// blank. The user then shows by email wherever a name would appear.

const auth = vi.hoisted(() => ({ setName: vi.fn(), setSubtitle: vi.fn() }))
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 'u1', email: 'a@b.c', name: 'Current Name', role: 'member', subtitle: null,
      canVote: true, emailDigestEnabled: true, emailWeekAheadEnabled: true, lastSeenFeed: null,
      isLastOwner: false,
    },
    loading: false, authError: false,
    setSubtitle: auth.setSubtitle, setName: auth.setName, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  }),
}))
vi.mock('../context/ConfigContext', () => ({
  useConfig: () => ({ config: { orgNoun: 'coalition' }, multiState: false, loading: false }),
}))
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockApi({ holdSave = false }: { holdSave?: boolean } = {}) {
  let release: () => void = () => {}
  const patches: Record<string, unknown>[] = []
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/users/me' && init?.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)))
      if (holdSave) await new Promise<void>(resolve => { release = resolve })
      return {} as never
    }
    return {} as never
  })
  return { patches, release: () => release() }
}

function setup() {
  const user = userEvent.setup()
  render(<MemoryRouter><Profile /></MemoryRouter>)
  const card = screen.getByRole('heading', { level: 1, name: 'Profile' }).parentElement as HTMLElement
  return { user, card }
}

const nameInput = () => screen.getByLabelText(/^name/i)
const subtitleInput = (card: HTMLElement) => within(card).getAllByRole('textbox').find(el => el.id !== 'name-input') as HTMLElement
const saveButton = (card: HTMLElement) => within(card).getByRole('button', { name: /^(save|saving…)$/i })

beforeEach(() => { vi.restoreAllMocks(); auth.setName.mockReset(); auth.setSubtitle.mockReset() })
afterEach(() => { demoState.demoLocked = false })

describe('Profile name is optional', () => {
  it('shows no required legend, asterisk, or aria-required for the name', () => {
    mockApi()
    const { card } = setup()
    expect(within(card).queryByText('Required')).not.toBeInTheDocument()
    expect(nameInput()).not.toHaveAttribute('aria-required')
    expect(document.querySelector('label[for="name-input"]')).not.toHaveTextContent('*')
  })

  it('keeps Save enabled with the name cleared, and shows no missing-field reason', async () => {
    mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    expect(saveButton(card)).toBeEnabled()
    expect(within(card).queryByText('Missing a required field')).not.toBeInTheDocument()
  })

  it('treats a whitespace-only name like a blank one: Save stays enabled', async () => {
    mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.type(nameInput(), '   ')
    expect(saveButton(card)).toBeEnabled()
  })

  it('saves the subtitle with a blank name and shows "Saved"', async () => {
    const { patches } = mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.type(subtitleInput(card), 'Policy lead')
    await user.click(saveButton(card))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].subtitle).toBe('Policy lead')
    expect(auth.setSubtitle).toHaveBeenCalledWith('Policy lead')
    expect(await within(card).findByText('Saved')).toBeInTheDocument()
  })

  it('sends a cleared name as a blank name, shows "Saved", and leaves the field blank', async () => {
    const { patches } = mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.click(saveButton(card))
    expect(await within(card).findByText('Saved')).toBeInTheDocument()
    expect(patches).toEqual([{ name: '', subtitle: null }])
    expect(nameInput()).toHaveValue('')
    expect(auth.setName).toHaveBeenCalledWith('')
  })

  it('treats a whitespace-only name as a clear and blanks the field after saving', async () => {
    const { patches } = mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.type(nameInput(), '   ')
    await user.click(saveButton(card))
    expect(await within(card).findByText('Saved')).toBeInTheDocument()
    expect(patches[0].name).toBe('')
    expect(nameInput()).toHaveValue('')
    expect(auth.setName).toHaveBeenCalledWith('')
  })

  it('never puts the old name back after clearing it', async () => {
    mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.click(saveButton(card))
    await within(card).findByText('Saved')
    expect(nameInput()).not.toHaveValue('Current Name')
    expect(auth.setName).not.toHaveBeenCalledWith('Current Name')
  })

  it('clears the name and saves the subtitle in the same request', async () => {
    const { patches } = mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.type(subtitleInput(card), 'Policy lead')
    await user.click(saveButton(card))
    await within(card).findByText('Saved')
    expect(patches).toEqual([{ name: '', subtitle: 'Policy lead' }])
    expect(auth.setName).toHaveBeenCalledWith('')
    expect(auth.setSubtitle).toHaveBeenCalledWith('Policy lead')
  })

  it('sends no name when only the digest setting is toggled', async () => {
    const { patches } = mockApi()
    setup()
    const user = userEvent.setup()
    await user.click(screen.getByRole('switch', { name: 'Toggle Email digest of recent bill activity' }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).not.toHaveProperty('name')
    expect(patches[0]).not.toHaveProperty('subtitle')
    expect(auth.setName).not.toHaveBeenCalled()
  })

  it('still saves a changed, non-blank name', async () => {
    const { patches } = mockApi()
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.type(nameInput(), '  New Name  ')
    await user.click(saveButton(card))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].name).toBe('New Name')
    expect(auth.setName).toHaveBeenCalledWith('New Name')
    expect(nameInput()).toHaveValue('New Name')
  })

  it('keeps the blank field and does not clear the name locally when the save fails', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/users/me' && init?.method === 'PATCH') throw new Error('boom')
      return {} as never
    })
    const { user, card } = setup()
    await user.clear(nameInput())
    await user.click(saveButton(card))
    expect(await within(card).findByText(/failed to save/i)).toBeInTheDocument()
    expect(nameInput()).toHaveValue('')
    expect(auth.setName).not.toHaveBeenCalled()
  })

  it('disables Save under demo lock', () => {
    demoState.demoLocked = true
    mockApi()
    const { card } = setup()
    expect(saveButton(card)).toBeDisabled()
  })

  it('disables Save while a save is in flight, then re-enables it', async () => {
    const { release } = mockApi({ holdSave: true })
    const { user, card } = setup()
    await user.click(saveButton(card))
    expect(saveButton(card)).toBeDisabled()
    await act(async () => { release() })
    await waitFor(() => expect(saveButton(card)).toBeEnabled())
  })
})
