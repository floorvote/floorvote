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
    if (u.includes('/budget/ai')) {
      return new Response(JSON.stringify({
        data: {
          available: true,
          total: 321,
          cost: 4.33,
          tokensIn: 11702187,
          tokensOut: 386911,
          windowDays: 30,
          daily: [{ date: '2026-07-01', count: 5, cost: 0.1 }],
          topModels: [{ model: 'gemini-2.5-flash', count: 321, cost: 4.25 }],
        },
        meta: {},
      }))
    }
    return new Response('{}')
  })
})

describe('Budget page', () => {
  it('renders LegiScan usage', async () => {
    render(<MemoryRouter><Budget /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/12,000/)).toBeInTheDocument())
    expect(screen.getByText(/of 30,000/)).toBeInTheDocument()
  })

  it('renders on-pace readout for LegiScan', async () => {
    render(<MemoryRouter><Budget /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/12,000/)).toBeInTheDocument())
    expect(screen.getAllByText(/maximum pace/).length).toBeGreaterThan(0)
  })

  it('renders AI usage from the gateway analytics', async () => {
    render(<MemoryRouter><Budget /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/estimated Gemini spend · last 30 days/)).toBeInTheDocument())
    expect(screen.getByText(/\$4\.33/)).toBeInTheDocument()
    expect(screen.getByText(/gemini-2\.5-flash/)).toBeInTheDocument()
  })
})
