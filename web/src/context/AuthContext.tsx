import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ApiError } from '../lib/api'
import { retryFetch, createProgressBox, type ProgressBox } from '../lib/retryFetch'

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
  /** Retry progress for the in-flight /auth/me, read by RequireAuth's LoadingState. */
  authProgress: ProgressBox
  setSubtitle: (subtitle: string | null) => void
  setName: (name: string) => void
  setEmailDigestEnabled: (enabled: boolean) => void
  setLastSeenFeed: (ts: string) => void
}

const AuthContext = createContext<AuthState>({
  user: null, loading: true, authError: false, authProgress: { current: null },
  setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)
  // Lazy initializer, so the box identity is stable for the component's whole
  // life — the effect below depends on it and must not re-run, and RequireAuth
  // reads `.current` off this same cell on its own render tick.
  const [authProgress] = useState(createProgressBox)

  useEffect(() => {
    const controller = new AbortController()
    retryFetch<User>('/auth/me', { progress: authProgress, signal: controller.signal })
      .then((u) => { setUser(u); setLoading(false) })
      .catch((err) => {
        // Unmount (StrictMode's double-invoke included) — not a real failure.
        if (controller.signal.aborted) return
        if (err instanceof ApiError && err.status === 401) {
          setUser(null)
        } else {
          // Non-401, non-retryable (retryFetch keeps retrying 5xx and stalls
          // on its own, so reaching here means a definitive answer).
          setAuthError(true)
        }
        setLoading(false)
      })
    return () => controller.abort()
  }, [authProgress])

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

  return <AuthContext value={{ user, loading, authError, authProgress, setSubtitle, setName, setEmailDigestEnabled, setLastSeenFeed }}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  return useContext(AuthContext)
}
