import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DraftBills } from './DraftBills'
import * as api from '../../lib/api'
import { itGatesQuietly, expectMessageHidden, expectMessageShown, expectQuietlyBlocked, gateMessage } from '../../test/quietGate'

// The quiet required-field gate on the create-draft form. The only required
// field is State, and only on a tenant that covers more than one state; there
// the form mixes required and optional inputs, so State keeps its red asterisk
// (and aria-required, or "(required)" in a picker's name). "Create draft"
// looks disabled while State is missing and says "Fill in the required items
// first." only when someone tries it. No "* Required" legend anywhere.

const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

type Opts = {
  tenantState?: string | null
  states?: Record<string, number> | 'fail'
  // When set, POST /bills/draft hangs until the returned release() is called.
  holdCreate?: boolean
}

function mockApi(opts: Opts = {}) {
  let release: () => void = () => {}
  const posted: Record<string, unknown>[] = []
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/drafts') return { drafts: [] } as never
    if (path === '/bills/facets') {
      if (opts.states === 'fail') throw new api.ApiError(500, 'facets unavailable')
      return { state: opts.states ?? { AA: 3, BB: 1 } } as never
    }
    if (path.startsWith('/bills/draft-defaults')) {
      return { billNumber: 'D1', year: 2026, tenantState: 'tenantState' in opts ? opts.tenantState : null } as never
    }
    if (path === '/bills/draft') {
      posted.push(JSON.parse(String(init?.body)))
      if (opts.holdCreate) await new Promise<void>(resolve => { release = resolve })
      return { id: 'new-draft' } as never
    }
    return {} as never
  })
  return { posted, release: () => release() }
}

function renderPage() {
  return render(<MemoryRouter><DraftBills /></MemoryRouter>)
}

async function openForm() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
  await screen.findByDisplayValue('D1')
  return user
}

function submitButton() {
  return screen.getByRole('button', { name: /create draft/i })
}

function stateLabel() {
  return screen.getAllByText(/^State/).find(el => el.tagName === 'LABEL') as HTMLLabelElement
}

async function pickState(user: ReturnType<typeof userEvent.setup>, abbr: string) {
  await user.click(screen.getByRole('button', { name: /^state/i }))
  fireEvent.click(screen.getByRole('radio', { name: abbr }))
}

describe('DraftBills: quiet gate while State is missing (State picker)', () => {
  beforeEach(() => vi.restoreAllMocks())
  itGatesQuietly(async () => {
    const { posted } = mockApi()
    renderPage()
    const user = await openForm()
    return { user, button: submitButton, submitted: () => posted.length }
  })
})

describe('DraftBills: quiet gate while State is missing (free-text State)', () => {
  beforeEach(() => vi.restoreAllMocks())
  itGatesQuietly(async () => {
    const { posted } = mockApi({ states: 'fail' })
    renderPage()
    const user = await openForm()
    await screen.findByLabelText(/^state/i)
    return { user, button: submitButton, submitted: () => posted.length }
  })
})

describe('DraftBills: markers on a multi-state tenant', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows no "* Required" legend', async () => {
    mockApi()
    renderPage()
    await openForm()
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
  })

  it('marks the State label with a red asterisk', async () => {
    mockApi()
    renderPage()
    await openForm()
    expect(stateLabel()).toHaveTextContent('State *')
    const marker = stateLabel().querySelector('span') as HTMLElement
    expect(marker.textContent).toBe('*')
    expect(marker).toHaveAttribute('aria-hidden', 'true')
    expect(marker.style.color).toBeTruthy()
  })

  it('announces the State picker as required', async () => {
    mockApi()
    renderPage()
    await openForm()
    // The picker's trigger is a button, which cannot carry aria-required, so
    // the requirement is in its accessible name.
    expect(screen.getByRole('button', { name: 'State (required)' })).toBeInTheDocument()
  })

  it('puts aria-required on the free-text State input when there are no states to offer', async () => {
    mockApi({ states: 'fail' })
    renderPage()
    await openForm()
    const input = await screen.findByLabelText(/^state/i)
    expect(input.tagName).toBe('INPUT')
    expect(input).toHaveAttribute('aria-required', 'true')
  })

  it('does not mark the optional fields as required', async () => {
    mockApi({ states: 'fail' })
    renderPage()
    await openForm()
    for (const label of [/bill number/i, /^title/i, /sponsor/i]) {
      const el = screen.getByLabelText(label)
      expect(el).not.toHaveAttribute('aria-required')
      expect(document.querySelector(`label[for="${el.id}"]`)!.textContent).not.toContain('*')
    }
  })

  it('never names the missing field in the message', async () => {
    mockApi()
    renderPage()
    const user = await openForm()
    await user.hover(submitButton())
    expect(gateMessage()!.textContent).not.toMatch(/state/i)
  })
})

