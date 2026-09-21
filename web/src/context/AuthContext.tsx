import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError } from '../lib/api'
import { TERMS_NOT_ACCEPTED_EVENT } from '../lib/appEvents'
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
  /** True while the Legal Terms must be accepted before the app is usable. */
  termsAcceptanceRequired: boolean
  /** Which copy the acceptance interstitial shows. */
  termsAcceptanceKind: 'first_login' | 'existing_member' | 'update'
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
  setTermsAccepted: () => void
}

const AuthContext = createContext<AuthState>({
  user: null, loading: true, authError: false, authProgress: { current: null },
  setSubtitle: () => {}, setName: () => {}, setEmailDigestEnabled: () => {}, setLastSeenFeed: () => {},
  setTermsAccepted: () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState(false)
  // Lazy initializer, so the box identity is stable for the component's whole
  // life — the effect below depends on it and must not re-run, and RequireAuth
  // reads `.current` off this same cell on its own render tick.
  const [authProgress] = useState(createProgressBox)
  // Bumped whenever this component learns something locally that a /auth/me
  // response in flight cannot know about yet. See recheck() below.
  const epoch = useRef(0)

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

  // A tab left open when LEGAL_TERMS_UPDATED is bumped starts getting 403s from
  // every route. api.ts announces the first one, and re-reading /auth/me flips
  // termsAcceptanceRequired so RequireAuth puts the interstitial up instead of
  // letting the failure surface as a generic error.
  //
  // /auth/me is safe to call here: it reads the session cookie itself rather
  // than mounting requireAuth, so it answers 200 while the gate is refusing
  // everything else -- no loop.
  useEffect(() => {
    function recheck() {
      // Discard a response that was already in flight when the user accepted.
      //
      // The 403 that raises the interstitial is also what triggers this
      // recheck, so the two race: the request goes out while acceptance is
      // still outstanding, answers `termsAcceptanceRequired: true`, and lands
      // after the POST has cleared the flag -- resurrecting the gate under
      // someone who just agreed. Ignoring any response older than the last
      // local change keeps the newer truth.
      const issuedAt = epoch.current
      retryFetch<User>('/auth/me')
        .then((u) => { if (epoch.current === issuedAt) setUser(u) })
        .catch(() => { /* leave the existing state alone; the next request re-announces */ })
    }
    window.addEventListener(TERMS_NOT_ACCEPTED_EVENT, recheck)
    return () => window.removeEventListener(TERMS_NOT_ACCEPTED_EVENT, recheck)
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

  // Accepting flips the flag in context rather than reloading: /auth/me is
  // fetched once at app load, so a reload would be the only other way to clear
  // the interstitial, and it would throw away wherever the user was headed.
  function setTermsAccepted() {
    epoch.current += 1
    setUser((prev) => prev ? { ...prev, termsAcceptanceRequired: false } : prev)
  }

  return <AuthContext value={{ user, loading, authError, authProgress, setSubtitle, setName, setEmailDigestEnabled, setLastSeenFeed, setTermsAccepted }}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  return useContext(AuthContext)
}
