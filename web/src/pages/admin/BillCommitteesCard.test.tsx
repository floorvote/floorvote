import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup, fireEvent, within } from '@testing-library/react'
import React from 'react'

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

import { apiFetch } from '../../lib/api'
import { BillCommitteesCard } from './BillCommitteesCard'

// The Bill committees card (#471, picker variant B with variant C's review-and-save step): each committee sized
// against the session, procedural committees behind a reveal with a warning, a live total and share, and a review
// step that states the total before saving and asks for an acknowledgment when a procedural committee is picked.

const mockFetch = vi.mocked(apiFetch)

const PICKER = {
  counts: { 101: 40, 102: 10, 103: 300 },
  info: {
    101: { name: 'Judiciary', state: 'RI', chamber: 'S' },
    102: { name: 'Health', state: 'RI', chamber: 'S' },
    103: { name: 'Rules', state: 'RI', chamber: 'S' },
  },
  stateTotals: { RI: 500 },
  selected: [] as string[],
  summary: { total: 500, analyzed: 60, added: 0 },
}

/** The summary each set of picks gets, by the picks joined with commas. */
const SUMMARIES: Record<string, { total: number; analyzed: number; added: number }> = {
  '': { total: 500, analyzed: 60, added: 0 },
  '101': { total: 500, analyzed: 100, added: 40 },
  '103': { total: 500, analyzed: 330, added: 270 },
}

function routeFetch() {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/admin/bill-committees') return PICKER
    if (url === '/admin/bill-committees/summary') {
      const { committees } = JSON.parse(String(init?.body)) as { committees: string[] }
      return SUMMARIES[committees.join(',')]
    }
    if (url === '/admin/config') return { ok: true }
    if (url === '/admin/keyword-resync') return { queued: 40, demoted: 0, centralStatus: 'ok' }
    throw new Error(`unexpected ${url}`)
  })
}

async function settle(ms = 600) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function renderCard() {
  render(<BillCommitteesCard demoLocked={false} />)
  await settle()
}

describe('BillCommitteesCard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    routeFetch()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("shows each committee's size against the session", async () => {
    await renderCard()
    const bar = screen.getByRole('meter', { name: /Judiciary \(Senate\)/ })
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect(bar.getAttribute('aria-valuemax')).toBe('500')
    expect(screen.getByRole('checkbox', { name: /Judiciary \(Senate\)/ })).toBeTruthy()
    expect(screen.getByText('40 bills')).toBeTruthy()
  })

  it('hides procedural committees until shown, and warns when they are', async () => {
    await renderCard()
    expect(screen.queryByRole('checkbox', { name: /Rules \(Senate\)/ })).toBeNull()
    expect(screen.queryByText(/route or schedule bills/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show procedural committees (1)' }))

    expect(screen.getByRole('checkbox', { name: /Rules \(Senate\)/ })).toBeTruthy()
    expect(screen.getByText(/route or schedule bills/)).toBeTruthy()
  })

  it('keeps a live total of the bills that would be fully analyzed, and their share', async () => {
    await renderCard()
    expect(screen.getByRole('status').textContent).toContain('60 of 500 bills (12%)')

    fireEvent.click(screen.getByRole('checkbox', { name: /Judiciary \(Senate\)/ }))
    await settle()

    expect(screen.getByRole('status').textContent).toContain('100 of 500 bills (20%)')
  })

  it('states the total and share before saving, then saves the picks and syncs', async () => {
    await renderCard()
    fireEvent.click(screen.getByRole('checkbox', { name: /Judiciary \(Senate\)/ }))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Review and save…' }))
    const review = screen.getByRole('group', { name: 'Review and save' })
    expect(review.textContent).toContain('100 of 500 bills (20%)')
    expect(review.textContent).toContain('40 bills that are not analyzed now')
    expect(mockFetch.mock.calls.some(([url]) => url === '/admin/config')).toBe(false)

    fireEvent.click(within(review).getByRole('button', { name: 'Save committees' }))
    await settle()

    const put = mockFetch.mock.calls.find(([url]) => url === '/admin/config')
    expect(put?.[1]?.method).toBe('PUT')
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ bill_committees: ['101'] })
    expect(mockFetch.mock.calls.some(([url, init]) => url === '/admin/keyword-resync' && init?.method === 'POST')).toBe(true)
  })

  it('asks for an acknowledgment before saving a procedural committee', async () => {
    await renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Show procedural committees (1)' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Rules \(Senate\)/ }))
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Review and save…' }))
    const review = screen.getByRole('group', { name: 'Review and save' })
    const save = within(review).getByRole('button', { name: 'Save committees' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.click(within(review).getByRole('checkbox', { name: /Rules \(Senate\)/ }))

    expect(save.disabled).toBe(false)
  })
})
