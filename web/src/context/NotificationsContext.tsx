import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'
import { useDemo } from './DemoContext'
import { isUnreadForDemo, readNotificationIds } from '../lib/demoReadState'

// Lives here rather than in NotificationsSlideOver because the context now owns
// the data. The panel imports it back; the reverse would be a cycle.
//
// GET /notifications returns one row per notification, discriminated on `kind`
// (api/src/lib/notifications.ts). Mentions, replies, and reactions so far. A new
// kind adds a member to the NotificationItem union and a renderer in the panel.
type NotificationBase = {
  id: string
  commentId: string
  billId: string
  billNumber: string
  billTitle: string
  billState: string | null
  /** Required, not optional: GET /notifications is the only producer of this
   *  shape, so an optional field would let a dropped select column read as
   *  "filed" — a silent solid badge — instead of failing to typecheck. */
  billIsDraft: boolean
  sessionSlug: string | null
  commentPreview: string
  commentHtml: string
  createdAt: string
  isUnread: boolean
}

/** Mentions and replies are someone else's comment, so they name its author. */
type AuthoredNotification = NotificationBase & {
  authorName: string
  authorTitle: string | null
}

export type MentionNotification = AuthoredNotification & {
  kind: 'mention'
  sourceType: 'user' | 'role' | 'everyone'
  sourceLabel: string | null
}

/** Someone else commented on a bill the member has commented on. */
export type ReplyNotification = AuthoredNotification & {
  kind: 'reply'
}

/**
 * Someone reacted to the member's own comment. The server collapses a comment's
 * reactions into this one row, whose `id` stays the same as reactions arrive.
 * `isUnread` is true if any is. The comment shown is the member's.
 */
export type ReactionNotification = NotificationBase & {
  kind: 'reaction'
  /** The newest reactors (up to two), each once. */
  reactors: Array<{ id: string; name: string | null }>
  reactorCount: number
}

export type NotificationItem = MentionNotification | ReplyNotification | ReactionNotification

type NotificationsContextType = {
  unreadCount: number
  notifications: NotificationItem[]
  /** False until the first fetch settles. Distinguishes "no notifications" from
   *  "not asked yet", which is the only case the panel still shows a spinner for. */
  loaded: boolean
  /** Refetches, and hands back the rows it just stored. The return value exists
   *  for callers that must act on the fresh list in the same turn — reading
   *  `notifications` after awaiting this would still see the pre-refresh render's
   *  array. Empty on a failed fetch, which every caller treats as "nothing new". */
  refresh: () => Promise<NotificationItem[]>
}

const NotificationsContext = createContext<NotificationsContextType>({
  unreadCount: 0,
  notifications: [],
  loaded: false,
  refresh: async () => [],
})

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [loaded, setLoaded] = useState(false)

  // GET /notifications returns the badge count and the rows together. Keeping both
  // is what lets the panel open without a request of its own — this poll is already
  // paid for, and the panel used to refetch exactly this payload on every open.
  const refresh = useCallback(async () => {
    let fresh: NotificationItem[] = []
    try {
      const data = await apiFetch<{ unreadCount: number; notifications: NotificationItem[] }>('/notifications')
      setUnreadCount(data.unreadCount)
      // The server always sends `notifications` alongside `unreadCount` (api/src/lib/
      // notifications.ts), but effectiveUnread below now calls .filter on this
      // during the provider's own render — a malformed 200 with no `notifications`
      // would otherwise white-screen the whole app rather than just degrade the badge.
      fresh = data.notifications ?? []
      setNotifications(fresh)
    } catch {}
    // Set even on failure, so a tenant with a flaky /notifications shows the empty
    // state rather than spinning forever.
    setLoaded(true)
    return fresh
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Poll every 30 s so the badge updates without a navigation or page reload
  useEffect(() => {
    const id = setInterval(() => { void refresh() }, 30_000)
    return () => clearInterval(id)
  }, [refresh])

  const { demoMode, demoResetAt, settled: demoSettled } = useDemo()

  // Which rule applies depends on /config, which routinely resolves AFTER
  // /notifications — so until the gate settles we hold at zero rather than
  // guessing. Guessing meant trusting the server's count, and on a demo that
  // count is the full unread set (nothing ever POSTs mark-read there), so a
  // visitor who had already read everything got a red badge for the length of
  // one /config round trip and then watched it vanish.
  //
  // Costs a real tenant the gap between its two boot requests, which both fire
  // at mount — the badge is briefly low rather than briefly wrong, and zero is
  // what it renders as before either lands anyway.
  let effectiveUnread = 0
  if (demoSettled && demoMode) {
    // On a demo the server's unreadCount is not usable — see lib/demoReadState.ts.
    // Recomputed from the rows we already hold, through the same isUnreadForDemo
    // predicate the panel paints its blue rails with, so the bell's number is
    // exactly the number of rails the panel would draw.
    //
    // readNotificationIds() is hoisted out of the filter callback: it round-trips
    // through localStorage.getItem + JSON.parse, so calling it once per render
    // instead of once per notification matters once the list is not tiny.
    const alreadyRead = readNotificationIds(demoResetAt)
    effectiveUnread = notifications.filter(n => isUnreadForDemo(n, alreadyRead)).length
  } else if (demoSettled) {
    effectiveUnread = unreadCount
  }

  return (
    <NotificationsContext value={{ unreadCount: effectiveUnread, notifications, loaded, refresh }}>
      {children}
    </NotificationsContext>
  )
}

export function useNotifications() {
  return useContext(NotificationsContext)
}
