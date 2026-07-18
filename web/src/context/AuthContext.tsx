import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch, ApiError } from '../lib/api'

type User = {
  id: string
  email: string
  name: string
  role: 'admin' | 'member' | 'owner'
  subtitle: string | null
  canVote: boolean
  emailDigestEnabled: boolean
  emailWeekAheadEnabled: boolean
  lastSeenFeed: string | null
  isLastOwner: boolean
}

type AuthState = {
  user: User | null
  loading: boolean
  authError: boolean
  setSubtitle: (subtitle: string | null) => void
  setName: (name: string) => void
  setEmailDigestEnabled: (enabled: boolean) => void
  setLastSeenFeed: (ts: string) => void
}

const AuthContext = createContext<AuthState>({ user: null, loading: true, authError: false, setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {} })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)

  useEffect(() => {
    apiFetch<User>('/auth/me')
      .then((u) => { setUser(u); setLoading(false) })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          setUser(null)
        } else {
          // Non-401 error (e.g. network failure, 500) — don't treat as logged-out
          setAuthError(true)
        }
        setLoading(false)
      })
  }, [])

  function setSubtitle(subtitle: string | null) {
    setUser((prev) => prev ? { ...prev, subtitle } : prev)
  }

  function setName(name: string) {
    setUser((prev) => prev ? { ...prev, name } : prev)
  }

  function setEmailDigestEnabled(enabled: boolean) {
    setUser((prev) => prev ? { ...prev, emailDigestEnabled: enabled } : prev)
  }

  // Keep the in-memory lastSeenFeed in sync after marking the feed seen.
  // /auth/me is fetched once at app load; FeedUnreadProvider seeds its baseline
  // from user.lastSeenFeed when it first mounts (e.g. a fresh window/tab or reload).
  // Without this, a fresh mount would re-seed from the stale app-load value and
  // relight the Feed dot.
  function setLastSeenFeed(ts: string) {
    setUser((prev) => prev ? { ...prev, lastSeenFeed: ts } : prev)
  }

  return <AuthContext value={{ user, loading, authError, setSubtitle, setName, setEmailDigestEnabled, setLastSeenFeed }}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  return useContext(AuthContext)
}
