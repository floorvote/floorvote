import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLoaderData, useRevalidator, type LoaderFunctionArgs } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { apiFetchForLoader } from '../lib/loaderFetch'
import { createProgressBox, type ProgressBox } from '../lib/retryFetch'
import { LoadingState } from '../components/LoadingState'
import type { FeedEvent } from '../lib/feedUtils'
import { GroupedBillCard } from '../components/GroupedBillCard'
import { groupEventsByBillAndDay, filterPriorityEvents, filterFullyAnalyzed } from '../lib/feedUtils'
import type { GroupedBillEvents } from '../lib/feedUtils'
import { eventDateLabel } from '../lib/calendarDate'
import { usePolling } from '../hooks/usePolling'
import { usePageTitle } from '../hooks/usePageTitle'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { DateDivider } from '../components/ui/DateDivider'
import { ScopeSelect, type ScopeSelectOption } from '../components/ui/ScopeSelect'
import { useFeedUnread } from '../context/FeedUnreadContext'
import { useAuth } from '../hooks/useAuth'
import { getScrollContainer } from '../lib/scrollUtils'

type FeedResponse = { events: FeedEvent[]; total: number; page: number; limit: number }

const LIMIT = 40
// One scroll-to-bottom should add a real batch of cards, not a sliver. Because a
// page of LIMIT raw events collapses (grouping) and is culled (default-scope
// filter) into an unpredictable, often tiny, number of visible cards, we keep
// pulling pages until this many NEW visible cards have been added (or the feed
// ends). MAX_FILL_FETCHES bounds the per-scroll latency on a heavily-filtered
// feed; the sentinel re-fires to continue if the target isn't reached.
const FILL_TARGET = 15
// First screen fills to this many visible cards so it's a full batch, not the
// thin slice a single page yields after filtering. Slightly above FILL_TARGET so
// the opening view never feels smaller than a subsequent scroll's worth.
const INITIAL_TARGET = 20
const MAX_FILL_FETCHES = 10

/** Unblock the router if the first page hasn't landed by here. Comfortably above
 *  a healthy load (40-70ms server-side) and below the threshold of noticing. */
const UNBLOCK_AT_MS = 400

export type FeedLoaderResult =
  | { data: FeedResponse }
  | { pending: Promise<FeedResponse>; progress: ProgressBox; abort: () => void }

// Route loader: fetch the first page before the feed renders (RR7 data router),
// but only block the router for UNBLOCK_AT_MS. Fast path returns resolved data
// so the first frame paints with content; slow path hands FeedPane the pending
// promise so the shell can come up with a spinner in the feed column.
//
// Cancellation has two owners, and it needs both. retryFetch retries
// indefinitely until it succeeds or its signal aborts, so any loop nobody stops
// runs forever, holding visibilitychange/online listeners:
//
//   - `request.signal` is RR7's. It fires when a loader run never gets to
//     commit — an interrupted navigation, or a revalidation superseded by a
//     newer one. Those runs have no component to clean them up, so without this
//     mashing "Retry now" leaks a loop per discarded run. RR7 does NOT fire it
//     after a run commits successfully, which is why it is not sufficient alone.
//   - `abort` is the committed run's handle, for the mirror case: FeedPane owns
//     the lifetime once mounted and calls it on unmount, so navigating away
//     mid-outage doesn't leave the loop behind.
export function feedLoader({ request }: Pick<LoaderFunctionArgs, 'request'>): Promise<FeedLoaderResult> {
  const progress = createProgressBox()
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, request.signal])
  const pending = apiFetchForLoader<FeedResponse>(
    `/feed?page=1&limit=${LIMIT}&scope=default`,
    { progress, signal },
  )
  let unblockTimer: ReturnType<typeof setTimeout> | undefined
  return Promise.race<FeedLoaderResult>([
    pending.then((data) => ({ data })),
    new Promise<FeedLoaderResult>((resolve) => {
      unblockTimer = setTimeout(
        () => resolve({ pending, progress, abort: () => controller.abort() }),
        UNBLOCK_AT_MS,
      )
    }),
    // Clear the loser: on the fast path the timer would otherwise sit armed for
    // the rest of its 400ms, once per navigation, resolving a settled race.
  ]).finally(() => clearTimeout(unblockTimer))
}

