import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'
import { useAuth } from '../hooks/useAuth'
import { feedTsToEpoch } from '../lib/time'

type FeedPollResponse = { latestEventAt: string | null; lastSeenFeed: string | null }

type FeedUnreadState = {
  hasUnread: boolean
  visitHadUnread: boolean  // true for the duration of a Feed visit if unreads existed on arrival
  latestEventAt: string | null
  lastSeenFeed: string | null
  initialized: boolean   // true once lastSeenFeed has been seeded from user
  markSeen: () => Promise<string | null>
  endVisit: () => void   // call when leaving the Feed page to clear the lingering dot
}

const FeedUnreadContext = createContext<FeedUnreadState>({
  hasUnread: false,
  visitHadUnread: false,
  latestEventAt: null,
  lastSeenFeed: null,
  initialized: false,
  markSeen: async () => null,
  endVisit: () => {},
})

export function FeedUnreadProvider({ children }: { children: ReactNode }) {
  const { user, setLastSeenFeed: setAuthLastSeenFeed } = useAuth()
  const [latestEventAt, setLatestEventAt] = useState<string | null>(null)
  const [lastSeenFeed, setLastSeenFeed] = useState<string | null>(null)
  // Mirrors lastSeenFeed so the [user]-scoped poll closure can compare against
  // the freshest baseline without re-subscribing on every seen update.
  const lastSeenFeedRef = useRef<string | null>(null)
  // Stable handle to the auth setter (which is a fresh reference each render) so
  // the [user]-scoped poll effect can advance the auth baseline without listing
  // it as a dep — otherwise the 20s interval would reset on every render.
  const setAuthLastSeenFeedRef = useRef(setAuthLastSeenFeed)
  setAuthLastSeenFeedRef.current = setAuthLastSeenFeed
  const [initialized, setInitialized] = useState(false)
  const initializedRef = useRef(false)
  // undefined = markSeen hasn't fired this visit; null/string = lastSeenFeed at markSeen call time
  const [visitSeenAt, setVisitSeenAt] = useState<string | null | undefined>(undefined)

  // Keep state and the poll-facing ref in lockstep on every baseline write.
  function applyLastSeen(ts: string | null) {
    lastSeenFeedRef.current = ts
    setLastSeenFeed(ts)
  }

  // Seed lastSeenFeed from user once auth resolves.
  // Note: React runs child effects before parent effects. Feed.tsx (a child) would
  // snapshot seenAtRef before this effect runs if it used a plain mount effect.
  // The `initialized` flag lets Feed.tsx wait for this effect to complete first.
  useEffect(() => {
    if (user && !initializedRef.current) {
      initializedRef.current = true
      applyLastSeen(user.lastSeenFeed)
      setInitialized(true)
    }
  }, [user])

  // Poll for latestEventAt every 20s when logged in
  useEffect(() => {
    if (!user) return
    let cancelled = false

    async function poll() {
      try {
        const data = await apiFetch<FeedPollResponse>('/feed?page=1&limit=1')
        if (cancelled) return
        setLatestEventAt(data.latestEventAt)
        // Adopt the server's seen baseline if it's newer than ours, so a window
        // that read Feed elsewhere clears this window's dot within ~20s. Advance
        // forward only — never regress past an optimistic local markSeen() that
        // hasn't round-tripped (and absorbs client/server clock skew).
        const serverSeen = data.lastSeenFeed
        const localSeen = lastSeenFeedRef.current
        if (serverSeen != null && (localSeen === null || feedTsToEpoch(serverSeen) > feedTsToEpoch(localSeen))) {
          applyLastSeen(serverSeen)
          setAuthLastSeenFeedRef.current(serverSeen)
        }
      } catch {
        // swallow poll errors silently
      }
    }

    poll()
    const id = setInterval(poll, 20_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [user])

  const hasUnread =
    latestEventAt !== null &&
    (lastSeenFeed === null || feedTsToEpoch(latestEventAt) > feedTsToEpoch(lastSeenFeed))

  // True for the duration of a Feed page visit if there were unreads when we arrived.
  // visitSeenAt is the lastSeenFeed snapshot captured at markSeen() call time; it stays
  // frozen so the dot lingers while item-level blue dots are still showing, then is reset
  // to undefined by endVisit() when the Feed page unmounts on navigation.
  // NOTE: the provider itself does NOT remount per route — AppLayout is reused across
  // routes (only `children` change), so we cannot rely on a remount to reset this.
  const visitHadUnread =
    visitSeenAt !== undefined &&
    latestEventAt !== null &&
    (visitSeenAt === null || feedTsToEpoch(latestEventAt) > feedTsToEpoch(visitSeenAt))

  // Called from the Feed page's unmount cleanup. Ends the current visit so the lingering
  // nav dot clears on navigation away from Feed (the provider stays mounted across routes).
  // Stable identity (setState is stable) so Feed can use it as an unmount-only cleanup
  // without the cleanup re-firing on every provider re-render.
  const endVisit = useCallback(() => {
    setVisitSeenAt(undefined)
  }, [])

  async function markSeen(): Promise<string | null> {
    const snapshot = lastSeenFeed
    if (visitSeenAt === undefined) setVisitSeenAt(lastSeenFeed)
    try {
      await apiFetch('/feed/seen', { method: 'POST' })
    } catch {
      // best-effort; don't block the UI
    }
    const now = new Date().toISOString()
    applyLastSeen(now)
    // Also advance the auth-level baseline so a provider remount (AppLayout is
    // re-instantiated per route) re-seeds from this value instead of the stale
    // app-load lastSeenFeed — otherwise the nav dot relights on every navigation.
    setAuthLastSeenFeed(now)
    return snapshot
  }

  return (
    <FeedUnreadContext value={{ hasUnread, visitHadUnread, latestEventAt, lastSeenFeed, initialized, markSeen, endVisit }}>
      {children}
    </FeedUnreadContext>
  )
}

export function useFeedUnread(): FeedUnreadState {
  return useContext(FeedUnreadContext)
}
