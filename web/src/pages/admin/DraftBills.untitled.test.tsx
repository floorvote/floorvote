import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { DraftBills } from './DraftBills'
import * as api from '../../lib/api'

// Untitled drafts: Title is optional on the create form, and a draft with no
// title reads "Untitled draft" in the list.

vi.mock('../../context/DemoContext', () => ({
  useDemo: () => ({ demoMode: false, demoLocked: false }),
}))

type Draft = { id: string; billNumber: string; title: string; state: string | null }

function mockApi(opts: { drafts?: Draft[]; tenantState?: string | null; states?: Record<string, number> } = {}) {
  const posted: Record<string, unknown>[] = []
  vi.spyOn(api, 'apiFetch').mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/bills/drafts') return { drafts: opts.drafts ?? [] } as never
    if (path === '/bills/facets') return { state: opts.states ?? { UT: 5 } } as never
    if (path.startsWith('/bills/draft-defaults')) {
      return { billNumber: 'D1', year: 2026, tenantState: 'tenantState' in opts ? opts.tenantState : 'UT' } as never
    }
    if (path === '/bills/draft') { posted.push(JSON.parse(String(init?.body))); return { id: 'new-draft' } as never }
    return {} as never
  })
  return posted
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/drafts']}>
      <Routes>
        <Route path="/admin/drafts" element={<DraftBills />} />
        <Route path="/bills/:id" element={<div>Bill page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function openForm() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /add draft bill/i }))
  await screen.findByDisplayValue('D1')
  return user
}

describe('DraftBills create form: Title is optional', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('does not mark Title as required', async () => {
    mockApi()
    renderPage()
    await openForm()
    const label = document.querySelector('label[for="draft-title"]') as HTMLLabelElement
    expect(label).toHaveTextContent(/^Title$/)
    expect(label.textContent).not.toContain('*')
  })

  it('enables Create draft with only a bill number on a single-state tenant', async () => {
    mockApi()
    renderPage()
    await openForm()
    expect(screen.getByLabelText(/^title/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /create draft/i })).toBeEnabled()
  })

  it('creates a draft with only a bill number, sending no title', async () => {
    const posted = mockApi()
    renderPage()
    const user = await openForm()
    await user.clear(screen.getByLabelText(/bill number/i))
    await user.type(screen.getByLabelText(/bill number/i), 'D7')
    await user.click(screen.getByRole('button', { name: /create draft/i }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ billNumber: 'D7' })
    expect(posted[0].title).toBeUndefined()
    expect(await screen.findByText('Bill page')).toBeInTheDocument()
  })

  it('sends no title when the title is only whitespace', async () => {
    const posted = mockApi()
    renderPage()
    const user = await openForm()
    await user.type(screen.getByLabelText(/^title/i), '   ')
    await user.click(screen.getByRole('button', { name: /create draft/i }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].title).toBeUndefined()
  })

  it('still sends a typed title, trimmed', async () => {
    const posted = mockApi()
    renderPage()
    const user = await openForm()
    await user.type(screen.getByLabelText(/^title/i), '  Draft bill title ')
    await user.click(screen.getByRole('button', { name: /create draft/i }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ title: 'Draft bill title', billNumber: 'D1' })
  })

  it('on a multi-state tenant, keeps Create draft disabled until a state is chosen, then enables it with no title', async () => {
    const posted = mockApi({ tenantState: null, states: { UT: 3, ID: 1 } })
    renderPage()
    const user = await openForm()

    const submit = screen.getByRole('button', { name: /create draft/i })
    // Blocked quietly while State is missing (#231): aria-disabled, not native disabled.
    expect(submit).toHaveAttribute('aria-disabled', 'true')

    await user.click(await screen.findByLabelText(/^state/i))
    fireEvent.click(screen.getByRole('radio', { name: 'UT' }))
    expect(submit).toBeEnabled()
    expect(submit).not.toHaveAttribute('aria-disabled')

    await user.click(submit)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ state: 'UT', billNumber: 'D1' })
    expect(posted[0].title).toBeUndefined()
  })
})

describe('DraftBills list: untitled drafts', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('shows "Untitled draft" for a draft with no title, next to its number', async () => {
    mockApi({ drafts: [{ id: 'd1', billNumber: 'D1', title: '', state: 'UT' }] })
    renderPage()
    expect(await screen.findByText('Untitled draft')).toBeInTheDocument()
    expect(screen.getByText('D1')).toBeInTheDocument()
  })

  it('shows "Untitled draft" for a whitespace-only title', async () => {
    mockApi({ drafts: [{ id: 'd1', billNumber: 'D1', title: '  ', state: 'UT' }] })
    renderPage()
    expect(await screen.findByText('Untitled draft')).toBeInTheDocument()
  })

  it("shows a titled draft's own title and no fallback", async () => {
    mockApi({ drafts: [
      { id: 'd1', billNumber: 'D1', title: 'Draft bill title', state: 'UT' },
      { id: 'd2', billNumber: 'D2', title: '', state: 'UT' },
    ] })
    renderPage()
    expect(await screen.findByText('Draft bill title')).toBeInTheDocument()
    expect(screen.getAllByText('Untitled draft')).toHaveLength(1)
  })
})
