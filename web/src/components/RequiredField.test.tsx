import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import * as RequiredField from './RequiredField'
import { MissingRequiredReason, REQUIRED_MESSAGE, useRequiredSubmit } from './RequiredField'
import { itGatesQuietly, expectMessageShown, expectMessageHidden, expectQuietlyBlocked, expectHiddenMessageNode, tabTo } from '../test/quietGate'

// The shared quiet gate for submit buttons, exercised through a minimal form.

function Harness({ blocked = false, onSubmit, asFormSubmit = false }: { blocked?: boolean; onSubmit: () => void; asFormSubmit?: boolean }) {
  const [value, setValue] = useState('')
  const gate = useRequiredSubmit({ missingRequired: !value.trim(), blocked })
  const button = (
    <button
      type={asFormSubmit ? 'submit' : 'button'}
      {...gate.buttonProps(asFormSubmit ? undefined : onSubmit)}
      style={{ cursor: gate.disabled ? 'not-allowed' : 'pointer' }}
    >
      Save
    </button>
  )
  const body = (
    <>
      <label htmlFor="v">Value</label>
      <input id="v" aria-required="true" value={value} onChange={e => setValue(e.target.value)} />
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>{button}</div>
      <MissingRequiredReason {...gate.reasonProps} />
      <button type="button">After</button>
    </>
  )
  if (!asFormSubmit) return body
  return <form onSubmit={e => { e.preventDefault(); if (!gate.disabled) onSubmit() }}>{body}</form>
}

function setup(props: { blocked?: boolean; asFormSubmit?: boolean } = {}) {
  const onSubmit = vi.fn()
  const user = userEvent.setup()
  const utils = render(<Harness onSubmit={onSubmit} {...props} />)
  return { user, onSubmit, utils, button: () => screen.getByRole('button', { name: 'Save' }) }
}

describe('REQUIRED_MESSAGE', () => {
  it('is the one generic sentence, with no asterisk', () => {
    expect(REQUIRED_MESSAGE).toBe('Fill in the required items first.')
    expect(REQUIRED_MESSAGE).not.toContain('*')
  })

  it('no longer has a legend component', () => {
    expect('RequiredLegend' in RequiredField).toBe(false)
  })

  it('no longer has the per-editor blank-value guard', () => {
    expect('useBlankValueGuard' in RequiredField).toBe(false)
    expect('BlankValueMessage' in RequiredField).toBe(false)
  })
})

describe('useRequiredSubmit: a button-type submit', () => {
  itGatesQuietly(async () => {
    const s = setup()
    return { user: s.user, button: s.button, submitted: () => s.onSubmit.mock.calls.length }
  })

  it('submits normally once the value is filled, and shows no message', async () => {
    const s = setup()
    await s.user.type(screen.getByLabelText('Value'), 'x')
    expect(s.button()).not.toHaveAttribute('aria-disabled')
    expect(s.button()).toBeEnabled()
    await s.user.hover(s.button())
    expectMessageHidden(s.button())
    await s.user.click(s.button())
    expect(s.onSubmit).toHaveBeenCalledTimes(1)
  })

  it('hides a shown message as soon as the value is filled, and shows it again if cleared while still hovered', async () => {
    const s = setup()
    await s.user.hover(s.button())
    expectMessageShown(s.button())
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } })
    expectMessageHidden(s.button())
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '' } })
    expectMessageShown(s.button())
  })

  it('keeps the message while focused even after the mouse leaves', async () => {
    const s = setup()
    await tabTo(s.user, s.button())
    await s.user.hover(s.button())
    await s.user.unhover(s.button())
    expectMessageShown(s.button())
  })

  it('treats a whitespace-only value as missing', async () => {
    const s = setup()
    await s.user.type(screen.getByLabelText('Value'), '   ')
    expectQuietlyBlocked(s.button())
    await s.user.click(s.button())
    expect(s.onSubmit).not.toHaveBeenCalled()
    expectMessageShown(s.button())
  })
})