/**
 * Route element for the index route. Owns the loader result so `Feed` itself
 * stays a pure "render this data" component.
 *
 * Deliberately not Suspense/<Await>: Suspense gives exactly one fallback with
 * no way to express "attempt 3, retrying in 8s".
 */
export function FeedPane() {
  const result = useLoaderData() as FeedLoaderResult | null
  const revalidator = useRevalidator()
  const resolved = result && 'data' in result ? result.data : null
  const waiting = result && 'pending' in result ? result : null

  // Deliberately not seeded from `resolved` via useState's initializer: a
  // revalidation can replace a pending result with a resolved one, and state
  // initialized once at mount would never see it — the retry would succeed and
  // still render an empty feed. `resolved` wins whenever the loader has it.
  //
  // The mirror case is a revalidation that replaces *resolved* data with a
  // pending one: `resolved` goes null with `fetched` still null, so the feed is
  // swapped for LoadingState — which shows nothing at all for its first 500ms.
  // Unreachable today (nothing revalidates this route except the Retry now
  // button below, which only exists while there is no data), so it is left
  // alone rather than papered over with a "keep the last good data" cache that
  // no caller would exercise. Anything that adds a revalidation trigger here —
  // a fetcher, a route action, a poll — has to revisit this.
  const [fetched, setFetched] = useState<FeedResponse | null>(null)
  const [error, setError] = useState<unknown>(null)
  const data = resolved ?? fetched

  // Holds a scheduled abort between an effect teardown and a possible immediate
  // re-subscribe. Refs survive StrictMode's remount, which is the whole point.
  const deferredAbort = useRef<{ waiting: object; timer: ReturnType<typeof setTimeout> } | null>(null)

  useEffect(() => {
    if (!waiting) return
    // Re-subscribing to the very loop we just scheduled an abort for: this is
    // StrictMode's mount/cleanup/remount, so call the abort off.
    if (deferredAbort.current?.waiting === waiting) {
      clearTimeout(deferredAbort.current.timer)
      deferredAbort.current = null
    }
    let cancelled = false
    waiting.pending.then(
      (d) => { if (!cancelled) setFetched(d) },
      (e) => { if (!cancelled) setError(e) },
    )
    // abort() as well as the `cancelled` flag: the flag stops us setting state
    // after unmount, but only abort() stops retryFetch's loop, which otherwise
    // retries forever with nobody listening.
    //
    // Deferred by a tick rather than called here, because under StrictMode
    // (main.tsx wraps the app in it) React runs this teardown and then re-runs
    // the effect synchronously with the same `waiting`. Aborting inline would
    // kill a loop we are about to resubscribe to: the fetch rejects AbortError,
    // the new subscription sets it, render rethrows, and dev gets "Something
    // went wrong" on exactly the slow path this feature exists to make
    // graceful. A real unmount never re-subscribes, so the timer fires and the
    // loop dies as intended. Keyed by `waiting` so a *superseded* result — new
    // identity — is still aborted rather than cancelled by its replacement.
    return () => {
      cancelled = true
      deferredAbort.current = {
        waiting,
        timer: setTimeout(() => { deferredAbort.current = null; waiting.abort() }, 0),
      }
    }
  }, [waiting])

  // Rethrow during render so the route's errorElement handles it, exactly as a
  // loader rejection would have.
  if (error) throw error
  if (!data && waiting) {
    // revalidate() re-runs feedLoader, which restarts the race from scratch —
    // lighter and faster than a full page reload.
    return <LoadingState variant="bare" progress={waiting.progress} onRetryNow={() => revalidator.revalidate()} />
  }
  return <Feed preloaded={data} />
}

