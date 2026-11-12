import { useEffect, useMemo, useRef } from 'react'
import { ApiError } from '../../lib/api'

// D1 answers an overloaded database with a 503 and the seconds to wait. The Bills page and the split-pane list beside a
// bill both say so and ask again once after that interval; a second failure is reported as any other. This holds the
// parts they share: the delay an error asks for, a request-sequence guard so a request that is no longer the newest
// neither shows nor arms a retry over the newer one, and the one timer, cleared by a new request and on unmount.

/** The wait a 503 asked for, in milliseconds; null for any other error, or a 503 that names no interval. */
export function overloadDelayMs(err: unknown): number | null {
  return err instanceof ApiError && err.status === 503 && err.retryAfterMs != null ? err.retryAfterMs : null
}

export function useOverloadRetry() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  // The functions are stable, so a callback built on them is not rebuilt.
  return useMemo(() => {
    const clear = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
    const isCurrent = (seq: number) => seq === seqRef.current
    return {
      /** Begins a request: cancels any pending retry and returns the request's number. */
      start: (): number => { clear(); return ++seqRef.current },
      isCurrent,
      clear,
      /** Runs `run` once after `ms`, if `seq` is still the newest request by then. A request that is no longer the newest arms nothing. */
      schedule: (seq: number, ms: number, run: () => void): void => {
        if (!isCurrent(seq)) return
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          if (isCurrent(seq)) run()
        }, ms)
      },
    }
  }, [])
}
