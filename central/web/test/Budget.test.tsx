import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Budget from '../src/pages/Budget'

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url)
    if (u.includes('/sync/api-budget')) {
      return new Response(JSON.stringify({
        data: {
          monthToDate: 12000,
          limit: 30000,
          monthDaily: [
            { date: '2026-06-01', calls: 400 },
            { date: '2026-06-02', calls: 600 },
          ],
          daily: [{ date: '2026-06-01', calls: 400 }],
          topCalls: [{ callType: 'getBill', calls: 9000 }],
        },
        meta: {},
      }))
    }
    if (u.includes('/budget/resend')) {
      return new Response(JSON.stringify({
        data: {
          monthlyUsed: 4200,
          monthlyLimit: 50000,
          dailyUsed: 12,
          dailyLimit: 100,
          usedAt: '2026-06-05T06:00:00Z',
          last429At: '',
          monthDaily: [
            { date: '2026-06-01', monthlyUsed: 100 },
            { date: '2026-06-02', monthlyUsed: 250 },
          ],
        },
        meta: {},
      }))
    }
    return new Response('{}')
  })
})

describe('Budget page', () => {
  it('renders LegiScan and Resend usage', async () => {
    render(<MemoryRouter><Budget /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/12,000/)).toBeInTheDocument())
    expect(screen.getByText(/of 30,000/)).toBeInTheDocument()
    expect(screen.getByText(/4,200/)).toBeInTheDocument()
    expect(screen.getByText(/of 50,000/)).toBeInTheDocument()
    expect(screen.getByText(/account-wide/i)).toBeInTheDocument()
  })

  it('renders on-pace readout for LegiScan', async () => {
    render(<MemoryRouter><Budget /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/12,000/)).toBeInTheDocument())
    expect(screen.getAllByText(/maximum pace/).length).toBeGreaterThan(0)
  })

  it('renders on-pace readout for Resend', async () => {
    render(<MemoryRouter><Budget /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/4,200/)).toBeInTheDocument())
    expect(screen.getAllByText(/maximum pace/).length).toBeGreaterThan(0)
  })
})