describe('useRequiredSubmit: blocked for another reason', () => {
  it('stays natively disabled with no aria-disabled and never shows the message', async () => {
    const s = setup({ blocked: true })
    expect(s.button()).toBeDisabled()
    expect(s.button()).not.toHaveAttribute('aria-disabled')
    fireEvent.mouseEnter(s.button())
    fireEvent.focus(s.button())
    fireEvent.click(s.button())
    expectMessageHidden(s.button())
    expect(s.onSubmit).not.toHaveBeenCalled()
  })

  it('stays natively disabled and quiet once the value is filled', async () => {
    const s = setup({ blocked: true })
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'x' } })
    expect(s.button()).toBeDisabled()
    fireEvent.mouseEnter(s.button())
    expectMessageHidden(s.button())
  })

  it('forgets an earlier attempt once blocked, so it starts quiet again afterward', async () => {
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<Harness onSubmit={onSubmit} />)
    const button = () => screen.getByRole('button', { name: 'Save' })
    await user.hover(button())
    expectMessageShown(button())
    rerender(<Harness onSubmit={onSubmit} blocked />)
    expectMessageHidden(button())
    rerender(<Harness onSubmit={onSubmit} />)
    expectMessageHidden(button())
  })
})

describe('useRequiredSubmit: a submit-type button inside a form', () => {
  itGatesQuietly(async () => {
    const s = setup({ asFormSubmit: true })
    return { user: s.user, button: s.button, submitted: () => s.onSubmit.mock.calls.length }
  })

  it('does not submit the form on Enter in the field while a value is missing', async () => {
    const s = setup({ asFormSubmit: true })
    await s.user.type(screen.getByLabelText('Value'), '  {Enter}')
    expect(s.onSubmit).not.toHaveBeenCalled()
  })

  it('submits the form once the value is filled', async () => {
    const s = setup({ asFormSubmit: true })
    await s.user.type(screen.getByLabelText('Value'), 'x')
    await s.user.click(s.button())
    expect(s.onSubmit).toHaveBeenCalledTimes(1)
  })
})

// An inline editor: Enter in the field asks the gate first, and the editor
// (owned by a parent that outlives it) resets the gate on open and close.
function InlineHarness({ onSave }: { onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const gate = useRequiredSubmit({ missingRequired: !value.trim() })
  if (!open) {
    return <button type="button" onClick={() => { setValue('Old'); setOpen(true); gate.reset() }}>Edit</button>
  }
  return (
    <>
      <input
        aria-label="Value"
        aria-required="true"
        {...gate.fieldProps}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !gate.refuse()) { onSave(value); setOpen(false) } }}
      />
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <button type="button" {...gate.buttonProps(() => { onSave(value); setOpen(false) })} style={{ cursor: gate.disabled ? 'not-allowed' : 'pointer' }}>Save</button>
        <button type="button" onClick={() => { setOpen(false); gate.reset() }}>Cancel</button>
      </div>
      <MissingRequiredReason {...gate.reasonProps} />
    </>
  )
}

