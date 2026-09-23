import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DraftBills } from './DraftBills'
import * as api from '../../lib/api'

// Mutable flag so individual tests can opt into demoLocked without a
// module-level mock rewrite per test (mirrors Members.roleRename.test.tsx).
const demoState = vi.hoisted(() => ({ demoLocked: false }))
vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: demoState.demoLocked }),
}))

function mockDrafts(drafts: { id: string; billNumber: string; title: string; state: string | null }[] = []) {
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
    if (path === '/bills/drafts') return { drafts } as never
    return {} as never
  })
}

describe('DraftBills page', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows "No draft bills yet." and an "Add draft bill" button when there are none', async () => {
    mockDrafts([])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    expect(await screen.findByText('No draft bills yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add draft bill/i })).toBeInTheDocument()
  })

  it('exposes exactly one top-level heading, for the "Draft bills" title', async () => {
    mockDrafts([])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    await screen.findByText('No draft bills yet.')
    const h1s = screen.getAllByRole('heading', { level: 1 })
    expect(h1s).toHaveLength(1)
    expect(h1s[0]).toHaveTextContent('Draft bills')
  })
})

describe('DraftBills read-only demo', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => { demoState.demoLocked = false })

  it('disables "Add draft bill" when demoLocked', async () => {
    demoState.demoLocked = true
    mockDrafts([])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: /add draft bill/i })).toBeDisabled()
  })

  it('disables the "Create draft" submit button and does not POST when demoLocked', async () => {
    demoState.demoLocked = false
    mockDrafts([])
    const { rerender } = render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    await user.type(screen.getByLabelText(/title/i), 'A draft title')

    // Flip to demo-locked mid-session (e.g. a stale tab) and re-render —
    // mirrors the mid-session-lock pattern in BillDetail.readOnly.test.tsx.
    demoState.demoLocked = true
    rerender(<MemoryRouter><DraftBills /></MemoryRouter>)
    const submitBtn = screen.getByRole('button', { name: /create draft/i })
    expect(submitBtn).toBeDisabled()
    fireEvent.click(submitBtn)
    expect(api.apiFetch).not.toHaveBeenCalledWith('/bills/draft', expect.anything())
  })

  it('disables the delete-draft button and does not DELETE when demoLocked', async () => {
    demoState.demoLocked = true
    mockDrafts([{ id: 'd1', billNumber: 'DRAFT-1', title: 'A draft bill', state: null }])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    // The button's only content is the "delete" material-symbols icon glyph
    // (no aria-label) — that's its accessible name, with or without demoLocked.
    const deleteBtn = await screen.findByRole('button', { name: 'delete' })
    expect(deleteBtn).toBeDisabled()
    fireEvent.click(deleteBtn)
    expect(api.apiFetch).not.toHaveBeenCalledWith('/bills/d1', expect.anything())
  })

  it('leaves the delete-draft button enabled when not demoLocked', async () => {
    mockDrafts([{ id: 'd1', billNumber: 'DRAFT-1', title: 'A draft bill', state: null }])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const deleteBtn = await screen.findByRole('button', { name: 'delete' })
    expect(deleteBtn).toBeEnabled()
  })

  it('explains why the delete-draft button is disabled instead of dropping its tooltip', async () => {
    // A dead icon button with no title is less informative than the enabled one.
    // Same copy as the house pattern in admin/Config.tsx.
    demoState.demoLocked = true
    mockDrafts([{ id: 'd1', billNumber: 'DRAFT-1', title: 'A draft bill', state: null }])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const deleteBtn = await screen.findByRole('button', { name: 'delete' })
    expect(deleteBtn).toHaveAttribute('title', 'Locked in demo mode')
  })

  it('keeps the plain delete-draft tooltip when not demoLocked', async () => {
    mockDrafts([{ id: 'd1', billNumber: 'DRAFT-1', title: 'A draft bill', state: null }])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const deleteBtn = await screen.findByRole('button', { name: 'delete' })
    expect(deleteBtn).toHaveAttribute('title', 'Delete draft')
  })
})

describe('DraftBills number and year', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('pre-fills the number and year from draft-defaults and posts both', async () => {
    const posted: Record<string, unknown>[] = []
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D3', year: 2027, tenantState: 'UT' } as never
      if (path === '/bills/draft') { posted.push(JSON.parse(String(init?.body))); return { id: 'x' } as never }
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))

    expect(await screen.findByLabelText(/bill number/i)).toHaveValue('D3')
    expect(screen.getByLabelText(/year/i)).toHaveValue('2027')

    await user.type(screen.getByLabelText(/title/i), 'Pre-filed')
    await user.click(screen.getByRole('button', { name: /create draft/i }))

    expect(posted[0]).toMatchObject({ title: 'Pre-filed', billNumber: 'D3', year: 2027 })
  })

  it('surfaces a 409 collision as an inline error', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: 'UT' } as never
      if (path === '/bills/draft') throw new api.ApiError(409, 'HB0209 is already used by another UT bill in 2026.')
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    await user.type(screen.getByLabelText(/title/i), 'Clash')
    await user.click(screen.getByRole('button', { name: /create draft/i }))

    expect(await screen.findByText(/already used by another UT bill in 2026/)).toBeInTheDocument()
  })
})

