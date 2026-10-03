import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import { itGatesQuietly, expectMessageHidden, expectMessageShown, expectQuietlyBlocked } from '../../test/quietGate'
import * as api from '../../lib/api'

// The quiet required-field gate on the "Add role" form: the role name is
// required and keeps aria-required, but this single-input form shows no
// asterisk or legend. Add looks disabled while the name is blank and says
// "Fill in the required items first." only when someone tries it.

const OWNER = {
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

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockApi({ holdCreate = false }: { holdCreate?: boolean } = {}) {
  let release: () => void = () => {}
  const posted: unknown[] = []
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/members') return [OWNER] as never
    if (path === '/admin/roles' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      posted.push(body)
      if (holdCreate) await new Promise<void>(resolve => { release = resolve })
      return { id: 'r-new', name: body.name } as never
    }
    if (path === '/admin/roles') return [] as never
    if (path === '/admin/config') return {} as never
    return {} as never
  })
  return { posted, release: () => release() }
}

async function setup() {
  const user = userEvent.setup()
  render(<MemoryRouter><Members /></MemoryRouter>)
  const form = await screen.findByRole('group', { name: 'Add role' })
  return { user, form }
}

function nameInput(form: HTMLElement) {
  return within(form).getByRole('textbox', { name: /role name/i })
}
function addButton(form: HTMLElement) {
  return within(form).getByRole('button', { name: /^(add|adding…)$/i })
}

afterEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false })

describe('Members "Add role": quiet gate while the name is blank', () => {
  itGatesQuietly(async () => {
    const { posted } = mockApi()
    const { user, form } = await setup()
    return { user, button: () => addButton(form), submitted: () => posted.length, scope: () => form }
  })
})

describe('Members "Add role": markers', () => {
  it('shows no "* Required" legend and no asterisk', async () => {
    mockApi()
    const { form } = await setup()
    expect(within(form).queryByText('Required')).not.toBeInTheDocument()
    expect(form.textContent).not.toContain('*')
  })

  it('gives the role name input an accessible name and aria-required', async () => {
    mockApi()
    const { form } = await setup()
    const input = nameInput(form)
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(input).toHaveAccessibleName('New role name')
  })
})

describe('Members "Add role": filling and clearing', () => {
  it('lifts the gate once a name is typed, with no message on hover, and adds the role', async () => {
    const { posted } = mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), 'Finance')
    expect(addButton(form)).toBeEnabled()
    expect(addButton(form)).not.toHaveAttribute('aria-disabled')
    await user.hover(addButton(form))
    expectMessageHidden(addButton(form), form)
    await user.click(addButton(form))
    await waitFor(() => expect(posted).toEqual([{ name: 'Finance' }]))
  })

  it('blocks quietly again when the name is cleared', async () => {
    mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), 'Finance')
    await user.clear(nameInput(form))
    expectQuietlyBlocked(addButton(form))
    expectMessageHidden(addButton(form), form)
  })

  it('hides a shown message once a name is typed', async () => {
    mockApi()
    const { user, form } = await setup()
    await user.hover(addButton(form))
    expectMessageShown(addButton(form), form)
    await user.type(nameInput(form), 'F')
    expectMessageHidden(addButton(form), form)
  })

  it('treats a whitespace-only name as missing', async () => {
    const { posted } = mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), '   ')
    expectQuietlyBlocked(addButton(form))
    await user.click(addButton(form))
    expect(posted).toHaveLength(0)
    expectMessageShown(addButton(form), form)
  })

  it('treats a name made only of stripped "@" characters as missing', async () => {
    mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), '@@')
    expectQuietlyBlocked(addButton(form))
  })

  it('does not send a request for a blank name on Enter', async () => {
    const { posted } = mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), '  {Enter}')
    expect(posted).toHaveLength(0)
  })

  it('is quiet again after a role is added and the input resets', async () => {
    const { posted } = mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), 'Finance')
    await user.click(addButton(form))
    await waitFor(() => expect(posted).toHaveLength(1))
    await waitFor(() => expect(nameInput(form)).toHaveValue(''))
    expectQuietlyBlocked(addButton(form))
    expectMessageHidden(addButton(form), form)
  })
})

describe('Members "Add role": other disabled reasons show no message', () => {
  it('demo lock with a name typed: natively disabled, quiet', async () => {
    demoState.demoLocked = true
    mockApi()
    const { user, form } = await setup()
    await user.type(nameInput(form), 'Finance')
    expect(addButton(form)).toBeDisabled()
    expect(addButton(form)).not.toHaveAttribute('aria-disabled')
    await user.hover(addButton(form))
    expectMessageHidden(addButton(form), form)
  })

  it('demo lock while the name is blank: natively disabled, quiet', async () => {
    demoState.demoLocked = true
    mockApi()
    const { user, form } = await setup()
    expect(addButton(form)).toBeDisabled()
    await user.hover(addButton(form))
    expectMessageHidden(addButton(form), form)
  })

  it('a create request in flight: natively disabled, quiet', async () => {
    const { posted, release } = mockApi({ holdCreate: true })
    const { user, form } = await setup()
    await user.type(nameInput(form), 'Finance')
    await user.click(addButton(form))
    await waitFor(() => expect(posted).toHaveLength(1))
    const busy = within(form).getByRole('button', { name: /adding/i })
    expect(busy).toBeDisabled()
    expect(busy).not.toHaveAttribute('aria-disabled')
    expectMessageHidden(busy, form)
    await act(async () => { release() })
  })
})
