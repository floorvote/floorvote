import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SaveViewButton } from './SaveViewButton'
import { inlineEditCancelStyle, inlineEditSaveStyle } from '../../lib/inlineEditStyles'
import { itGatesQuietly, expectMessageShown, expectMessageHidden, expectQuietlyBlocked, expectButtonStyle } from '../../test/quietGate'

// "Save as view" refuses a blank name with the shared quiet gate: while the
// name is blank or whitespace, "Save view" looks disabled (aria-disabled) and
// reveals "Fill in the required items first." on hover, focus, click/tap, or
// Enter in the field, never saving and keeping the popover open. "Save view"
// is the standard blue inline-edit Save, greyed while blocked, beside the
// standard Cancel.

function renderButton(onSave = vi.fn().mockResolvedValue(undefined)) {
  const user = userEvent.setup()
  render(<SaveViewButton currentSearch="?status=1" onSave={onSave} />)
  return { user, onSave }
}

async function openPopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /save as view/i }))
  return screen.getByRole('textbox', { name: 'View name' }) as HTMLInputElement
}


const saveView = () => screen.getByRole('button', { name: /^save view$/i })

describe('SaveViewButton: Save view gated while the name is empty', () => {
  itGatesQuietly(async () => {
    const { user, onSave } = renderButton()
    await openPopover(user)
    return { user, button: saveView, submitted: () => onSave.mock.calls.length }
  })
})

describe('SaveViewButton: Save view gated while the name is whitespace', () => {
  itGatesQuietly(async () => {
    const { user, onSave } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '   ')
    return { user, button: saveView, submitted: () => onSave.mock.calls.length }
  })
})

describe('SaveViewButton: blank name', () => {
  it('marks the name input as required', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    expect(input).toHaveAttribute('aria-required', 'true')
  })

  it('no longer uses the old per-editor "View name is required" text or an alert', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    await user.click(saveView())
    await user.type(input, '{Enter}')
    expect(screen.queryByText(/is required/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter on a blank name does not save, and reveals the message tied to the field', async () => {
    const { user, onSave } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '{Enter}')
    expect(onSave).not.toHaveBeenCalled()
    expectMessageShown(saveView())
    expect(input).toHaveAccessibleDescription('Fill in the required items first.')
  })

  it('Enter on a whitespace-only name does not save, and reveals the message', async () => {
    const { user, onSave } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '   {Enter}')
    expect(onSave).not.toHaveBeenCalled()
    expectMessageShown(saveView())
  })

  it('keeps the popover open after a refused save', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    await user.click(saveView())
    await user.type(input, '{Enter}')
    expect(screen.getByRole('textbox', { name: 'View name' })).toBe(input)
  })

  it('hides the message once a name is typed, and then saves it', async () => {
    const { user, onSave } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '{Enter}')
    expectMessageShown(saveView())

    await user.type(input, 'Clerk bills')
    expectMessageHidden(saveView())
    expect(saveView()).not.toHaveAttribute('aria-disabled')
    expect(input).not.toHaveAttribute('aria-describedby')

    await user.click(saveView())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Clerk bills'))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument())
  })

  it('saves with Enter once a name is typed', async () => {
    const { user, onSave } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '  Clerk bills  {Enter}')
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('Clerk bills'))
  })

  it('Cancel closes the popover; reopening shows no message', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '{Enter}')
    await user.click(saveView())
    expectMessageShown(saveView())

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument()

    await openPopover(user)
    expectMessageHidden(saveView())
  })

  it('closing from the trigger, then reopening, shows no message', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    await user.type(input, '{Enter}')
    expectMessageShown(saveView())

    await user.click(screen.getByRole('button', { name: /save as view/i }))
    await openPopover(user)
    expectMessageHidden(saveView())
  })

  it('reopening after a save while Save view was hovered shows no message', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    await user.type(input, 'Clerk bills')
    await user.hover(saveView())
    await user.type(input, '{Enter}', { skipClick: true })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument())

    await openPopover(user)
    expectQuietlyBlocked(saveView())
    expectMessageHidden(saveView())
  })
})

describe('SaveViewButton: button styles', () => {
  it('"Save view" is the standard Save, greyed while the name is blank', async () => {
    const { user } = renderButton()
    await openPopover(user)
    expectButtonStyle(saveView(), inlineEditSaveStyle(true))
  })

  it('"Save view" turns standard blue once a name is typed', async () => {
    const { user } = renderButton()
    const input = await openPopover(user)
    await user.type(input, 'Clerk bills')
    expectButtonStyle(saveView(), inlineEditSaveStyle(false))
    expect(saveView().style.cursor).toBe('pointer')
  })

  it('its Cancel is the standard Cancel', async () => {
    const { user } = renderButton()
    await openPopover(user)
    expectButtonStyle(screen.getByRole('button', { name: /^cancel$/i }), inlineEditCancelStyle())
  })

  it('Save view is natively disabled, with no message, while a save is in flight', async () => {
    let finish: () => void = () => {}
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const { user } = renderButton(onSave)
    const input = await openPopover(user)
    await user.type(input, 'Clerk bills')
    await user.click(saveView())
    expect(saveView()).toBeDisabled()
    expect(saveView()).not.toHaveAttribute('aria-disabled')
    await user.hover(saveView())
    expectMessageHidden(saveView())
    finish()
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'View name' })).not.toBeInTheDocument())
  })
})
