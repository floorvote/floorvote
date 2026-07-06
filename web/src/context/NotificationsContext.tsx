import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'

type NotificationsContextType = {
  unreadCount: number
  refresh: () => Promise<void>
}

const NotificationsContext = createContext<NotificationsContextType>({
  unreadCount: 0,
  refresh: async () => {},
})

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [unreadCount, setUnreadCount] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const data = await apiFetch<{ unreadCount: number }>('/notifications')
      setUnreadCount(data.unreadCount)
    } catch {}
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Poll every 30 s so the badge updates without a navigation or page reload
  useEffect(() => {
    const id = setInterval(() => { void refresh() }, 30_000)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <NotificationsContext value={{ unreadCount, refresh }}>
      {children}
    </NotificationsContext>
  )
}

export function useNotifications() {
  return useContext(NotificationsContext)
}
