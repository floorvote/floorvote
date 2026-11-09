/**
 * Mail headers that make a run of alert emails one conversation: the alerts
 * sent while something keeps failing, and the email that says it recovered.
 *
 * The emails can't point at one another, since Cloudflare Email Service sets
 * each Message-ID itself and rejects a send that sets one. So every email of a
 * conversation carries the same made-up root instead:
 * - In-Reply-To and References name the root. Apple Mail groups on these,
 *   even when a later email's subject differs. Outlook grouped same-subject
 *   emails that shared the root, but splits alerts that carry no such
 *   headers at all.
 * - Thread-Index and Thread-Topic, which Outlook and Exchange Online group
 *   on. With them Outlook kept a resolved email in the conversation although
 *   its subject differs, which a reference alone didn't do.
 * Both were checked against Outlook (Microsoft 365) and Apple Mail on a Mac in
 * November 2026. Other mail apps weren't checked.
 */
export type AlertThread = {
  /** What the conversation is about, such as a job's name. Part of the root. */
  key: string
  /** When the conversation started, in epoch ms. Part of the root, so the next one differs. */
  startedAt: number
  /** The root's domain: the sender's, or the instance's host. */
  domain: string
  /** The conversation's name for Outlook: the subject of its first alert. */
  topic: string
}

/** A job's open conversation: when it started (which names it) and its latest alert, in epoch ms. */
export type JobThread = { startedAt: number; lastAt: number }

/**
 * How long a central job's conversation stays open with no alert. A resolved
 * email can end it sooner (central's sync and calendar jobs send one), but a
 * central job that crashes outright never sends one. An instance's jobs need
 * no window: a run that does its work, or finds the job switched off, ends
 * their conversation (api/src/lib/alertThread.ts).
 */
export const ALERT_THREAD_QUIET_MS = 3 * 24 * 3_600_000

/** The conversation an alert sent at `now` joins: the open one until it has gone `quietMs` without an alert, else a new one. */
export function nextJobThread(open: JobThread | null, now: number, quietMs: number = ALERT_THREAD_QUIET_MS): JobThread {
  return open && now - open.lastAt < quietMs
    ? { startedAt: open.startedAt, lastAt: Math.max(open.lastAt, now) }
    : { startedAt: now, lastAt: now }
}

// A FILETIME counts 100-nanosecond steps from 1601-01-01. This is 1970-01-01 in those steps.
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n

export async function alertThreadHeaders(t: AlertThread): Promise<Record<string, string>> {
  // The root's id-left part must be dot-atom text, so anything else in the key
  // becomes an underscore, and so does a dot that would start, end, or double one.
  const key = t.key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.|\.(?=\.)|\.$/g, '_')
  const root = `<alert.${key}.${t.startedAt.toString(36)}@${t.domain}>`
  return { 'In-Reply-To': root, 'References': root, 'Thread-Topic': t.topic, 'Thread-Index': await threadIndex(root, t.startedAt) }
}

/**
 * An Outlook conversation index's 22-byte header block, base64: the first six
 * bytes of the start time as a big-endian FILETIME, then a GUID, here the first
 * 16 bytes of the root's SHA-256. Exchange keys the conversation on the GUID,
 * so every email of one conversation carries the same value. The block's
 * first byte is reserved as 0x01, which a FILETIME's top byte is until 2057.
 */
async function threadIndex(root: string, startedAt: number): Promise<string> {
  const filetime = new Uint8Array(8)
  new DataView(filetime.buffer).setBigUint64(0, BigInt(Math.trunc(startedAt)) * 10_000n + FILETIME_AT_UNIX_EPOCH)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(root)))
  const block = new Uint8Array(22)
  block.set(filetime.subarray(0, 6))
  block.set(digest.subarray(0, 16), 6)
  return btoa(String.fromCharCode(...block))
}
