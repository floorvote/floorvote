import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CustomFieldsSection, type CustomFieldDef } from './CustomFieldsSection'

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
