import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewSwitcher, type SavedView } from './ViewSwitcher'
import * as api from '../../lib/api'
import { inlineEditSaveStyle } from '../../lib/inlineEditStyles'
import { itGatesQuietly, expectMessageShown, expectMessageHidden, expectQuietlyBlocked, expectButtonStyle } from '../../test/quietGate'

// Renaming a saved view refuses a blank name with the shared quiet gate: while
// the name is blank or whitespace, Save looks disabled (aria-disabled) and
// reveals "Fill in the required items first." on hover, focus, click/tap, or
// Enter in the field, never renaming and keeping the row in its editing state.

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false, settled: true }),
}))

const VIEWS: SavedView[] = [
  { id: 'v1', name: 'Clerk bills', query: 'subject=UT%3AElections' },
  { id: 'v2', name: 'Auditor bills', query: 'subject=UT%3AAudits' },
]

function renderSwitcher(onRename = vi.fn().mockResolvedValue(undefined)) {
  const user = userEvent.setup()
  render(
    <ViewSwitcher
      views={VIEWS}
      currentSearch=""
      isAdmin
      onApply={vi.fn()}
      onRename={onRename}
      onDelete={vi.fn()}
      onReorder={vi.fn()}
      onOverwrite={vi.fn()}
    />,
  )
  return { user, onRename }
}

async function beginRename(user: ReturnType<typeof userEvent.setup>, name = 'Clerk bills') {
  if (!screen.queryByRole('group', { name: 'Saved views' })) {
    await user.click(screen.getByRole('button', { name: /views/i }))
  }
  fireEvent.mouseEnter(screen.getByText(name).closest('div')!)
  await user.click(screen.getByRole('button', { name: `Rename "${name}"` }))
  return screen.getByRole('textbox', { name: 'View name' }) as HTMLInputElement
}

const saveButton = () => screen.getByRole('button', { name: /^save$/i })


beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'apiFetch').mockResolvedValue({ pagination: { total: 1 } } as never)
})

describe('ViewSwitcher rename: Save gated while the name is empty', () => {
  itGatesQuietly(async () => {
    const { user, onRename } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    return { user, button: saveButton, submitted: () => onRename.mock.calls.length }
  })
})

describe('ViewSwitcher rename: Save gated while the name is whitespace', () => {
  itGatesQuietly(async () => {
    const { user, onRename } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '   ')
    return { user, button: saveButton, submitted: () => onRename.mock.calls.length }
  })
})

describe('ViewSwitcher rename: blank name', () => {
  it('opens with the current name, Save enabled and no message', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    expect(input).toHaveValue('Clerk bills')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    expectButtonStyle(saveButton(), inlineEditSaveStyle(false))
    expectMessageHidden(saveButton())
  })

  it('greys Save as soon as the name is cleared, without showing the message', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    expectQuietlyBlocked(saveButton())
    expectButtonStyle(saveButton(), inlineEditSaveStyle(true))
    expectMessageHidden(saveButton())
  })

  it('no longer uses the old per-editor "View name is required" text or an alert', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.click(saveButton())
    await user.type(input, '{Enter}')
    expect(screen.queryByText(/is required/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter on a blank name does not rename, and reveals the message tied to the field', async () => {
    const { user, onRename } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '{Enter}')
    expect(onRename).not.toHaveBeenCalled()
    expectMessageShown(saveButton())
    expect(input).toHaveAccessibleDescription('Fill in the required items first.')
  })

  it('Enter on a whitespace-only name does not rename, and reveals the message', async () => {
    const { user, onRename } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '  {Enter}')
    expect(onRename).not.toHaveBeenCalled()
    expectMessageShown(saveButton())
  })

  it('keeps the row in its editing state after a refused save', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.click(saveButton())
    await user.type(input, '{Enter}')
    expect(screen.getByRole('textbox', { name: 'View name' })).toBe(input)
    expect(screen.getByRole('group', { name: 'Saved views' })).toBeInTheDocument()
  })

  it('hides the message once a name is typed, and then renames', async () => {
    const { user, onRename } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.type(input, 'County clerk bills')
    expectMessageHidden(saveButton())
    expect(input).not.toHaveAttribute('aria-describedby')

    await user.click(saveButton())
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('v1', 'County clerk bills'))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument())
  })

  it('renames with Enter once a name is typed, trimmed', async () => {
    const { user, onRename } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, ' County clerk bills {Enter}')
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('v1', 'County clerk bills'))
  })

  it('Cancel ends the rename; renaming again shows no message', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '{Enter}')
    await user.click(saveButton())
    expectMessageShown(saveButton())

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument()

    const again = await beginRename(user)
    await user.clear(again)
    expectMessageHidden(saveButton())
  })

  it('Escape ends the rename; renaming again shows no message', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '{Enter}')
    expectMessageShown(saveButton())

    await user.type(input, '{Escape}')
    expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument()
    const again = await beginRename(user)
    await user.clear(again)
    expectMessageHidden(saveButton())
  })

  it('renaming a different view starts quiet', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.clear(input)
    await user.type(input, '{Enter}')
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    const other = await beginRename(user, 'Auditor bills')
    expect(other).toHaveValue('Auditor bills')
    await user.clear(other)
    expectMessageHidden(saveButton())
  })

  it('renaming again after a save made while Save was hovered starts quiet', async () => {
    const { user } = renderSwitcher()
    const input = await beginRename(user)
    await user.click(input)
    await user.hover(saveButton())
    // skipClick: the pointer stays on Save while Enter renames and closes.
    await user.type(input, '2{Enter}', { skipClick: true })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument())

    const again = await beginRename(user)
    fireEvent.change(again, { target: { value: '' } })
    expectMessageHidden(saveButton())
  })
})
