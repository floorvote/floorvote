import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'

// Lives here rather than in NotificationsSlideOver because the context now owns
// the data. The panel imports it back; the reverse would be a cycle.
export type Mention = {
  id: string
  commentId: string
  billId: string
  billNumber: string
  billTitle: string
  billState: string | null
  sessionSlug: string | null
  authorName: string
  authorSubtitle: string | null
  commentPreview: string
  commentHtml: string
  sourceType: 'user' | 'role' | 'everyone'
  sourceLabel: string | null
  createdAt: string
  isUnread: boolean
}

type NotificationsContextType = {
  unreadCount: number
  mentions: Mention[]
  /** False until the first fetch settles. Distinguishes "no mentions" from
   *  "not asked yet", which is the only case the panel still shows a spinner for. */
  loaded: boolean
  refresh: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextType>({
  unreadCount: 0,
  mentions: [],
  loaded: false,
  refresh: async () => {},
})

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0)
  const [mentions, setMentions] = useState<Mention[]>([])
  const [loaded, setLoaded] = useState(false)

  // GET /notifications returns the badge count and the rows together. Keeping both
  // is what lets the panel open without a request of its own — this poll is already
  // paid for, and the panel used to refetch exactly this payload on every open.
  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ unreadCount: number; mentions: Mention[] }>('/notifications')
      setUnreadCount(data.unreadCount)
      setMentions(data.mentions)
    } catch {}
    // Set even on failure, so a tenant with a flaky /notifications shows the empty
    // state rather than spinning forever.
    setLoaded(true)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Poll every 30 s so the badge updates without a navigation or page reload
  useEffect(() => {
    const id = setInterval(() => { void refresh() }, 30_000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <NotificationsContext value={{ unreadCount, mentions, loaded, refresh }}>
      {children}
    </NotificationsContext>
  )
}

export function useNotifications() {
  return useContext(NotificationsContext)
}
