import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { CalendarEvent } from '../../lib/calendarGrid'
import { itGatesQuietly, expectMessageHidden, expectMessageShown, expectQuietlyBlocked } from '../../test/quietGate'

// The quiet required-field gate on the calendar event form (create and edit):
// Title and Date are required. Save looks disabled while either is missing
// and says "Fill in the required items first." only when someone tries it.
// This form mixes required and optional inputs, so Title and Date keep their
// asterisks.

const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../BillPicker', () => ({ BillPicker: () => React.createElement('div', { 'data-testid': 'bill-picker' }) }))

import { EventFormFields, type EventFormValues } from './EventFormFields'
import { EventForm } from './EventForm'
import { EventItem } from './EventItem'

const VALID: EventFormValues = {
  description: 'Board meeting', date: '2099-01-01', time: null, location: null, billIds: [], details: null, url: null,
}

function renderFields(initial?: EventFormValues) {
  const onSave = vi.fn()
  render(<EventFormFields initial={initial} billOptions={[]} multiState={false} onSave={onSave} onClose={() => {}} />)
  return { onSave }
}

const saveButton = () => screen.getByRole('button', { name: /^save$/i })
const title = () => screen.getByLabelText(/^title/i)
const date = () => screen.getByLabelText(/^date/i)

function renderEditItem(onEditSave = vi.fn()) {
  const event: CalendarEvent = {
    id: 'e1', uid: 'u', source: 'custom', billId: null, bills: [],
    date: '2099-01-01', time: null, location: null, description: 'Board meeting', details: null, url: null, status: 'confirmed',
  }
  render(
    <MemoryRouter>
      <EventItem
        event={event}
        isPast={false}
        isAdmin
        editing
        billOptions={[]}
        onEdit={vi.fn()}
        onEditSave={onEditSave}
        onEditCancel={vi.fn()}
        onDelete={vi.fn()}
        onRestore={vi.fn()}
      />
    </MemoryRouter>,
  )
  return { onEditSave }
}

beforeEach(() => { demo.demoLocked = false })

describe('EventFormFields: quiet gate on an empty create form', () => {
  itGatesQuietly(async () => {
    const user = userEvent.setup()
    const { onSave } = renderFields()
    return { user, button: saveButton, submitted: () => onSave.mock.calls.length }
  })
})

describe('EventFormFields: quiet gate with only Title filled', () => {
  itGatesQuietly(async () => {
    const user = userEvent.setup()
    const { onSave } = renderFields({ ...VALID, date: '' })
    return { user, button: saveButton, submitted: () => onSave.mock.calls.length }
  })
})

describe('EventFormFields: quiet gate with only Date filled', () => {
  itGatesQuietly(async () => {
    const user = userEvent.setup()
    const { onSave } = renderFields({ ...VALID, description: '' })
    return { user, button: saveButton, submitted: () => onSave.mock.calls.length }
  })
})

describe('EventFormFields: markers', () => {
  it('shows no "* Required" legend', () => {
    renderFields()
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
  })

  it('marks Title and Date with aria-required and a red asterisk', () => {
    renderFields()
    expect(title()).toHaveAttribute('aria-required', 'true')
    expect(date()).toHaveAttribute('aria-required', 'true')
    expect(title().closest('label')).toHaveTextContent('Title *')
    expect(date().closest('label')).toHaveTextContent('Date *')
  })

  it('does not mark the optional fields as required', () => {
    renderFields()
    for (const label of [/^time/i, /^description/i, /^link$/i]) {
      const el = screen.getByLabelText(label)
      expect(el).not.toHaveAttribute('aria-required')
      expect(el.closest('label')!.textContent).not.toContain('*')
    }
  })
})

describe('EventFormFields: filling and clearing', () => {
  it('lifts the gate once Title and Date are both filled, and saves', async () => {
    const user = userEvent.setup()
    const { onSave } = renderFields()
    await user.type(title(), 'Hearing')
    expectQuietlyBlocked(saveButton())
    fireEvent.change(date(), { target: { value: '2099-01-01' } })
    expect(saveButton()).toBeEnabled()
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    await user.hover(saveButton())
    expectMessageHidden(saveButton())
    await user.click(saveButton())
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('hides a shown message once the last required value is filled', async () => {
    const user = userEvent.setup()
    renderFields({ ...VALID, date: '' })
    await user.hover(saveButton())
    expectMessageShown(saveButton())
    fireEvent.change(date(), { target: { value: '2099-01-01' } })
    expectMessageHidden(saveButton())
  })

  it('blocks Save quietly again when Title is cleared', async () => {
    const user = userEvent.setup()
    renderFields(VALID)
    await user.clear(title())
    expectQuietlyBlocked(saveButton())
    expectMessageHidden(saveButton())
  })

  it('treats a whitespace-only Title as missing', async () => {
    const user = userEvent.setup()
    const { onSave } = renderFields({ ...VALID, description: '' })
    await user.type(title(), '   ')
    expectQuietlyBlocked(saveButton())
    await user.click(saveButton())
    expect(onSave).not.toHaveBeenCalled()
    expectMessageShown(saveButton())
  })

  it('does not save a missing Title on Enter in a field', async () => {
    const user = userEvent.setup()
    const { onSave } = renderFields({ ...VALID, description: '' })
    await user.type(title(), '  {Enter}')
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('EventFormFields: other disabled reasons show no message', () => {
  it('demo lock with every value filled: natively disabled, quiet', () => {
    demo.demoLocked = true
    renderFields(VALID)
    expect(saveButton()).toBeDisabled()
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    fireEvent.mouseEnter(saveButton())
    fireEvent.focus(saveButton())
    expectMessageHidden(saveButton())
  })

  it('demo lock while values are missing: natively disabled, quiet', () => {
    demo.demoLocked = true
    renderFields()
    expect(saveButton()).toBeDisabled()
    fireEvent.mouseEnter(saveButton())
    expectMessageHidden(saveButton())
  })

  it('an invalid link: natively disabled, its own message, no required message', async () => {
    const user = userEvent.setup()
    renderFields(VALID)
    await user.type(screen.getByLabelText(/^link$/i), 'example.com')
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(/must start with http/i)).toBeInTheDocument()
    fireEvent.mouseEnter(saveButton())
    expectMessageHidden(saveButton())
  })
})

describe('Calendar event gate in both hosts', () => {
  const pos = { positionStyle: {}, transformOrigin: 'top left', enterOffsetY: -6 }

  it('the create popover is quiet on open and reveals the message on hover', async () => {
    const user = userEvent.setup()
    render(<EventForm billOptions={[]} multiState={false} onSave={vi.fn()} onClose={vi.fn()} position={pos} />)
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
    expectMessageHidden(saveButton())
    expectQuietlyBlocked(saveButton())
    await user.hover(saveButton())
    expectMessageShown(saveButton())
  })

  it('the create popover does not save on click while empty', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<EventForm billOptions={[]} multiState={false} onSave={onSave} onClose={vi.fn()} position={pos} />)
    await user.click(saveButton())
    expect(onSave).not.toHaveBeenCalled()
    expectMessageShown(saveButton())
  })

  it('the inline edit form stays quiet when the title is cleared, until Save is tried', async () => {
    const user = userEvent.setup()
    const { onEditSave } = renderEditItem()
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
    await user.clear(title())
    expectQuietlyBlocked(saveButton())
    expectMessageHidden(saveButton())
    await user.click(saveButton())
    expect(onEditSave).not.toHaveBeenCalled()
    expectMessageShown(saveButton())
  })
})