describe('DraftBills: filling and clearing State', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lifts the gate once State is chosen, with no message on hover, and creates the draft', async () => {
    const { posted } = mockApi()
    renderPage()
    const user = await openForm()
    await pickState(user, 'AA')
    expect(submitButton()).toBeEnabled()
    expect(submitButton()).not.toHaveAttribute('aria-disabled')
    await user.hover(submitButton())
    expectMessageHidden(submitButton())
    await user.click(submitButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ state: 'AA' })
  })

  it('hides a shown message once State is chosen', async () => {
    mockApi()
    renderPage()
    const user = await openForm()
    await user.click(submitButton())
    expectMessageShown(submitButton())
    await pickState(user, 'AA')
    expectMessageHidden(submitButton())
  })

  it('blocks quietly again when State is cleared', async () => {
    mockApi()
    renderPage()
    const user = await openForm()
    await pickState(user, 'AA')
    await user.click(screen.getByRole('button', { name: /^state/i }))
    fireEvent.click(screen.getByRole('radio', { name: 'Select a state…' }))
    expectQuietlyBlocked(submitButton())
    expectMessageHidden(submitButton())
  })

  it('tracks the free-text State input: blocked while empty, open when typed, blocked again when erased', async () => {
    mockApi({ states: 'fail' })
    renderPage()
    const user = await openForm()
    const input = await screen.findByLabelText(/^state/i)
    expectQuietlyBlocked(submitButton())

    await user.type(input, 'aa')
    expect(submitButton()).toBeEnabled()
    expect(submitButton()).not.toHaveAttribute('aria-disabled')

    await user.clear(input)
    expectQuietlyBlocked(submitButton())
    expectMessageHidden(submitButton())
  })

  it('treats a whitespace-only State as missing', async () => {
    const { posted } = mockApi({ states: 'fail' })
    renderPage()
    const user = await openForm()
    await user.type(await screen.findByLabelText(/^state/i), ' ')
    expectQuietlyBlocked(submitButton())
    await user.click(submitButton())
    expect(posted).toHaveLength(0)
    expectMessageShown(submitButton())
  })

  it('is quiet again when the form is reopened after Cancel', async () => {
    mockApi()
    renderPage()
    const user = await openForm()
    await user.hover(submitButton())
    expectMessageShown(submitButton())
    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    await openForm()
    expectQuietlyBlocked(submitButton())
    expectMessageHidden(submitButton())
  })
})

describe('DraftBills: other disabled reasons show no message', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => { demoState.demoLocked = false })

  it('demo lock with State chosen: natively disabled, quiet', async () => {
    mockApi()
    const { rerender } = renderPage()
    const user = await openForm()
    await pickState(user, 'AA')

    demoState.demoLocked = true
    rerender(<MemoryRouter><DraftBills /></MemoryRouter>)
    expect(submitButton()).toBeDisabled()
    expect(submitButton()).not.toHaveAttribute('aria-disabled')
    fireEvent.mouseEnter(submitButton())
    fireEvent.focus(submitButton())
    expectMessageHidden(submitButton())
  })

  it('demo lock while State is missing: natively disabled, quiet, even after an earlier attempt', async () => {
    mockApi()
    const { rerender } = renderPage()
    const user = await openForm()
    await user.hover(submitButton())
    expectMessageShown(submitButton())

    demoState.demoLocked = true
    rerender(<MemoryRouter><DraftBills /></MemoryRouter>)
    expect(submitButton()).toBeDisabled()
    expectMessageHidden(submitButton())
  })

  it('a create request in flight: natively disabled, quiet', async () => {
    const { posted, release } = mockApi({ holdCreate: true })
    renderPage()
    const user = await openForm()
    await pickState(user, 'AA')
    await user.click(submitButton())

    await waitFor(() => expect(posted).toHaveLength(1))
    const busy = screen.getByRole('button', { name: /creating/i })
    expect(busy).toBeDisabled()
    expect(busy).not.toHaveAttribute('aria-disabled')
    expectMessageHidden(busy)
    await act(async () => { release() })
  })
})

describe('DraftBills: single-state tenant (nothing is required)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows no legend, no asterisk, no message, and no aria-required, and the button is open', async () => {
    mockApi({ tenantState: 'AA', states: { AA: 5 } })
    renderPage()
    const user = await openForm()
    await waitFor(() => expect(screen.queryByText(/^state/i)).not.toBeInTheDocument())
    expect(screen.queryByText('Required')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-required]')).toBeNull()
    for (const label of Array.from(document.querySelectorAll('label'))) expect(label.textContent).not.toContain('*')
    expect(submitButton()).toBeEnabled()
    expect(submitButton()).not.toHaveAttribute('aria-disabled')
    await user.hover(submitButton())
    expectMessageHidden(submitButton())
  })

  it('shows no message when the button is disabled by demo lock', async () => {
    mockApi({ tenantState: 'AA', states: { AA: 5 } })
    const { rerender } = renderPage()
    await openForm()
    await waitFor(() => expect(submitButton()).toBeEnabled())
    demoState.demoLocked = true
    rerender(<MemoryRouter><DraftBills /></MemoryRouter>)
    expect(submitButton()).toBeDisabled()
    fireEvent.mouseEnter(submitButton())
    expectMessageHidden(submitButton())
    demoState.demoLocked = false
  })
})
