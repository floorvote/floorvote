import { describe, it, expect } from 'vitest'
import { userDetailLine } from '../lib/billCardModel'
import type { FeedEvent } from '../lib/feedUtils'

function makeEvent(overrides: Partial<FeedEvent>): FeedEvent {
  return {
    id: 'evt-1',
    type: 'comment_added',
    billId: 'bill-1',
    billNumber: 'HB 1',
    billSessionSlug: '2026',
    billState: 'RI',
    billTitle: 'Test Bill',
    billSummary: null,
    billPriority: null,
    billMatchType: null,
    userId: 'user-1',
    userName: 'Jane Doe',
    userSubtitle: null,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('userDetailLine', () => {
  it('wraps a comment preview in matched quotes', () => {
    const line = userDetailLine(makeEvent({
      type: 'comment_added',
      metadata: { preview: 'Hi, @everyone! I am testing the feature.' },
    }))
    expect(line).toBe('Jane Doe: "Hi, @everyone! I am testing the feature."')
  })

  it('strips HTML tags from the preview before quoting', () => {
    const line = userDetailLine(makeEvent({
      type: 'comment_added',
      metadata: { preview: '<p>Looks <strong>good</strong></p>' },
    }))
    expect(line).toBe('Jane Doe: "Looks good"')
  })
})
