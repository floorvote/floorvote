// One poll loop for both admin-triggered AI runs on the bill detail page
// (promote-then-analyze, and re-generate). Previously each had its own copy,
// and they disagreed on when to stop — the re-generate copy could only ever
// end in a timeout when AI never started, which read as "too slow" when the
// real cause was "no bill text to analyze".
export type AnalysisOutcome = 'analyzed' | 'no_texts' | 'skipped' | 'timeout' | 'moved'

// Shared so pollForAnalysis and analysisOutcomeMessage cannot disagree about
// how long a run was actually given before it was called a timeout.
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 3 * 60 * 1000

export type AnalysisSnapshot = {
  aiProcessedAt: string | null
  aiSkipReason: string | null
  textStatus: string | null
  analysisBillId?: string | null
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
  // The bill being re-analyzed, when the page may show another bill's analysis
  // (a companion group's, #554). The poll reads the page's detail, whose
  // analysis fields belong to whichever bill the page shows. If that is no
  // longer this bill (the group split, or another member now matches), a new
  // analysis time is some other bill's and says nothing about this run, so the
  // poll ends as 'moved' instead of misreading it or timing out.
  expectedBillId?: string
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
          // Before every other check: they all read the shown bill's fields.
          if (opts.expectedBillId != null && snap.analysisBillId != null && snap.analysisBillId !== opts.expectedBillId) {
            resolve('moved')
            return
          }
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
    case 'moved':
      return "This bill's group changed while the re-analysis ran, so this page now shows a different bill's summary."
  }
}

// Copy for a re-generate, which re-analyzes the bill whose analysis the page
// shows: this page's own bill, or on a companion group's page another bill
// (#563). When it's another bill, every outcome names it, so an admin who
// clicked on one bill's page knows which bill was re-analyzed. A run on this
// page's own bill reads as it always has.
export function regenerateOutcomeMessage(
  outcome: AnalysisOutcome,
  target: { billNumber: string | null; other: boolean },
  timeoutMs: number = DEFAULT_ANALYSIS_TIMEOUT_MS,
): string | null {
  if (!target.other) return analysisOutcomeMessage(outcome, timeoutMs)
  const named = target.billNumber ? `${target.billNumber}, the bill this page's summary comes from` : "the bill this page's summary comes from"
  switch (outcome) {
    case 'analyzed':
      return `Re-analyzed ${named}.`
    case 'no_texts':
      return `${capitalize(named)}, has no published bill text yet, so AI had nothing to analyze. Analysis will run automatically once text is available.`
    case 'skipped':
      return `AI couldn't analyze the text of ${named}. The full document is still available from that bill's page.`
    case 'timeout':
      return `AI has not finished re-analyzing ${named} after ${formatWait(timeoutMs)}. Try refreshing the page shortly.`
    case 'moved':
      return `This bill's group changed while ${target.billNumber ?? 'the bill'} was being re-analyzed, so this page now shows a different bill's summary.`
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
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
