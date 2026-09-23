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
      if (path === '/bills/draft-defaults') return { billNumber: 'D3', year: 2027 } as never
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
      if (path === '/bills/draft-defaults') return { billNumber: 'D1', year: 2026 } as never
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
      if (path === '/bills/draft-defaults') return { billNumber: 'D1', year: 2026 } as never
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

  // A facets outage must not be mistaken for "single state" — that's exactly
  // how the production state='' bug happened (see draftRoutes.ts's guard).
  // So this asserts the field is hidden only when facets succeeded and
  // reported exactly one state, not merely "facets wasn't mocked".
  it('does not show a State field on a confirmed single-state tenant', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') return { state: { UT: 5 } } as never
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    await screen.findByLabelText(/title/i)
    expect(screen.queryByLabelText(/^state/i)).not.toBeInTheDocument()
  })

  it('shows the State field when the facets call fails, rather than assuming single-state', async () => {
    vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string) => {
      if (path === '/bills/drafts') return { drafts: [] } as never
      if (path === '/bills/facets') throw new api.ApiError(500, 'facets unavailable')
      return {} as never
    })
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
    expect(await screen.findByLabelText(/^state/i)).toBeInTheDocument()
  })
})
