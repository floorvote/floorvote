import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../../src/db/schema'
import { settings } from '../../src/db/schema'
import { joinAlertThread, closeAlertThread, ALERT_THREAD_QUIET_MS } from '../../src/lib/alertThread'
import { alertThreadHeaders } from '../../../shared/alertThread'
import { clearDb } from '../helpers/migrations'

// A job's alerts, and the resolved email that ends them, share one
// conversation per outage. The shared module makes the headers that group a
// conversation; central keeps each job's open conversation in `settings`.
// Both are tested here, in the Workers pool with real D1.

const db = () => drizzle(env.DB, { schema })
const T0 = Date.parse('2026-11-08T16:00:00Z')
const H = 3_600_000
const DAY = 24 * H
/** When the conversation an alert sent at `now` joins started. */
const startOf = async (job: string, now: number) => (await joinAlertThread(db(), job, now)).startedAt

beforeEach(async () => {
  await clearDb()
})

describe('the headers that put a conversation\'s emails together', () => {
  const thread = { key: 'ls-sync', startedAt: T0, domain: 'example.com', topic: '[FloorVote] cron failed: ls-sync' }

  it('points In-Reply-To and References at one made-up root for the conversation', async () => {
    const h = await alertThreadHeaders(thread)
    expect(h['In-Reply-To']).toMatch(/^<alert\.ls-sync\.[a-z0-9]+@example\.com>$/)
    expect(h['References']).toBe(h['In-Reply-To'])
  })

  it('names the conversation in Thread-Topic', async () => {
    expect((await alertThreadHeaders(thread))['Thread-Topic']).toBe('[FloorVote] cron failed: ls-sync')
  })

  it('gives every email of one conversation the same headers', async () => {
    expect(await alertThreadHeaders({ ...thread })).toEqual(await alertThreadHeaders(thread))
  })

  it('gives a conversation that started at another time its own root and Thread-Index', async () => {
    const a = await alertThreadHeaders(thread)
    const b = await alertThreadHeaders({ ...thread, startedAt: T0 + 1000 })
    expect(b['References']).not.toBe(a['References'])
    expect(b['Thread-Index']).not.toBe(a['Thread-Index'])
  })

  it('builds an Outlook Thread-Index: the start time\'s header block, then a GUID taken from the root', async () => {
    const h = await alertThreadHeaders(thread)
    const bytes = Uint8Array.from(atob(h['Thread-Index']), c => c.charCodeAt(0))
    expect(bytes).toHaveLength(22)
    expect(bytes[0]).toBe(0x01)
    // Bytes 0 to 5: the first six bytes of the start time as a big-endian FILETIME.
    const filetime = new Uint8Array(8)
    new DataView(filetime.buffer).setBigUint64(0, BigInt(T0) * 10_000n + 116_444_736_000_000_000n)
    expect([...bytes.subarray(0, 6)]).toEqual([...filetime.subarray(0, 6)])
    // Bytes 6 to 21: the first 16 bytes of the root's SHA-256.
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(h['References'])))
    expect([...bytes.subarray(6)]).toEqual([...digest.subarray(0, 16)])
  })

  it('turns characters a Message-ID can\'t hold into underscores', async () => {
    const h = await alertThreadHeaders({ ...thread, key: 'email health/cloudflare' })
    expect(h['References']).toMatch(/^<alert\.email_health_cloudflare\.[a-z0-9]+@example\.com>$/)
  })

  it('keeps the root a dot-atom when the key has doubled or trailing dots', async () => {
    const h = await alertThreadHeaders({ ...thread, key: 'a..b.' })
    expect(h['References']).toMatch(/^<alert\.a_\.b_\.[a-z0-9]+@example\.com>$/)
  })
})

describe('the conversation a job\'s alert joins', () => {
  it('starts one on the job\'s first alert', async () => {
    expect(await startOf('ls-sync', T0)).toBe(T0)
  })

  it('joins the open one on the job\'s next alert', async () => {
    await startOf('ls-sync', T0)
    expect(await startOf('ls-sync', T0 + 4 * H)).toBe(T0)
  })

  it('keeps each job\'s conversation apart', async () => {
    await startOf('ls-sync', T0)
    expect(await startOf('mga-sync', T0 + H)).toBe(T0 + H)
  })

  it('starts a new one once the job has sent nothing for three days', async () => {
    await startOf('ls-sync', T0)
    expect(ALERT_THREAD_QUIET_MS).toBe(3 * DAY)
    expect(await startOf('ls-sync', T0 + 3 * DAY)).toBe(T0 + 3 * DAY)
  })

  it('counts the quiet from the job\'s latest alert, not its first', async () => {
    await startOf('ls-sync', T0)
    await startOf('ls-sync', T0 + 2 * DAY)
    expect(await startOf('ls-sync', T0 + 4 * DAY)).toBe(T0)
  })

  it('starts a new one after the job\'s conversation is closed', async () => {
    const first = await joinAlertThread(db(), 'ls-sync', T0)
    await closeAlertThread(db(), 'ls-sync', first)
    expect(await startOf('ls-sync', T0 + H)).toBe(T0 + H)
  })

  it('leaves a newer conversation open when told to close an older one', async () => {
    const old = await joinAlertThread(db(), 'ls-sync', T0)
    await closeAlertThread(db(), 'ls-sync', old)
    const current = await startOf('ls-sync', T0 + H)
    await closeAlertThread(db(), 'ls-sync', old)
    expect(await startOf('ls-sync', T0 + 2 * H)).toBe(current)
  })

  it('leaves the conversation open when another alert joined it after the closer did', async () => {
    // The resolved email joins, and while it sends, another run's alert joins too.
    const resolved = await joinAlertThread(db(), 'ls-sync', T0)
    await joinAlertThread(db(), 'ls-sync', T0 + 1000)
    await closeAlertThread(db(), 'ls-sync', resolved)
    expect(await startOf('ls-sync', T0 + 2000)).toBe(T0)
  })

  it('puts two alerts sent at the same moment in the same conversation', async () => {
    const [a, b] = await Promise.all([startOf('ls-sync', T0), startOf('ls-sync', T0 + 1)])
    expect(a).toBe(b)
  })

  it('puts two alerts sent at the same moment in one new conversation when the stored one has gone quiet', async () => {
    await startOf('ls-sync', T0)
    const later = T0 + 4 * DAY
    const [a, b] = await Promise.all([startOf('ls-sync', later), startOf('ls-sync', later + 1)])
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(later)
  })

  it('starts a new one when the stored conversation can\'t be read', async () => {
    await db().insert(settings).values({ key: 'alert-thread:ls-sync', value: 'not json' })
    expect(await startOf('ls-sync', T0)).toBe(T0)
    expect(await startOf('ls-sync', T0 + H)).toBe(T0)
  })
})
