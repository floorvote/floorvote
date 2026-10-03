import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import React from 'react'
import userEvent from '@testing-library/user-event'

// The quiet required-field gate on the "Add custom field" form: Name is always
// required, and a dropdown also needs at least one option. "Add field" looks
// disabled until both are present and says "Fill in the required items first."
// only when someone tries it, instead of letting the server reject an
// option-less dropdown and surfacing that rejection as a browser alert. The
// form shows no asterisks or legend; aria-required stays on its inputs.

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement('a', { href: to }, children),
}))
vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))
vi.mock('../../hooks/usePageTitle', () => ({ usePageTitle: () => {} }))
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.com', name: 'Admin', role: 'admin' }, loading: false }),
}))
const { demo } = vi.hoisted(() => ({ demo: { demoMode: false, demoLocked: false } }))
vi.mock('../../context/DemoContext', () => ({ useDemo: () => demo }))
vi.mock('../../components/SettingsNav', () => ({
  SettingsNav: () => React.createElement('div', { 'data-testid': 'settings-nav' }),
}))
vi.mock('../../components/ResizableTextarea', () => ({
  ResizableTextarea: ({ value, onChange, ...rest }: React.ComponentProps<'textarea'>) =>
    React.createElement('textarea', { value, onChange, ...rest }),
}))
vi.mock('../../components/HintText', () => ({
  HintText: ({ text }: { text: string }) => React.createElement('span', null, text),
}))
vi.mock('../../components/RichTextEditor', () => ({
  RichTextEditor: () => React.createElement('div', { 'data-testid': 'rich-text-editor' }),
}))
vi.mock('../../components/BillBadge', () => ({ BillBadge: () => null }))
vi.mock('../../lib/exportData', () => ({ exportAllData: vi.fn() }))

import { apiFetch } from '../../lib/api'
import { Config } from './Config'
import { itGatesQuietly, expectMessageHidden, expectMessageShown, expectQuietlyBlocked } from '../../test/quietGate'

const mockFetch = vi.mocked(apiFetch)

const BASE_CONFIG = {
  keywords: [],
  association_name: 'Test Org',
  org_noun: 'association',
  ai_context: '',
  relevance_question: '',
  tag_taxonomy: [],
  matched_bills_count: 0,
  prioritized_bills_count: 0,
}

let holdCreate: { release: () => void } | null = null

function mockApi({ hold = false }: { hold?: boolean } = {}) {
  mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/admin/config') return { ...BASE_CONFIG }
    if (path === '/admin/custom-fields' && init?.method === 'POST') {
      if (hold) await new Promise<void>(resolve => { holdCreate = { release: resolve } })
      const body = JSON.parse(String(init.body))
      return { id: 'new', pinned: false, multiple: false, options: body.options ?? null, ...body }
    }
    if (path === '/admin/custom-fields') return []
    if (path === '/bills/drafts') return { drafts: [] }
    throw new Error('unexpected path: ' + path)
  })
}

function posts() {
  return mockFetch.mock.calls.filter(([p, init]) => p === '/admin/custom-fields' && (init as RequestInit | undefined)?.method === 'POST')
}

async function form() {
  return screen.findByRole('group', { name: 'Add custom field' })
}

function addButton(f: HTMLElement) {
  return within(f).getByRole('button', { name: /^(add field|adding…)$/i })
}

async function setup() {
  const user = userEvent.setup()
  render(<Config />)
  const f = await form()
  return { user, f }
}

async function chooseDropdown(user: ReturnType<typeof userEvent.setup>, f: HTMLElement) {
  await user.selectOptions(within(f).getByLabelText('Type'), 'dropdown')
}

let alertSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.resetAllMocks()
  demo.demoLocked = false
  holdCreate = null
  mockApi()
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
})
afterEach(() => { alertSpy.mockRestore() })

describe('Config "Add custom field": quiet gate while Name is empty', () => {
  itGatesQuietly(async () => {
    const { user, f } = await setup()
    return { user, button: () => addButton(f), submitted: () => posts().length, scope: () => f }
  })
})

describe('Config "Add custom field": quiet gate for a named dropdown with no options', () => {
  itGatesQuietly(async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await chooseDropdown(user, f)
    return { user, button: () => addButton(f), submitted: () => posts().length, scope: () => f }
  })
})

describe('Config "Add custom field": markers', () => {
  it('shows no "* Required" legend and no asterisks', async () => {
    const { user, f } = await setup()
    await chooseDropdown(user, f)
    expect(within(f).queryByText('Required')).not.toBeInTheDocument()
    expect(f.textContent).not.toContain('*')
  })

  it('labels the Name input and keeps aria-required on it', async () => {
    const { f } = await setup()
    const name = within(f).getByLabelText(/^name/i)
    expect(name.tagName).toBe('INPUT')
    expect(name).toHaveAttribute('aria-required', 'true')
    expect(name).toHaveAccessibleName('Name')
  })

  it('labels the Type select and does not mark it required', async () => {
    const { f } = await setup()
    const type = within(f).getByLabelText('Type')
    expect(type.tagName).toBe('SELECT')
    expect(type).not.toHaveAttribute('aria-required')
  })

  it('keeps aria-required on the Options input once Dropdown is chosen', async () => {
    const { user, f } = await setup()
    await chooseDropdown(user, f)
    const options = within(f).getByLabelText(/^options/i)
    expect(options).toHaveAttribute('aria-required', 'true')
    expect(options).toHaveAccessibleName('Options (comma-separated)')
  })
})

