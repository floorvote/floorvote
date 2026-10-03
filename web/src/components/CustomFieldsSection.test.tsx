import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CustomFieldsSection, type CustomFieldDef } from './CustomFieldsSection'
import * as api from '../lib/api'

// Heavy editor component that breaks in jsdom.
vi.mock('./RichTextEditor', () => ({
  RichTextEditor: () => null,
}))

const TEXT_FIELD: CustomFieldDef = {
  id: 'f1',
  name: 'Committee Notes',
  slug: 'committee-notes',
  type: 'text',
  options: null,
  multiple: false,
  displayOrder: 0,
  pinned: false,
}

const VALUES = {
  f1: { value: 'Some notes', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' },
}

// The text-field "click to edit" affordance is admin-only. It must be a real,
// keyboard-operable button — not a div that only responds to a mouse click.
describe('CustomFieldsSection text field inline edit keyboard access', () => {
  it('renders the edit affordance as a button with an accessible name', () => {
    render(
      <CustomFieldsSection
        fields={[TEXT_FIELD]}
        billId="1"
        values={VALUES}
        isAdmin
        onUpdate={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /edit committee notes/i })).toBeInTheDocument()
  })

  it('enters edit mode when the button is activated from the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <CustomFieldsSection
        fields={[TEXT_FIELD]}
        billId="1"
        values={VALUES}
        isAdmin
        onUpdate={vi.fn()}
      />,
    )
    const edit = screen.getByRole('button', { name: /edit committee notes/i })
    edit.focus()
    await user.keyboard('{Enter}')

    // RichTextEditor is mocked to render null, so entering edit mode removes
    // the read-only edit affordance from the DOM — confirming the handler fired.
    expect(screen.queryByRole('button', { name: /edit committee notes/i })).not.toBeInTheDocument()
  })

  it('does not render an edit button for non-admins', () => {
    render(
      <CustomFieldsSection
        fields={[TEXT_FIELD]}
        billId="1"
        values={VALUES}
        isAdmin={false}
        onUpdate={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /edit committee notes/i })).not.toBeInTheDocument()
    // Non-admin read-only content is still shown.
    expect(screen.getByText('Some notes')).toBeInTheDocument()
  })
})

const DATE_FIELD: CustomFieldDef = {
  id: 'f2', name: 'Due date', slug: 'due', type: 'date', options: null, multiple: false, displayOrder: 0, pinned: false,
}
const DATED = { f2: { value: '2027-01-15', setBy: 'Admin', updatedAt: '2025-01-01 00:00:00' } }

// The bill page saves each change at once; the create-draft form only collects.
describe('CustomFieldsSection saving vs collecting', () => {
  it('on the bill page, saves a change to the bill and shows who set it', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue({ ok: true } as never)
    const onUpdate = vi.fn()
    render(<CustomFieldsSection fields={[DATE_FIELD]} billId="b1" values={DATED} isAdmin onUpdate={onUpdate} />)
    expect(screen.getByText(/set by admin/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-02-01' } })
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('f2', '2027-02-01', 'You'))
    expect(spy).toHaveBeenCalledWith('/bills/b1/custom-fields', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ f2: '2027-02-01' }),
    }))
    spy.mockRestore()
  })

  it('in collect mode, hands the change to onUpdate without saving it and shows no "Set by" line', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue({ ok: true } as never)
    const onUpdate = vi.fn()
    render(<CustomFieldsSection collect fields={[DATE_FIELD]} values={DATED} isAdmin onUpdate={onUpdate} />)
    expect(screen.queryByText(/set by/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-02-01' } })
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('f2', '2027-02-01', 'You'))
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

const DOC_FIELD: CustomFieldDef = {
  id: 'f3', name: 'Testimony', slug: 'testimony', type: 'document', options: null, multiple: false, displayOrder: 0, pinned: false,
}

const DOCS = {
  f3: {
    value: JSON.stringify([
      { title: 'Written testimony', url: 'https://docs.google.com/document/d/abc' },
      { title: 'Not a link', url: 'javascript:alert(1)' },
    ]),
    setBy: 'Admin',
    updatedAt: '2025-01-01 00:00:00',
  },
}

describe('CustomFieldsSection document field', () => {
  it('renders each https document as a link that opens in a new tab, and drops anything else', () => {
    render(<CustomFieldsSection fields={[DOC_FIELD]} billId="b1" values={DOCS} isAdmin={false} onUpdate={vi.fn()} />)
    const link = screen.getByRole('link', { name: 'Written testimony' })
    expect(link).toHaveAttribute('href', 'https://docs.google.com/document/d/abc')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByText('Not a link')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add/i })).not.toBeInTheDocument()
  })

  it('lets an admin add a document, saving the whole list', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue({ ok: true } as never)
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    render(<CustomFieldsSection fields={[DOC_FIELD]} billId="b1" values={{}} isAdmin onUpdate={onUpdate} />)

    await user.click(screen.getByRole('button', { name: /add a document/i }))
    await user.type(screen.getByLabelText('Testimony document title'), 'Comment letter')
    await user.type(screen.getByLabelText('Testimony document link'), 'https://example.org/letter.pdf')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    const expected = [{ title: 'Comment letter', url: 'https://example.org/letter.pdf' }]
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('f3', JSON.stringify(expected), 'You'))
    expect(spy).toHaveBeenCalledWith('/bills/b1/custom-fields', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ f3: expected }),
    }))
    spy.mockRestore()
  })

  it('refuses a link that is not https before saving', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue({ ok: true } as never)
    const user = userEvent.setup()
    render(<CustomFieldsSection fields={[DOC_FIELD]} billId="b1" values={{}} isAdmin onUpdate={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /add a document/i }))
    await user.type(screen.getByLabelText('Testimony document title'), 'Letter')
    await user.type(screen.getByLabelText('Testimony document link'), 'http://example.org/letter')
    await user.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByRole('alert')).toHaveTextContent(/https/)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('removing the last document clears the field', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue({ ok: true } as never)
    const user = userEvent.setup()
    const onUpdate = vi.fn()
    const one = { f3: { ...DOCS.f3, value: JSON.stringify([{ title: 'Letter', url: 'https://example.org/l' }]) } }
    render(<CustomFieldsSection fields={[DOC_FIELD]} billId="b1" values={one} isAdmin onUpdate={onUpdate} />)

    await user.click(screen.getByRole('button', { name: 'Remove Letter from Testimony' }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('f3', null, 'You'))
    expect(spy).toHaveBeenCalledWith('/bills/b1/custom-fields', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ f3: null }),
    }))
    spy.mockRestore()
  })
})
