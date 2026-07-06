import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Adoption from '../src/pages/Adoption'

// jsdom has no real canvas context; stub the chart so toggle-driven re-renders
// don't crash inside chart.js. We assert on the toggle UI, not the canvas.
vi.mock('react-chartjs-2', () => ({ Line: () => null }))

const mkMetric = (vals: Record<string, number[]>) => vals
const SERIES_RESPONSE = {
  data: {
    tenants: [
      { id: 'ri', name: 'Rhode Island' },
      { id: 'demo', name: 'Demo' },
    ],
    dates: ['2026-05-28'],
    metrics: {
      total_members: mkMetric({ ri: [12], demo: [99] }),
      active_members_7d: mkMetric({ ri: [4], demo: [9] }),
      active_members_30d: mkMetric({ ri: [8], demo: [9] }),
      votes_cast: mkMetric({ ri: [30], demo: [9] }),
      comments_written: mkMetric({ ri: [10], demo: [9] }),
      comment_reactions: mkMetric({ ri: [5], demo: [9] }),
      positions_set: mkMetric({ ri: [3], demo: [9] }),
      notes_created: mkMetric({ ri: [2], demo: [9] }),
      custom_field_values: mkMetric({ ri: [40], demo: [9] }),
      bills_with_engagement: mkMetric({ ri: [8], demo: [9] }),
      roles_defined: mkMetric({ ri: [2], demo: [9] }),
      custom_fields_defined: mkMetric({ ri: [2], demo: [9] }),
      bills_ai_processed: mkMetric({ ri: [60], demo: [9] }),
    },
  },
  meta: {},
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(JSON.stringify(SERIES_RESPONSE)),
  )
})

describe('Adoption page', () => {
  it('renders 13 chart titles and the export button', async () => {
    render(<MemoryRouter><Adoption /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Active Members (7d)')).toBeInTheDocument())
    expect(screen.getByText('AI Processed Bills')).toBeInTheDocument()
    expect(screen.getByText(/Download adoption stats as/)).toBeInTheDocument()
  })

  it('renders a toggle chip per tenant and persists hidden tenants', async () => {
    const { unmount } = render(<MemoryRouter><Adoption /></MemoryRouter>)
    const demoBtn = await screen.findByRole('button', { name: 'Demo' })
    expect(screen.getByRole('button', { name: 'Rhode Island' })).toBeInTheDocument()
    expect(screen.queryByText('Show all')).not.toBeInTheDocument()

    fireEvent.click(demoBtn)
    // Hiding a tenant persists it and surfaces the "Show all" reset
    expect(screen.getByText('Show all')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem('adoption.hiddenTenants')!)).toEqual(['demo'])
    expect(screen.getByRole('button', { name: 'Demo' }).title).toBe('Show Demo')

    // Persists across remounts
    unmount()
    render(<MemoryRouter><Adoption /></MemoryRouter>)
    await screen.findByText('Show all')
    expect(screen.getByRole('button', { name: 'Demo' }).title).toBe('Show Demo')
  })
})
