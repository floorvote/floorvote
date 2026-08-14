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
// Every non-demo tenant keeps the server path. Gate on useDemo().demoMode.
const KEY = 'floorvote:demo:readMentions'

/** Mention ids this browser has already seen. Empty if storage is unavailable. */
export function readMentionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
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

/** Union `ids` into the stored set. No-ops if storage is unavailable. */
export function markMentionsRead(ids: string[]): void {
  if (ids.length === 0) return
  try {
    const next = readMentionIds()
    for (const id of ids) next.add(id)
    localStorage.setItem(KEY, JSON.stringify([...next]))
  } catch {}
}
