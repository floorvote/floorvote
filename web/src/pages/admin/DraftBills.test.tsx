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
    expect(deleteBtn).toHaveAttribute('title', 'Read-only in demo mode')
  })

  it('keeps the plain delete-draft tooltip when not demoLocked', async () => {
    mockDrafts([{ id: 'd1', billNumber: 'DRAFT-1', title: 'A draft bill', state: null }])
    render(<MemoryRouter><DraftBills /></MemoryRouter>)
    const deleteBtn = await screen.findByRole('button', { name: 'delete' })
    expect(deleteBtn).toHaveAttribute('title', 'Delete draft')
  })
})