describe('Config "Add custom field": Name', () => {
  it('lifts the gate once Name is typed, with no message on hover', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    expect(addButton(f)).toBeEnabled()
    expect(addButton(f)).not.toHaveAttribute('aria-disabled')
    await user.hover(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('blocks quietly again when Name is cleared', async () => {
    const { user, f } = await setup()
    const name = within(f).getByLabelText(/^name/i)
    await user.type(name, 'Committee')
    await user.clear(name)
    expectQuietlyBlocked(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('hides a shown message once Name is typed', async () => {
    const { user, f } = await setup()
    await user.hover(addButton(f))
    expectMessageShown(addButton(f), f)
    await user.type(within(f).getByLabelText(/^name/i), 'C')
    expectMessageHidden(addButton(f), f)
  })

  it('treats a whitespace-only Name as missing', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), '   ')
    expectQuietlyBlocked(addButton(f))
    await user.click(addButton(f))
    expect(posts()).toHaveLength(0)
    expectMessageShown(addButton(f), f)
  })

  it('does not send a blank Name on Enter', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), '  {Enter}')
    expect(posts()).toHaveLength(0)
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('is quiet again after a field is added and the form resets', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await user.click(addButton(f))
    await waitFor(() => expect(posts()).toHaveLength(1))
    await waitFor(() => expect(within(f).getByLabelText(/^name/i)).toHaveValue(''))
    expectQuietlyBlocked(addButton(f))
    expectMessageHidden(addButton(f), f)
  })
})

describe('Config "Add custom field": a dropdown needs at least one option', () => {
  it('blocks "Add field" quietly for a named dropdown with no options', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await chooseDropdown(user, f)
    expectQuietlyBlocked(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('never calls window.alert or the server for an option-less dropdown, on Enter or click', async () => {
    const { user, f } = await setup()
    await chooseDropdown(user, f)
    await user.type(within(f).getByLabelText(/^name/i), 'Committee{Enter}')
    await user.click(addButton(f))
    expect(alertSpy).not.toHaveBeenCalled()
    expect(posts()).toHaveLength(0)
    expectMessageShown(addButton(f), f)
  })

  it('treats options that are only commas and spaces as no options', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await chooseDropdown(user, f)
    await user.type(within(f).getByLabelText(/^options/i), ' , ,  ')
    expectQuietlyBlocked(addButton(f))
    await user.type(within(f).getByLabelText(/^options/i), '{Enter}')
    await user.click(addButton(f))
    expect(alertSpy).not.toHaveBeenCalled()
    expect(posts()).toHaveLength(0)
  })

  it('lifts the gate once an option is typed, and blocks quietly again when cleared', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await chooseDropdown(user, f)
    const options = within(f).getByLabelText(/^options/i)
    await user.type(options, 'Finance')
    expect(addButton(f)).toBeEnabled()
    expect(addButton(f)).not.toHaveAttribute('aria-disabled')

    await user.clear(options)
    expectQuietlyBlocked(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('sends the dropdown once it has a name and an option', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await chooseDropdown(user, f)
    await user.type(within(f).getByLabelText(/^options/i), 'Finance, Judiciary')
    await user.click(addButton(f))
    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toMatchObject({
      name: 'Committee', type: 'dropdown', options: ['Finance', 'Judiciary'],
    })
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('stops requiring options when the type is switched away from Dropdown', async () => {
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await chooseDropdown(user, f)
    expectQuietlyBlocked(addButton(f))
    await user.selectOptions(within(f).getByLabelText('Type'), 'text')
    expect(within(f).queryByLabelText(/^options/i)).not.toBeInTheDocument()
    expect(addButton(f)).toBeEnabled()
    expect(addButton(f)).not.toHaveAttribute('aria-disabled')
  })
})

describe('Config "Add custom field": other disabled reasons show no message', () => {
  it('demo lock with Name typed: natively disabled, quiet', async () => {
    demo.demoLocked = true
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    expect(addButton(f)).toBeDisabled()
    expect(addButton(f)).not.toHaveAttribute('aria-disabled')
    await user.hover(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('demo lock while Name is empty: natively disabled, quiet', async () => {
    demo.demoLocked = true
    const { user, f } = await setup()
    expect(addButton(f)).toBeDisabled()
    await user.hover(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('demo lock for an option-less dropdown: natively disabled, quiet', async () => {
    demo.demoLocked = true
    const { user, f } = await setup()
    await chooseDropdown(user, f)
    expect(addButton(f)).toBeDisabled()
    await user.hover(addButton(f))
    expectMessageHidden(addButton(f), f)
  })

  it('a create request in flight: natively disabled, quiet', async () => {
    mockApi({ hold: true })
    const { user, f } = await setup()
    await user.type(within(f).getByLabelText(/^name/i), 'Committee')
    await user.click(addButton(f))
    await waitFor(() => expect(posts()).toHaveLength(1))
    const busy = within(f).getByRole('button', { name: /adding/i })
    expect(busy).toBeDisabled()
    expect(busy).not.toHaveAttribute('aria-disabled')
    expectMessageHidden(busy, f)
    await act(async () => { holdCreate?.release() })
  })
})
