import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DraftBills } from './DraftBills'
import * as api from '../../lib/api'

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
