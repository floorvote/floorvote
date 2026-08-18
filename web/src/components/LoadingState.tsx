import { useEffect, useState } from 'react'
import { Spinner } from './Spinner'
import { Wordmark } from './Wordmark'
import { color, fontSize, radius, fontWeight } from '../styles/tokens'
import type { ProgressBox } from '../lib/retryFetch'

/**
 * The shared loading escalation. `retryFetch` owns the timing and writes into
 * the ProgressBox; this owns the words.
 *
 *   0-500ms   nothing        (a 60ms load must never flash a spinner)
 *   0.5-10s   spinner only   (a spinner already says "loading"; a caption adds nothing)
 *   10s+      + "Taking longer than usual..."
 *   retry     + "Can't reach the server." / "Retrying in Ns..." and a Retry now button
 *
 * Variant rule: the wordmark appears only when the app shell is not there.
 * `full` is a splash (HydrateFallback, RequireAuth); `bare` sits inside
 * AppLayout, where the sidebar is already showing the wordmark.
 */

const TICK_MS = 250

/**
 * Every threshold below is compared against a clock that only advances on the
 * tick, so each is effectively rounded up to the next multiple of TICK_MS.
 * Keep them multiples of it — otherwise the constant stops describing when the
 * tier actually appears (400 here would have meant a spinner at 500ms).
 */
const SPINNER_AT_MS = 500
/**
 * Equal to `REQUEST_DEADLINE_MS` by design: a request that has not answered by
 * now is one retryFetch is about to abort. So on a retry-driven mount this tier
 * is visible for at most a tick before the retry copy replaces it — it earns
 * its keep on the other two paths, a slow-but-successful response and a
 * HydrateFallback mount with no request of its own in flight.
 */
const SLOW_AT_MS = 10_000
/** Spinner freezes under prefers-reduced-motion, so tier one has no cue at all. */
const SLOW_AT_REDUCED_MS = 1_000

/**
 * Read in the render body on purpose, rather than subscribed to with
 * `useSyncExternalStore`: the 250ms tick re-renders anyway, so an OS-level
 * change to the setting self-corrects within one tick. A subscription would buy
 * a quarter second of latency at the cost of a listener.
 */
function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
}

export function LoadingState({
  variant = 'full',
  progress,
  onRetryNow,
}: {
  variant?: 'full' | 'bare'
  progress: ProgressBox
  onRetryNow?: () => void
}) {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Deliberately NOT paused while the tab is hidden, unlike retryFetch's
    // backoff wait — don't "fix" the inconsistency. That pause exists to stop a
    // fleet of background tabs retrying in lockstep; it throttles *network*
    // load. This timer only advances a clock, so pausing it would save nothing
    // and cost correctness: the tab would come back showing a countdown frozen
    // at whatever it last read. Browsers already clamp hidden-tab intervals to
    // ~1s, which is all the throttling a clock needs.
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const retry = progress.current
  const elapsed = now - startedAt

  // After the hooks, never before them — the tier this returns from changes on
  // every tick, so a hook below here would mount and unmount mid-load.
  //
  // The `!retry` half is for remounts: a parent that re-mounts this while a
  // retry is already in flight resets `startedAt`, and blanking the screen for
  // half a second when we already know the server is unreachable is a step
  // backwards. The blank gate is only there to keep a fast load from flashing.
  if (elapsed < SPINNER_AT_MS && !retry) return null

  const slowAt = prefersReducedMotion() ? SLOW_AT_REDUCED_MS : SLOW_AT_MS
  // null when nothing is scheduled; non-positive once nextRetryAt is in the
  // past, which `detail` reads as "the attempt is running now" — so no separate
  // clamp at zero. Deliberately not 0 for the no-retry case: one value standing
  // for both "none pending" and "overdue" reads fine right up until someone
  // adds a third branch.
  const secondsToRetry = retry ? Math.ceil((retry.nextRetryAt - now) / 1000) : null

  // The live region gets a complete, stable sentence and nothing else. Anything
  // that changes second to second goes in `detail`, outside it: a number inside
  // a live region announces on every tick, and splitting the number out of
  // "Retrying in N" would leave the region announcing a dangling fragment.
  const live = retry
    ? "Can't reach the server."
    : elapsed >= slowAt
      ? 'Taking longer than usual…'
      : null

  // retryFetch leaves the box set while the next attempt is in flight — on
  // purpose, so the countdown doesn't vanish for the attempt's whole 10s
  // deadline — which means `nextRetryAt` spends most of a stall in the past.
  // Holding at "0s…" for ten seconds at a time reads as hung, the exact
  // impression this component exists to remove, so drop the number instead.
  const detail = secondsToRetry === null
    ? null
    : secondsToRetry > 0
      ? `Retrying in ${secondsToRetry}s…`
      : 'Retrying…'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', position: 'relative',
      // Not 100vh: this variant renders outside .app-layout, and 100vh
      // overshoots the visual viewport on mobile (the dynamic URL bar), which
      // makes the document itself scroll. See styles/mobile.css.
      minHeight: variant === 'full' ? '100dvh' : 240,
      padding: 32, gap: 18,
    }}>
      <Spinner size={variant === 'full' ? 56 : 40} />
      {variant === 'full' && <Wordmark size={fontSize.xxxl} />}
      {/*
        Mounted from the spinner tier onwards, empty, rather than appearing with
        its first message already inside it: a live region inserted into the DOM
        together with its text is unreliably announced. It has to be there first
        and gain content later.

        Out of flow while empty — the same node, only `position` changes, which
        is not an insertion, so that guarantee holds — because an absolutely
        positioned child is not a flex item and so cannot claim an 18px `gap`
        under the wordmark for a row with nothing in it.
      */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        position: live ? undefined : 'absolute',
        fontSize: fontSize.sm, color: color.textMuted,
      }}>
        <span aria-live="polite">{live}</span>
        {detail && <span aria-hidden="true">{detail}</span>}
      </div>
      {retry && onRetryNow && (
        <button
          type="button"
          onClick={onRetryNow}
          style={{
            padding: '6px 16px', background: color.white, color: color.linkBlue,
            border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
            fontSize: fontSize.sm, fontWeight: fontWeight.semibold, cursor: 'pointer',
          }}
        >
          Retry now
        </button>
      )}
    </div>
  )
}