describe('DraftBills state field on multi-state tenants', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows a required State field, keeps Create draft disabled until one is chosen, and posts the chosen state', async () => {
    const posted: Record<string, unknown>[] = []
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 3, ID: 1 } } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: null } as never
      if (path === '/bills/draft') { posted.push(JSON.parse(String(init?.body))); return { id: 'x' } as never }
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    await user.type(await screen.findByLabelText(/title/i), 'Multi-state draft')

    const submitBtn = screen.getByRole('button', { name: /create draft/i })
    expect(submitBtn).toBeDisabled()

    const stateSelect = await screen.findByLabelText(/state/i)
    await user.selectOptions(stateSelect, 'UT')
    expect(submitBtn).toBeEnabled()

    await user.click(submitBtn)
    expect(posted[0]).toMatchObject({ state: 'UT' })
  })

  // The client no longer guesses from facets: facets only reports states that
  // already HAVE bills, so exactly-one-state is not evidence of a single-state
  // tenant. Only the server's tenantState (c.env.STATE) hides the field.
  it('does not show a State field when the server reports a configured single state', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: 'UT' } as never
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    expect(await screen.findByDisplayValue('D1')).toBeInTheDocument()
    expect(screen.queryByLabelText(/^state/i)).not.toBeInTheDocument()
  })

  // The regression this finding was filed for: a multi-state tenant whose bills
  // all sit in one state. Facets says "UT only", which the old facets-derived
  // guess read as single-state — hiding the field and leaving the admin with no
  // way to satisfy the server's empty-state 400.
  it('shows the State field when tenantState is null even though facets reports exactly one state', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: null } as never
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    expect(await screen.findByLabelText(/^state/i)).toBeInTheDocument()
  })

  it('shows the State field when the draft-defaults call fails, rather than assuming single-state', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      if (path.startsWith('/bills/draft-defaults')) throw new api.ApiError(500, 'defaults unavailable')
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    expect(await screen.findByLabelText(/^state/i)).toBeInTheDocument()
  })

  // Facets is still the option list. When it yields nothing usable the field
  // falls back to free text — an empty select would be unsatisfiable.
  it('falls back to a free-text State input when facets reports zero states', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: {} } as never
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: null } as never
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    const field = await screen.findByLabelText(/^state/i)
    expect(field.tagName).toBe('INPUT')
    await user.type(field, 'tx')
    expect(field).toHaveValue('TX')
  })

  it('falls back to a free-text State input when the facets call fails', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') throw new api.ApiError(500, 'facets unavailable')
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2026, tenantState: null } as never
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    const field = await screen.findByLabelText(/^state/i)
    expect(field.tagName).toBe('INPUT')
  })
})

describe('DraftBills defaults follow the chosen state', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('refetches draft-defaults with ?state= and updates the prefilled number and year', async () => {
    const calls: string[] = []
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { TX: 2, UT: 3 } } as never
      if (path.startsWith('/bills/draft-defaults')) {
        calls.push(path)
        // The stateless '' bucket on a multi-state tenant: three legacy drafts
        // backfilled there, so it prefills D4 — a number TX has never used.
        if (path === '/bills/draft-defaults') return { billNumber: 'D4', year: 2026, tenantState: null } as never
        if (path === '/bills/draft-defaults?state=TX') return { billNumber: 'D1', year: 2027, tenantState: null } as never
      }
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    expect(await screen.findByLabelText(/bill number/i)).toHaveValue('D4')

    await user.selectOptions(await screen.findByLabelText(/^state/i), 'TX')

    await screen.findByDisplayValue('D1')
    expect(screen.getByLabelText(/bill number/i)).toHaveValue('D1')
    expect(screen.getByLabelText(/year/i)).toHaveValue('2027')
    expect(calls).toContain('/bills/draft-defaults?state=TX')
  })
})

describe('DraftBills year select', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('holds a real option before defaults arrive and always offers the current year', async () => {
    const thisYear = String(new Date().getFullYear())
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      // Central unreachable on the server: the fallback is the tenant's newest
      // filed year, which can be in the past.
      if (path.startsWith('/bills/draft-defaults')) return { billNumber: 'D1', year: 2020, tenantState: 'UT' } as never
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))

    const yearSelect = await screen.findByLabelText(/year/i)
    // The displayed option and the held value must agree — draftYear is never
    // '', which would match no option and render the first one instead.
    await screen.findByRole('option', { name: '2020', selected: true })
    expect(yearSelect).toHaveValue('2020')
    // A past base must not push the current year out of reach.
    expect(screen.getByRole('option', { name: thisYear })).toBeInTheDocument()
    await user.selectOptions(yearSelect, thisYear)
    expect(yearSelect).toHaveValue(thisYear)
  })
})
