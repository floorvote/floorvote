import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, cleanup } from '@testing-library/react'
import React from 'react'

vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '../../lib/api'
import { KeywordMatchSummary } from './KeywordMatchSummary'

const mockFetch = vi.mocked(apiFetch)

type Summary = { total: number; matched: number; newlyMatched: number; unmatched: number }

function respondWith(summary: Summary) {
  mockFetch.mockResolvedValue(summary)
}

// Lets the debounce timer fire and the resulting fetch settle.
async function settle(ms = 600) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

function bodyOf(call: number): { keywords: string[] } {
  return JSON.parse((mockFetch.mock.calls[call][1] as RequestInit).body as string)
}

describe('KeywordMatchSummary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('shows nothing until the first count arrives', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    const { container } = render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
    expect(container.textContent).toBe('')
  })

  describe('line one', () => {
    it('shows matched of total bills and a rounded percentage, with the counts bold', async () => {
      respondWith({ total: 60, matched: 22, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.getByText(/This keyword set matches/).textContent).toBe('This keyword set matches 22 of 60 bills (37%).')
      expect(screen.getByText('22 of 60 bills (37%)').tagName).toBe('STRONG')
    })

    it('rounds the percentage to a whole number', async () => {
      respondWith({ total: 6500, matched: 2405, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.getByText('2,405 of 6,500 bills (37%)')).toBeTruthy()
    })

    it('reads "<1%" rather than "0%" for a small share above zero', async () => {
      respondWith({ total: 6500, matched: 22, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.getByText('22 of 6,500 bills (<1%)')).toBeTruthy()
    })

    it('reads ">99%" rather than "100%" when some bills do not match', async () => {
      respondWith({ total: 6500, matched: 6490, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="*corporat*" savedKeywords="*corporat*" />)
      await settle()
      expect(screen.getByText('6,490 of 6,500 bills (>99%)')).toBeTruthy()
    })

    it('reads "0%" for no matches and "100%" for every bill', async () => {
      respondWith({ total: 6500, matched: 0, newlyMatched: 0, unmatched: 0 })
      const { rerender } = render(<KeywordMatchSummary keywords="zzz" savedKeywords="zzz" />)
      await settle()
      expect(screen.getByText('0 of 6,500 bills (0%)')).toBeTruthy()

      respondWith({ total: 6500, matched: 6500, newlyMatched: 0, unmatched: 0 })
      rerender(<KeywordMatchSummary keywords="*" savedKeywords="*" />)
      await settle()
      expect(screen.getByText('6,500 of 6,500 bills (100%)')).toBeTruthy()
    })

    it('uses the singular when the instance has one bill', async () => {
      respondWith({ total: 1, matched: 1, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.getByText('1 of 1 bill (100%)')).toBeTruthy()
    })

    it('reads zero of zero when the instance has no bills', async () => {
      respondWith({ total: 0, matched: 0, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.getByText('0 of 0 bills (0%)')).toBeTruthy()
    })
  })

  describe('line two', () => {
    it('is absent when the box matches the saved keywords', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.queryByText(/Saving these keywords/)).toBeNull()
    })

    it('is absent when the box differs only by blank lines, whitespace, and case', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 3, unmatched: 2 })
      render(<KeywordMatchSummary keywords={'  ELECTION \n\n   \nHealth Care\n'} savedKeywords={'election\nhealth care'} />)
      await settle()
      expect(screen.queryByText(/Saving these keywords/)).toBeNull()
    })

    it('names both clauses with bold, pluralized counts', async () => {
      respondWith({ total: 6500, matched: 22, newlyMatched: 4, unmatched: 1 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText(/Saving these keywords/).textContent)
        .toBe('Saving these keywords would newly match 4 bills and unmatch 1 bill.')
      expect(screen.getByText('4 bills').tagName).toBe('STRONG')
      expect(screen.getByText('1 bill').tagName).toBe('STRONG')
    })

    it('pluralizes each count on its own', async () => {
      respondWith({ total: 6500, matched: 22, newlyMatched: 1, unmatched: 12 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText(/Saving these keywords/).textContent)
        .toBe('Saving these keywords would newly match 1 bill and unmatch 12 bills.')
    })

    it('separates thousands in the counts', async () => {
      respondWith({ total: 60000, matched: 5000, newlyMatched: 1234, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText('1,234 bills')).toBeTruthy()
    })

    it('drops the unmatch clause when nothing would unmatch', async () => {
      respondWith({ total: 6500, matched: 22, newlyMatched: 4, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText(/Saving these keywords/).textContent)
        .toBe('Saving these keywords would newly match 4 bills.')
    })

    it('drops the newly-match clause when nothing would newly match', async () => {
      respondWith({ total: 6500, matched: 22, newlyMatched: 0, unmatched: 1 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText(/Saving these keywords/).textContent)
        .toBe('Saving these keywords would unmatch 1 bill.')
    })

    it('says nothing would change when both counts are zero', async () => {
      respondWith({ total: 6500, matched: 22, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText("Saving these keywords wouldn't change which bills match.")).toBeTruthy()
    })

    it('goes away once the box is saved, without another count', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 3, unmatched: 0 })
      const { rerender } = render(<KeywordMatchSummary keywords="election" savedKeywords="health" />)
      await settle()
      expect(screen.getByText(/Saving these keywords/)).toBeTruthy()

      rerender(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(screen.queryByText(/Saving these keywords/)).toBeNull()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('treats an empty box against saved keywords as a change', async () => {
      respondWith({ total: 100, matched: 0, newlyMatched: 0, unmatched: 5 })
      render(<KeywordMatchSummary keywords="" savedKeywords="election" />)
      await settle()
      expect(screen.getByText(/Saving these keywords/).textContent).toBe('Saving these keywords would unmatch 5 bills.')
    })
  })

  describe('fetching', () => {
    it('sends the trimmed, non-blank keywords', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      render(<KeywordMatchSummary keywords={'  election  \n\n*corporat*\n  '} savedKeywords="election" />)
      await settle()
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch.mock.calls[0][0]).toBe('/admin/keyword-match-summary')
      expect((mockFetch.mock.calls[0][1] as RequestInit).method).toBe('POST')
      expect(bodyOf(0)).toEqual({ keywords: ['election', '*corporat*'] })
    })

    it('waits for typing to stop, then counts once with the latest text', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      const { rerender } = render(<KeywordMatchSummary keywords="e" savedKeywords="e" />)
      await settle()
      expect(mockFetch).toHaveBeenCalledTimes(1)

      rerender(<KeywordMatchSummary keywords="el" savedKeywords="e" />)
      await settle(100)
      rerender(<KeywordMatchSummary keywords="ele" savedKeywords="e" />)
      await settle(100)
      rerender(<KeywordMatchSummary keywords="elec" savedKeywords="e" />)
      await settle(400)
      expect(mockFetch).toHaveBeenCalledTimes(1)

      await settle(100)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(bodyOf(1)).toEqual({ keywords: ['elec'] })
    })

    it('does not count again for an edit that leaves the keyword list unchanged', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      const { rerender } = render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      rerender(<KeywordMatchSummary keywords={'election\n\n  '} savedKeywords="election" />)
      await settle()
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('keeps the last count on screen while the next one loads', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      const { rerender } = render(<KeywordMatchSummary keywords="a" savedKeywords="a" />)
      await settle()
      mockFetch.mockReturnValue(new Promise(() => {}))
      rerender(<KeywordMatchSummary keywords="ab" savedKeywords="a" />)
      await settle()
      expect(screen.getByText('10 of 100 bills (10%)')).toBeTruthy()
    })

    it('ignores a slow answer that arrives after a newer one', async () => {
      let resolveSlow: (s: Summary) => void = () => {}
      mockFetch.mockReturnValueOnce(new Promise<Summary>(r => { resolveSlow = r }))
      const { rerender } = render(<KeywordMatchSummary keywords="a" savedKeywords="a" />)
      await settle(0)

      mockFetch.mockResolvedValueOnce({ total: 100, matched: 50, newlyMatched: 0, unmatched: 0 })
      rerender(<KeywordMatchSummary keywords="ab" savedKeywords="a" />)
      await settle()
      expect(screen.getByText('50 of 100 bills (50%)')).toBeTruthy()

      await act(async () => { resolveSlow({ total: 100, matched: 1, newlyMatched: 0, unmatched: 0 }) })
      expect(screen.getByText('50 of 100 bills (50%)')).toBeTruthy()
    })

    it('clears the old count when a later count fails', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      const { rerender, container } = render(<KeywordMatchSummary keywords="a" savedKeywords="a" />)
      await settle()
      expect(screen.getByText('10 of 100 bills (10%)')).toBeTruthy()

      mockFetch.mockRejectedValue(new Error('503'))
      rerender(<KeywordMatchSummary keywords="ab" savedKeywords="a" />)
      await settle()
      expect(container.textContent).toBe('')
    })

    it('clears the old count when a later response is not a count', async () => {
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      const { rerender, container } = render(<KeywordMatchSummary keywords="a" savedKeywords="a" />)
      await settle()

      mockFetch.mockResolvedValue({} as Summary)
      rerender(<KeywordMatchSummary keywords="ab" savedKeywords="a" />)
      await settle()
      expect(container.textContent).toBe('')
    })

    it('counts again after a failure once the keywords change', async () => {
      mockFetch.mockRejectedValueOnce(new Error('503'))
      const { rerender } = render(<KeywordMatchSummary keywords="a" savedKeywords="a" />)
      await settle()
      respondWith({ total: 100, matched: 10, newlyMatched: 0, unmatched: 0 })
      rerender(<KeywordMatchSummary keywords="ab" savedKeywords="a" />)
      await settle()
      expect(screen.getByText('10 of 100 bills (10%)')).toBeTruthy()
    })

    it('shows nothing when the count fails', async () => {
      mockFetch.mockRejectedValue(new Error('boom'))
      const { container } = render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(container.textContent).toBe('')
    })

    it('shows nothing for a response that is not a count', async () => {
      mockFetch.mockResolvedValue({})
      const { container } = render(<KeywordMatchSummary keywords="election" savedKeywords="election" />)
      await settle()
      expect(container.textContent).toBe('')
    })
  })
})
