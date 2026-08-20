// One poll loop for both admin-triggered AI runs on the bill detail page
// (promote-then-analyze, and re-generate). Previously each had its own copy,
// and they disagreed on when to stop — the re-generate copy could only ever
// end in a timeout when AI never started, which read as "too slow" when the
// real cause was "no bill text to analyze".
export type AnalysisOutcome = 'analyzed' | 'no_texts' | 'skipped' | 'timeout'

// Shared so pollForAnalysis and analysisOutcomeMessage cannot disagree about
// how long a run was actually given before it was called a timeout.
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 3 * 60 * 1000

export type AnalysisSnapshot = {
  aiProcessedAt: string | null
  aiSkipReason: string | null
  textStatus: string | null
}

export function pollForAnalysis(opts: {
  fetchSnapshot: () => Promise<AnalysisSnapshot | null>
  baselineProcessedAt: string | null
  // A bill that was analyzed and then hit a permanent skip on newer text keeps
  // its analysis AND carries a non-null aiSkipReason. Without a baseline, a
  // re-generate on such a bill resolves 'skipped' on the first tick and blames
  // the text before the queued run has had any chance to finish. Defaults to
  // null, where any non-null reason is new — the original behavior.
  baselineSkipReason?: string | null
  intervalMs?: number
  timeoutMs?: number
}): Promise<AnalysisOutcome> {
  const intervalMs = opts.intervalMs ?? 5000
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS
  const baselineSkipReason = opts.baselineSkipReason ?? null
  // Measure real elapsed time rather than accumulating intervalMs: each tick
  // also spends the fetch's latency, and a backgrounded tab throttles the
  // timer, so counting intervals would undercount by an unbounded amount and
  // make the timeout copy's stated wait a lie.
  const startedAt = Date.now()

  return new Promise<AnalysisOutcome>((resolve) => {
    const tick = async () => {
      try {
        const snap = await opts.fetchSnapshot()
        if (snap) {
          // Compare against the baseline rather than checking truthiness: a
          // re-generate starts from an already-analyzed bill, so "has a value"
          // is true before the run even begins.
          if (snap.aiProcessedAt != null && snap.aiProcessedAt !== opts.baselineProcessedAt) {
            resolve('analyzed')
            return
          }
          if (snap.textStatus === 'no_texts') { resolve('no_texts'); return }
          if (snap.aiSkipReason && snap.aiSkipReason !== baselineSkipReason) { resolve('skipped'); return }
        }
      } catch {
        // Swallow and retry: a dropped poll shouldn't end the run.
      }
      if (Date.now() - startedAt >= timeoutMs) { resolve('timeout'); return }
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

// Copy for an AI run that ended without producing analysis. Returning null for
// the happy path keeps the call site a single assignment.
//
// `timeoutMs` must match whatever the caller passed to pollForAnalysis; it
// defaults to the same value pollForAnalysis defaults to, so the common call
// site stays a one-argument call and still reads "3 minutes".
export function analysisOutcomeMessage(
  outcome: AnalysisOutcome,
  timeoutMs: number = DEFAULT_ANALYSIS_TIMEOUT_MS,
): string | null {
  switch (outcome) {
    case 'analyzed':
      return null
    case 'no_texts':
      return "There's no published bill text yet, so AI had nothing to analyze. Analysis will run automatically once text is available."
    case 'skipped':
      return "AI couldn't analyze this bill's text. The full document is still available via the source link."
    case 'timeout':
      return `AI has not finished after ${formatWait(timeoutMs)}. Try refreshing the page shortly.`
  }
}

// Seconds below a minute, whole minutes for exact multiples, and
// "minutes + seconds" for anything in between. Rounding to the nearest minute
// would report a custom 100s timeout as "2 minutes", which is a longer wait
// than the run was ever given — the copy has to be honest for whatever
// timeoutMs the caller actually passed, not just the 3-minute default.
function formatWait(timeoutMs: number): string {
  const totalSeconds = Math.max(1, Math.round(timeoutMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const minutePart = `${minutes} minute${minutes === 1 ? '' : 's'}`
  const secondPart = `${seconds} second${seconds === 1 ? '' : 's'}`
  if (minutes === 0) return secondPart
  if (seconds === 0) return minutePart
  return `${minutePart} ${secondPart}`
}
