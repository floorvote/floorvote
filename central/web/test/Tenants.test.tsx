import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Tenants from '../src/pages/Tenants'

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    data: { tenants: [{ id: 'ri', name: 'RI', states: ['RI'], billCounts: { keyword: 5, manual: 2, null: 1, total: 8 }, keywordCount: 3, lastBillIngestedAt: '2026-05-28T00:00:00Z', lastActivityAt: '2026-05-28T01:00:00Z' }] }, meta: {}
  })))
})

describe('Tenants page', () => {
  it('renders tenant rows', async () => {
    render(<MemoryRouter><Tenants /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('ri')).toBeInTheDocument())
  })
})