describe('useRequiredSubmit: an inline editor', () => {
  async function openEditor() {
    const onSave = vi.fn()
    const user = userEvent.setup()
    render(<InlineHarness onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const input = screen.getByRole('textbox', { name: 'Value' })
    await user.clear(input)
    return { user, onSave, input, button: () => screen.getByRole('button', { name: 'Save' }) }
  }

  itGatesQuietly(async () => {
    const s = await openEditor()
    return { user: s.user, button: s.button, submitted: () => s.onSave.mock.calls.length }
  })

  it('refuses Enter on a blank value, revealing the message tied to the field and the button', async () => {
    const s = await openEditor()
    await s.user.type(s.input, '{Enter}')
    expect(s.onSave).not.toHaveBeenCalled()
    expectMessageShown(s.button())
    expect(s.input).toHaveAttribute('aria-describedby', s.button().getAttribute('aria-describedby'))
    expect(s.input).toHaveAccessibleDescription(REQUIRED_MESSAGE)
  })

  it('keeps a refused Enter\'s message after the button is hovered and left', async () => {
    const s = await openEditor()
    await s.user.type(s.input, '{Enter}')
    await s.user.hover(s.button())
    await s.user.unhover(s.button())
    expectMessageShown(s.button())
  })

  it('hides a refused Enter\'s message once the value is filled, and does not bring it back when cleared', async () => {
    const s = await openEditor()
    await s.user.type(s.input, '{Enter}')
    await s.user.type(s.input, 'x')
    expectMessageHidden(s.button())
    expect(s.input).not.toHaveAttribute('aria-describedby')
    await s.user.clear(s.input)
    expectMessageHidden(s.button())
  })

  it('saves on Enter once the value is filled', async () => {
    const s = await openEditor()
    await s.user.type(s.input, 'New{Enter}')
    expect(s.onSave).toHaveBeenCalledWith('New')
  })

  it('does not carry an attempt over to the next opening, after Cancel', async () => {
    const s = await openEditor()
    await s.user.click(s.button())
    expectMessageShown(s.button())
    await s.user.click(screen.getByRole('button', { name: 'Cancel' }))
    await s.user.click(screen.getByRole('button', { name: 'Edit' }))
    await s.user.clear(screen.getByRole('textbox', { name: 'Value' }))
    expectMessageHidden(s.button())
  })

  it('does not carry a hover over to the next opening, though the button unmounted while hovered', async () => {
    const s = await openEditor()
    await s.user.hover(s.button())
    expectMessageShown(s.button())
    // skipClick: the pointer stays on Save while Enter saves and closes.
    await s.user.type(s.input, 'New{Enter}', { skipClick: true })
    expect(s.onSave).toHaveBeenCalledWith('New')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: '' } })
    expectMessageHidden(s.button())
  })
})

describe('MissingRequiredReason', () => {
  // jsdom does no layout, so "revealing it moves nothing" is checked through
  // what guarantees it: the node is always mounted and only its visibility
  // changes (see the layout note in test/quietGate.ts).
  it('keeps the message mounted while hidden: visibility hidden, aria-hidden, and no id', () => {
    render(<MissingRequiredReason id="r" show={false} />)
    const el = screen.getByText(REQUIRED_MESSAGE)
    expectHiddenMessageNode(el)
    expect(el.style.visibility).toBe('hidden')
    expect(document.getElementById('r')).toBeNull()
  })

  it('renders exactly the message when shown, visible, with its id and no aria-hidden', () => {
    render(<MissingRequiredReason id="r" show />)
    const el = screen.getByText(REQUIRED_MESSAGE)
    expect(el.id).toBe('r')
    expect(el.textContent).toBe(REQUIRED_MESSAGE)
    expect(el).toBeVisible()
    expect(el).not.toHaveAttribute('aria-hidden')
  })

  it('is the same element, in the same box, shown or hidden: only visibility changes', () => {
    const { rerender } = render(<MissingRequiredReason id="r" show={false} />)
    const hidden = screen.getByText(REQUIRED_MESSAGE)
    const boxOf = (el: HTMLElement) => {
      const { display, lineHeight, fontSize, margin, marginTop, padding, flexBasis } = el.style
      return { display, lineHeight, fontSize, margin, marginTop, padding, flexBasis }
    }
    const hiddenBox = boxOf(hidden)
    rerender(<MissingRequiredReason id="r" show />)
    const shown = screen.getByText(REQUIRED_MESSAGE)
    expect(shown).toBe(hidden)
    expect(boxOf(shown)).toEqual(hiddenBox)
  })

  it('is its own block line at a compact helper-text line height', () => {
    render(<MissingRequiredReason id="r" show={false} />)
    const el = screen.getByText(REQUIRED_MESSAGE)
    expect(el.tagName).toBe('DIV')
    expect(el.style.display).toBe('block')
    expect(el.style.lineHeight).toBe('1.4')
    // Even if someone drops it into a wrapping flex row, it takes a full line.
    expect(el.style.flexBasis).toBe('100%')
  })

  it('cannot be made to show or hide by a caller style', () => {
    const { rerender } = render(<MissingRequiredReason id="r" show={false} style={{ visibility: 'visible' }} />)
    expect(screen.getByText(REQUIRED_MESSAGE)).not.toBeVisible()
    rerender(<MissingRequiredReason id="r" show style={{ visibility: 'hidden' }} />)
    expect(screen.getByText(REQUIRED_MESSAGE)).toBeVisible()
  })
})
