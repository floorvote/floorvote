// Per-browser notification read state, for demo tenants only.
//
// The database cannot carry this on a demo. Every visitor is auto-logged in as
// the same `demo-user` row (api/src/index.ts), so one person's reading clears
// the badge for everybody after them; and the reset cron (0 0,6,12,18) wipes
// notifications.read_at four times a day, so the badge re-lights on its own.
//
// Notification ids survive that reset unchanged — demoReset.ts re-inserts the seed's
// literal ids (lm-m-1, lm-m-8, …) verbatim — which is what makes a local set
// still match afterwards. For this one case localStorage is not a workaround,
// it is the better store.
//
// That id stability is also the catch. Because the ids never change, a browser
// that recorded them once matched them forever, so a laptop used for one demo
// showed those notifications read on every later demo — even though the reset had
// re-lit them server-side. Read state is therefore scoped to a reset epoch:
// `demo_reset_at`, stamped by runDemoReset and surfaced through GET /config as
// `demoResetAt`. A stored set from an earlier epoch is discarded wholesale
// rather than merged, so each reset genuinely starts the demo over.
//
// The epoch is opaque — only ever compared for equality. Nothing here parses it
// as a date or depends on the cron's schedule, so changing the reset cadence
// needs no change on this side.
//
// Every non-demo tenant keeps the server path. Gate on useDemo().demoMode.
// The key predates the notifications inbox. Kept as is so browsers keep their
// read state across the rename.
const KEY = 'floorvote:demo:readMentions'

// Stands in for the epoch on a tenant that has not been reset since
// demo_reset_at shipped, so read state still works there.
//
// A plain word is enough: a real epoch is always the ISO timestamp written by
// runDemoReset, so no real value can equal this one. An earlier version prefixed
// a NUL to "guarantee" that, which guaranteed nothing extra and made git treat
// this file as binary — no diff, no blame, no reviewable history — for an
// invisible character.
//
// The first version refused to read OR write without a real epoch, reasoning
// that treating unknown as a match would leak a pre-reset set into a new demo.
// The read half was right and the write half was not: refusing to write means
// read state can never be recorded at all, so the badge sticks on its seeded
// notifications permanently and no amount of opening the panel clears it. That is
// not a rare edge either — every demo tenant is in this state from the moment
// the code deploys until its next reset, up to six hours later.
//
// A sentinel avoids both failures. Before the first reset, read state behaves
// exactly as it did before epochs existed. At the first reset the epoch becomes
// a timestamp, which differs from the sentinel, so the stored set is discarded
// and the notifications re-light — which is the whole point. Nothing leaks, because
// what clears the set is the epoch *changing*, not its particular value.
const UNSTAMPED = 'unstamped'

type Stored = { epoch: string; ids: string[] }

/**
 * Notification ids this browser has already seen *within the current reset epoch*.
 * Empty if storage is unavailable, if nothing is stored, or if what is stored
 * belongs to an earlier epoch.
 *
 * `epoch` undefined means /config has not answered yet, or this tenant has not
 * been reset since demo_reset_at shipped; both fall back to the sentinel above
 * rather than to "no read state".
 */
export function readNotificationIds(epoch: string | undefined): Set<string> {
  const key = epoch ?? UNSTAMPED
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set()
    const stored = parsed as Partial<Stored>
    if (stored.epoch !== key || !Array.isArray(stored.ids)) return new Set()
    return new Set(stored.ids.filter((x): x is string => typeof x === 'string'))
  } catch {
    // Safari private mode and disabled-storage profiles throw on access rather
    // than returning null. Failing open to "nothing read" costs a lit badge; a
    // throw here would take out the notifications panel.
    return new Set()
  }
}

/**
 * The one unread rule for demo tenants: the server still has to call the
 * notification unread, *and* this browser has to have no local record of it.
 *
 * Both halves are needed. Dropping `isUnread` would count a notification the server
 * already marked read on some earlier visit that this browser never recorded;
 * dropping `alreadyRead` would re-light everything the reset cron touches.
 *
 * Exported so the badge (context/NotificationsContext.tsx) and the panel's blue
 * rails (components/NotificationsSlideOver.tsx) share one definition rather than
 * two that have to be kept in agreement by hand — they were written separately
 * once and disagreed.
 */
export function isUnreadForDemo(
  notification: { id: string; isUnread: boolean },
  alreadyRead: Set<string>,
): boolean {
  return notification.isUnread && !alreadyRead.has(notification.id)
}

/**
 * Union `ids` into the stored set for this epoch. No-ops only if there is
 * nothing to record or storage is unavailable — an unknown epoch writes under
 * the sentinel rather than dropping the write, or the badge could never be
 * cleared at all.
 */
export function markNotificationsRead(ids: string[], epoch: string | undefined): void {
  if (ids.length === 0) return
  const key = epoch ?? UNSTAMPED
  try {
    // readNotificationIds already returns empty for a stale epoch, so this overwrites
    // rather than merges whenever the epoch has moved on.
    const next = readNotificationIds(key)
    for (const id of ids) next.add(id)
    const stored: Stored = { epoch: key, ids: [...next] }
    localStorage.setItem(KEY, JSON.stringify(stored))
  } catch {}
}
