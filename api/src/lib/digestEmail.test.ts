import { describe, it, expect } from 'vitest'
import { renderDigestEmail, type DigestEvent } from './digestEmail'

const sampleEvents: DigestEvent[] = [
  {
    type: 'bill_status_update',
    metadata: JSON.stringify({ status: 'Passed committee' }),
    createdAt: '2026-06-23 12:00:00',
    billId: 'legiscan:1001',
    billNumber: 'H 5001',
    billTitle: 'An Act Relating to Elections',
    billState: 'RI',
    billSession: '2026',
    priority: 'high',
    summary: 'Updates voter registration deadlines.',
    userName: null,
  },
  {
    type: 'official_position_set',
    metadata: JSON.stringify({ position: 'support' }),
    createdAt: '2026-06-24 09:30:00',
    billId: 'legiscan:1002',
    billNumber: 'S 2002',
    billTitle: 'An Act Relating to Mail Ballots',
    billState: 'RI',
    billSession: '2026',
    priority: 'medium',
    summary: null,
    userName: 'Sam Ortiz',
  },
]

describe('renderDigestEmail', () => {
  it('renders the multi-bill signal sentence, instance name, range, and a bill number', () => {
    const html = renderDigestEmail({
      events: sampleEvents,
      assocName: 'Test Organization',
      appUrl: 'https://ri.example.com',
      periodStart: '2026-06-20T00:00:00.000Z',
      periodEnd: '2026-06-26T00:00:00.000Z',
    })
    expect(html).toContain('were updated in the last week')
    expect(html).toContain('Test Organization')
    expect(html).toContain('Jun 20')
    expect(html).toContain('H 5001')
  })
})
