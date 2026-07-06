import { useCallback, useEffect, useRef } from 'react'

export function usePolling(
  fetchFn: () => Promise<void>,
  intervalMs: number,
): { forceRefresh: () => void } {
  const fnRef = useRef(fetchFn)
  useEffect(() => { fnRef.current = fetchFn }, [fetchFn])

  const inFlight = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hiddenAt = useRef<number | null>(null)

  const runFetch = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try { await fnRef.current() } catch { /* silently swallow */ }
    finally { inFlight.current = false }
  }, [])

  const startTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => { void runFetch() }, intervalMs)
  }, [runFetch, intervalMs])

  const forceRefresh = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    void runFetch()
    timerRef.current = setInterval(() => { void runFetch() }, intervalMs)
  }, [runFetch, intervalMs])

  useEffect(() => {
    startTimer()

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now()
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
      } else {
        const elapsed = hiddenAt.current != null ? Date.now() - hiddenAt.current : Infinity
        if (elapsed >= intervalMs) void runFetch()
        startTimer()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [startTimer, runFetch, intervalMs])

  return { forceRefresh }
}
