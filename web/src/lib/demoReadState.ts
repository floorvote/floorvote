// Per-browser mention read state, for demo tenants only.
//
// The database cannot carry this on a demo. Every visitor is auto-logged in as
// the same `demo-user` row (api/src/index.ts), so one person's reading clears
// the badge for everybody after them; and the reset cron (0 0,6,12,18) wipes
// comment_mentions.read_at four times a day, so the badge re-lights on its own.
//
// Mention ids survive that reset unchanged — demoReset.ts re-inserts the seed's
// literal ids (lm-m-1, lm-m-8, …) verbatim — which is what makes a local set
// still match afterwards. For this one case localStorage is not a workaround,
// it is the better store.
//
// That id stability is also the catch. Because the ids never change, a browser
// that recorded them once matched them forever, so a laptop used for one demo
// showed those mentions read on every later demo — even though the reset had
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
const KEY = 'floorvote:demo:readMentions'

type Stored = { epoch: string; ids: string[] }

/**
 * Mention ids this browser has already seen *within the current reset epoch*.
 * Empty if storage is unavailable, if nothing is stored, or if what is stored
 * belongs to an earlier epoch.
 *
 * `epoch` undefined means /config has not answered yet, or this tenant has
 * never been reset. Both resolve to "no local read state": treating an unknown
 * epoch as a match would let a pre-reset set leak into the new demo, which is
 * the bug this scoping exists to fix.
 */
export function readMentionIds(epoch: string | undefined): Set<string> {
  if (!epoch) return new Set()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set()
    const stored = parsed as Partial<Stored>
    if (stored.epoch !== epoch || !Array.isArray(stored.ids)) return new Set()
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
 * mention unread, *and* this browser has to have no local record of it.
 *
 * Both halves are needed. Dropping `isUnread` would count a mention the server
 * already marked read on some earlier visit that this browser never recorded;
 * dropping `alreadyRead` would re-light everything the reset cron touches.
 *
 * Exported so the badge (context/NotificationsContext.tsx) and the panel's blue
 * rails (components/NotificationsSlideOver.tsx) share one definition rather than
 * two that have to be kept in agreement by hand — they were written separately
 * once and disagreed.
 */
export function isUnreadForDemo(
  mention: { id: string; isUnread: boolean },
  alreadyRead: Set<string>,
): boolean {
  return mention.isUnread && !alreadyRead.has(mention.id)
}

/**
 * Union `ids` into the stored set for this epoch. No-ops if storage is
 * unavailable or the epoch is unknown — writing under an unknown epoch would
 * create a record that the next read cannot safely match.
 */
export function markMentionsRead(ids: string[], epoch: string | undefined): void {
  if (ids.length === 0 || !epoch) return
  try {
    // readMentionIds already returns empty for a stale epoch, so this overwrites
    // rather than merges whenever the epoch has moved on.
    const next = readMentionIds(epoch)
    for (const id of ids) next.add(id)
    const stored: Stored = { epoch, ids: [...next] }
    localStorage.setItem(KEY, JSON.stringify(stored))
  } catch {}
}
