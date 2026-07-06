import { describe, it, expect, vi, afterEach } from 'vitest'
import { getEmailDeliveryStatus } from '../../src/lib/emailDelivery'

const creds = { CF_ANALYTICS_TOKEN: 'tok', CF_FLOORVOTE_ZONE_ID: 'zone1' }
afterEach(() => vi.restoreAllMocks())

const gql = (events: unknown[]) => new Response(JSON.stringify({
  data: { viewer: { zones: [{ emailSendingAdaptive: events }] } },
}), { status: 200 })

describe('getEmailDeliveryStatus', () => {
  it('returns {} when creds are missing', async () => {
    expect(await getEmailDeliveryStatus({}, { messageIds: ['m1'], since: '2026-06-01T00:00:00Z' })).toEqual({})
  })

  it('returns {} when no messageIds requested', async () => {
    expect(await getEmailDeliveryStatus(creds, { messageIds: [], since: '2026-06-01T00:00:00Z' })).toEqual({})
  })

  it('maps requested messageIds to their latest status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(gql([
      { messageId: 'm1', status: 'delivered', isSpam: 0, errorCause: '', datetime: '2026-06-20T10:00:00Z' },
      { messageId: 'm2', status: 'deliveryFailed', isSpam: 0, errorCause: 'hard_bounce', datetime: '2026-06-20T11:00:00Z' },
    ])))
    const out = await getEmailDeliveryStatus(creds, { messageIds: ['m1', 'm2'], since: '2026-06-01T00:00:00Z' })
    expect(out.m1.status).toBe('delivered')
    expect(out.m1.isSpam).toBe(false)
    expect(out.m2.errorCause).toBe('hard_bounce')
  })

  it('returns {} (not an error) on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await getEmailDeliveryStatus(creds, { messageIds: ['m1'], since: '2026-06-01T00:00:00Z' })).toEqual({})
  })
})
