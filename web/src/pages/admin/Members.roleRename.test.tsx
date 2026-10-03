import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { Members } from './Members'
import * as api from '../../lib/api'
import { REQUIRED_MESSAGE } from '../../components/RequiredField'
import { inlineEditCancelStyle, inlineEditSaveStyle } from '../../lib/inlineEditStyles'
import { itGatesQuietly, expectMessageShown, expectMessageHidden, expectQuietlyBlocked, expectButtonStyle, gateMessage } from '../../test/quietGate'

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

const ROLE = { id: 'r1', name: 'Finance Committee' }

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'owner-1', email: 'owner@example.com', name: 'Sole Owner', role: 'owner' },
    loading: false,
  }),
}))

// DemoContext's default value (no provider wrapping) is demoLocked: false; a
// mutable flag lets individual tests opt into the demo-locked state without a
// module-level mock rewrite per test.
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockApi() {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/members') return [OWNER] as never
    if (path === '/admin/roles') return [ROLE] as never
    if (path === `/admin/roles/${ROLE.id}` && init?.method === 'PATCH') {
      return { ...ROLE, ...JSON.parse(String(init.body)) } as never
    }
    if (path === '/admin/config') return {} as never
    return {} as never
  })
}

afterEach(() => { vi.restoreAllMocks(); demoState.demoLocked = false })

// The role-rename "click to rename" affordance was a plain span with an
// onClick handler — unreachable by keyboard. It must be a real button.
describe('Members role-rename inline edit keyboard access', () => {
  it('renders the role-rename affordance as a button and enters rename mode from the keyboard', async () => {
    const user = userEvent.setup()
    mockApi()

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const rename = await screen.findByRole('button', { name: /rename role finance committee/i })
    rename.focus()
    await user.keyboard('{Enter}')

    expect(await screen.findByDisplayValue('Finance Committee')).toBeInTheDocument()
  })

  it('disables the role-rename button in demo-locked mode', async () => {
    demoState.demoLocked = true
    mockApi()

    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )

    const rename = await screen.findByRole('button', { name: /rename role finance committee/i })
    expect(rename).toBeDisabled()
  })
})

// Renaming a role refuses a blank name with the shared quiet gate. The rename
// editor has Save and Cancel beside the chip; while the name is blank or
// whitespace, Save looks disabled (aria-disabled) and reveals "Fill in the
// required items first." on hover, focus, click/tap, or Enter in the field,
// never renaming and keeping the editor open (it used to close and silently put
// the old name back).
describe('Members role rename: blank name', () => {
  function patchCalls() {
    return vi.mocked(api.apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')
  }

  async function beginRename() {
    const user = userEvent.setup()
    mockApi()
    render(
      <MemoryRouter>
        <Members />
      </MemoryRouter>,
    )
    await user.click(await screen.findByRole('button', { name: /rename role finance committee/i }))
    return { user, input: screen.getByRole('textbox', { name: 'Role name' }) as HTMLInputElement }
  }

  const saveButton = () => screen.getByRole('button', { name: 'Save role name' })
  const cancelButton = () => screen.getByRole('button', { name: 'Cancel renaming role' })

  describe('Save gated while the name is empty', () => {
    itGatesQuietly(async () => {
      const { user, input } = await beginRename()
      await user.clear(input)
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  describe('Save gated while the name is whitespace', () => {
    itGatesQuietly(async () => {
      const { user, input } = await beginRename()
      await user.clear(input)
      await user.type(input, '   ')
      return { user, button: saveButton, submitted: () => patchCalls().length }
    })
  })

  it('opens with the current name, a required input, the standard Save and Cancel, and no message', async () => {
    const { input } = await beginRename()
    expect(input).toHaveValue('Finance Committee')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    expectButtonStyle(saveButton(), inlineEditSaveStyle(false))
    expectButtonStyle(cancelButton(), inlineEditCancelStyle())
    expectMessageHidden(saveButton())
  })

  it('greys Save as soon as the name is cleared, without showing the message', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    expectQuietlyBlocked(saveButton())
    expectButtonStyle(saveButton(), inlineEditSaveStyle(true))
    expectMessageHidden(saveButton())
  })

  it('no longer uses the old per-editor "Role name is required" text or an alert', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.click(saveButton())
    await user.type(input, '{Enter}')
    expect(screen.queryByText(/is required/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter on a blank name does not rename, and reveals the message tied to the field', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
    expect(input).toHaveAccessibleDescription(REQUIRED_MESSAGE)
  })

  it('Enter on a whitespace-only name does not rename, and reveals the message', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.type(input, '   {Enter}')
    expect(patchCalls()).toHaveLength(0)
    expectMessageShown(saveButton())
  })

  it('keeps the editor open instead of silently reverting', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.type(input, '{Enter}')
    await user.click(saveButton())

    expect(screen.getByRole('textbox', { name: 'Role name' })).toBe(input)
    expect(input).toHaveValue('')
    expect(screen.queryByRole('button', { name: /rename role finance committee/i })).not.toBeInTheDocument()
  })

  it('hides the message once a name is typed, and then renames with Enter', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.type(input, 'Budget Committee')
    expectMessageHidden(saveButton())
    expect(input).not.toHaveAttribute('aria-describedby')

    await user.type(input, '{Enter}')
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      `/admin/roles/${ROLE.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Budget Committee' }) }),
    ))
    expect(await screen.findByRole('button', { name: /rename role budget committee/i })).toBeInTheDocument()
  })

  it('renames with the Save button, trimmed', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.type(input, '  Budget Committee ')
    await user.click(saveButton())
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      `/admin/roles/${ROLE.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Budget Committee' }) }),
    ))
    expect(await screen.findByRole('button', { name: /rename role budget committee/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save role name' })).not.toBeInTheDocument()
  })

  it('Escape cancels: the old name returns, and reopening shows no message', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.type(input, '{Escape}')
    expect(gateMessage()).toBeNull()
    await user.click(screen.getByRole('button', { name: /rename role finance committee/i }))
    const again = screen.getByRole('textbox', { name: 'Role name' })
    expect(again).toHaveValue('Finance Committee')
    await user.clear(again)
    expectMessageHidden(saveButton())
    expect(patchCalls()).toHaveLength(0)
  })

  it('Cancel cancels: the old name returns, and reopening shows no message', async () => {
    const { user, input } = await beginRename()
    await user.clear(input)
    await user.click(saveButton())
    expectMessageShown(saveButton())

    await user.click(cancelButton())
    expect(gateMessage()).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Role name' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /rename role finance committee/i }))
    const again = screen.getByRole('textbox', { name: 'Role name' })
    await user.clear(again)
    expectMessageHidden(saveButton())
    expect(patchCalls()).toHaveLength(0)
  })

  it('reopening after a rename made while Save was hovered starts quiet', async () => {
    const { user, input } = await beginRename()
    await user.hover(saveButton())
    await user.type(input, ' 2{Enter}', { skipClick: true })
    const rename = await screen.findByRole('button', { name: /rename role finance committee 2/i })

    fireEvent.click(rename)
    fireEvent.change(screen.getByRole('textbox', { name: 'Role name' }), { target: { value: '' } })
    expectMessageHidden(saveButton())
  })

  it('saving the unchanged name closes the editor without a request', async () => {
    const { user, input } = await beginRename()
    await user.type(input, '{Enter}')

    expect(await screen.findByRole('button', { name: /rename role finance committee/i })).toBeInTheDocument()
    expect(gateMessage()).toBeNull()
    expect(patchCalls()).toHaveLength(0)
  })
})