type ScopeMode = 'default' | 'analyzed'

const SCOPE_OPTIONS: ScopeSelectOption<ScopeMode>[] = [
  { value: 'default',  label: 'Default feed',            description: 'Prioritized bills and other bills with member activity' },
  { value: 'analyzed', label: 'All fully analyzed bills', description: 'All bills that match your keywords or have been manually added' },
]


export function Feed({ preloaded }: { preloaded: FeedResponse | null }) {
  usePageTitle('Feed')
  const [events, setEvents] = useState<FeedEvent[]>(preloaded?.events ?? [])
  const [total, setTotal] = useState(preloaded?.total ?? 0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(!preloaded)
  const [error, setError] = useState<string | null>(null)
  const [scopeMode, setScopeMode] = useState<ScopeMode>('default')
  const scopeRef = useRef(scopeMode)
  useEffect(() => { scopeRef.current = scopeMode }, [scopeMode])
  const [hasNewActivity, setHasNewActivity] = useState(false)
  const skipFirstFetch = useRef(!!preloaded)
  const topEventIdRef = useRef<string | null>(preloaded?.events[0]?.id ?? null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const { markSeen, endVisit, lastSeenFeed, initialized } = useFeedUnread()
  const { user } = useAuth()
  // Mirror the accumulating state into refs so the auto-fill loop reads the
  // latest values without being recreated on every append.
  const eventsRef = useRef(events)
  const pageRef = useRef(page)
  const totalRef = useRef(total)
  const fillingRef = useRef(false)
  useEffect(() => { eventsRef.current = events }, [events])
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { totalRef.current = total }, [total])
  const seenAtRef = useRef<string | null>(null)
  const seenAtSnapped = useRef(false)
  const headerRef = useRef<HTMLDivElement>(null)
  const [headerHeight, setHeaderHeight] = useState(0)

  // Measure the sticky header so the day dividers can pin flush beneath it.
  useLayoutEffect(() => {
    const measure = () => setHeaderHeight(headerRef.current?.offsetHeight ?? 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Count how many cards are actually visible under the current scope, after the
  // same grouping + filtering the render applies. Pagination is driven by this,
  // not by raw event count — otherwise a page of mostly-filtered events nets one
  // sliver of content and the scroll stutters.
  const visibleCount = useCallback((evs: FeedEvent[]) => {
    const fn = scopeMode === 'analyzed' ? filterFullyAnalyzed : filterPriorityEvents
    return fn(groupEventsByBillAndDay(evs)).length
  }, [scopeMode])

  // Low-level paginator: from the given seed events/page/total, keep appending
  // pages until `stop(evs)` holds, the feed is exhausted, or MAX_FILL_FETCHES is
  // hit. Seeds are passed explicitly (not read from refs) so it can run on the
  // first page before React has flushed that state into the refs.
  const pumpPages = useCallback(async (
    seedEvents: FeedEvent[], seedPage: number, seedTotal: number,
    stop: (evs: FeedEvent[]) => boolean,
  ) => {
    let evs = seedEvents, pg = seedPage, tot = seedTotal, fetches = 0
    while (evs.length < tot && !stop(evs) && fetches < MAX_FILL_FETCHES) {
      const next = pg + 1
      const data = await apiFetch<FeedResponse>(`/feed?page=${next}&limit=${LIMIT}&scope=${scopeRef.current}`)
      evs = [...evs, ...data.events]; pg = next; tot = data.total; fetches++
      setEvents(evs); setPage(pg); setTotal(tot)
    }
  }, [])

  // Initial load fills to INITIAL_TARGET visible cards so the first screen is a
  // full batch — not the thin slice a single page yields after filtering.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      if (skipFirstFetch.current) {
        // Seeded from a prefetch: page 1 already painted. Top it up only if it's
        // below target — otherwise we'd flash a needless loading state.
        skipFirstFetch.current = false
        if (eventsRef.current.length >= totalRef.current ||
            visibleCount(eventsRef.current) >= INITIAL_TARGET) return
        fillingRef.current = true; setLoading(true)
        try {
          await pumpPages(eventsRef.current, pageRef.current, totalRef.current,
            (evs) => visibleCount(evs) >= INITIAL_TARGET)
        } catch { if (!cancelled) setError('Failed to load feed.') }
        finally { fillingRef.current = false; setLoading(false) }
        return
      }
      fillingRef.current = true; setLoading(true)
      try {
        const data = await apiFetch<FeedResponse>(`/feed?page=1&limit=${LIMIT}&scope=${scopeRef.current}`)
        if (cancelled) return
        setEvents(data.events); setPage(1); setTotal(data.total)
        topEventIdRef.current = data.events[0]?.id ?? null
        await pumpPages(data.events, 1, data.total,
          (evs) => visibleCount(evs) >= INITIAL_TARGET)
      } catch { if (!cancelled) setError('Failed to load feed.') }
      finally { fillingRef.current = false; setLoading(false) }
    }
    run()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch from page 1 when scope changes (skip the initial mount).
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    let cancelled = false
    const run = async () => {
      fillingRef.current = true; setLoading(true); setError(null)
      try {
        const data = await apiFetch<FeedResponse>(`/feed?page=1&limit=${LIMIT}&scope=${scopeMode}`)
        if (cancelled) return
        setEvents(data.events); setPage(1); setTotal(data.total)
        topEventIdRef.current = data.events[0]?.id ?? null
        await pumpPages(data.events, 1, data.total,
          (evs) => visibleCount(evs) >= INITIAL_TARGET)
      } catch { if (!cancelled) setError('Failed to load feed.') }
      finally { fillingRef.current = false; setLoading(false) }
    }
    run()
    return () => { cancelled = true }
  }, [scopeMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll handler: pull pages until FILL_TARGET new visible cards are added or
  // the feed is exhausted. Self-serializing via fillingRef so overlapping
  // sentinel hits and re-renders can't double-fetch.
  const loadMore = useCallback(async () => {
    if (fillingRef.current) return
    if (eventsRef.current.length >= totalRef.current) return
    fillingRef.current = true
    setLoading(true)
    try {
      const base = visibleCount(eventsRef.current)
      await pumpPages(eventsRef.current, pageRef.current, totalRef.current,
        (evs) => visibleCount(evs) - base >= FILL_TARGET)
    } catch {
      setError('Failed to load feed.')
    } finally {
      fillingRef.current = false
      setLoading(false)
    }
  }, [pumpPages, visibleCount])
  const loadMoreRef = useRef(loadMore)
  useEffect(() => { loadMoreRef.current = loadMore }, [loadMore])

  const loadLatest = useCallback(async () => {
    const data = await apiFetch<FeedResponse>(`/feed?page=1&limit=${LIMIT}&scope=${scopeRef.current}`)
    setEvents(data.events)
    setPage(1)
    setTotal(data.total)
    topEventIdRef.current = data.events[0]?.id ?? null
    setHasNewActivity(false)
  }, [])

  const pollFeed = useCallback(async () => {
    const data = await apiFetch<FeedResponse>(`/feed?page=1&limit=${LIMIT}&scope=${scopeRef.current}`)
    const newTopId = data.events[0]?.id ?? null
    if (newTopId && newTopId !== topEventIdRef.current) {
      // New activity detected — auto-load silently if near top, else show banner
      if (window.scrollY < 150) {
        setEvents(data.events)
        setPage(1)
        setTotal(data.total)
        topEventIdRef.current = newTopId
        setHasNewActivity(false)
      } else {
        setHasNewActivity(true)
      }
    } else {
      setHasNewActivity(false)
    }
  }, [])

  usePolling(pollFeed, 20_000)

  // Snapshot lastSeenFeed once FeedUnreadContext has seeded it from the user,
  // then mark the feed as seen (clears nav dot, seenAtRef stays frozen for this visit).
  useEffect(() => {
    if (!initialized || seenAtSnapped.current) return
    seenAtSnapped.current = true
    seenAtRef.current = lastSeenFeed
    markSeen()
  }, [initialized]) // eslint-disable-line react-hooks/exhaustive-deps

  // End the visit when leaving Feed. The provider stays mounted across routes
  // (AppLayout is reused), so it can't reset visit state on its own — Feed must
  // signal its own unmount, otherwise the nav dot lingers until a full reload.
  useEffect(() => endVisit, [endVisit])

  // The app's scroll container is <main class="app-main">, not the window, and it
  // PERSISTS across navigation (AppLayout is one shared layout). So arriving at
  // Feed from a page that left it scrolled (e.g. Calendar pins today) would show
  // Feed scrolled down. Reset to the top on mount so Feed always opens at the top.
  useLayoutEffect(() => { getScrollContainer().scrollTop = 0 }, [])

  async function handleNewActivityClick() {
    await loadLatest()
    getScrollContainer().scrollTo({ top: 0, behavior: 'smooth' })
  }

  // The sentinel just signals "near the bottom" — loadMore self-guards and pulls
  // a full batch. A generous rootMargin prefetches well before the user lands at
  // the end, and routing through loadMoreRef keeps this observer from being torn
  // down and rebuilt on every append.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMoreRef.current() },
      { root: getScrollContainer(), rootMargin: '1200px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  const scopeFn = scopeMode === 'analyzed' ? filterFullyAnalyzed : filterPriorityEvents
  const groups = scopeFn(groupEventsByBillAndDay(events))

  // Group cards by day for separators
  const groupsByDay = new Map<string, GroupedBillEvents[]>()
  for (const g of groups) {
    if (!groupsByDay.has(g.date)) groupsByDay.set(g.date, [])
    groupsByDay.get(g.date)!.push(g)
  }
  const sortedDays = Array.from(groupsByDay.keys()).sort((a, b) => b.localeCompare(a))

  return (
    <div style={{ background: color.surfaceMuted, minHeight: '100vh' }}>
      <div
        ref={headerRef}
        style={{ position: 'sticky', top: 0, zIndex: 10, background: color.surfaceMuted }}
      >
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '24px 20px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h1 style={{ fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: color.textPrimary, margin: 0 }}>Feed</h1>
            <ScopeSelect options={SCOPE_OPTIONS} value={scopeMode} onChange={setScopeMode} defaultValue="default" />
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 680, margin: '0 auto', padding: '12px 20px 0' }}>

        {error && <p style={{ color: color.textErrorRed, fontSize: fontSize.base }}>{error}</p>}
        {hasNewActivity && (
          <button
            onClick={handleNewActivityClick}
            style={{
              display: 'block',
              width: '100%',
              marginBottom: 12,
              padding: '10px 0',
              background: color.linkBlue,
              color: color.white,
              border: 'none',
              borderRadius: radius.lg,
              fontSize: fontSize.sm,
              fontWeight: fontWeight.semibold,
              cursor: 'pointer',
              letterSpacing: '0.02em',
            }}
          >
            New activity — tap to refresh
          </button>
        )}


        {sortedDays.map((day) => (
          <div key={day}>
            <DateDivider {...eventDateLabel(day)} stickyTop={headerHeight} />
            {groupsByDay.get(day)!.map(group => (
              <GroupedBillCard key={group.key} group={group} seenAt={seenAtRef.current} currentUserId={user?.id ?? null} />
            ))}
          </div>
        ))}

        {!loading && groups.length === 0 && (
          <p style={{ color: color.textMuted, fontSize: fontSize.base, textAlign: 'center', marginTop: 40 }}>No activity yet.</p>
        )}
        <div ref={sentinelRef} style={{ height: 1 }} />
        {loading && <p style={{ color: color.textMuted, fontSize: fontSize.base, textAlign: 'center', marginTop: 8 }}>Loading…</p>}
      </div>
    </div>
  )
}
