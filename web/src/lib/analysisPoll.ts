// One poll loop for both admin-triggered AI runs on the bill detail page
// (promote-then-analyze, and re-generate). Previously each had its own copy,
// and they disagreed on when to stop — the re-generate copy could only ever
// end in a timeout when AI never started, which read as "too slow" when the
// real cause was "no bill text to analyze".
export type AnalysisOutcome = 'analyzed' | 'no_texts' | 'skipped' | 'timeout'

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
  const timeoutMs = opts.timeoutMs ?? 3 * 60 * 1000
  const baselineSkipReason = opts.baselineSkipReason ?? null
  let elapsed = 0

  return new Promise<AnalysisOutcome>((resolve) => {
    const tick = async () => {
      elapsed += intervalMs
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
      if (elapsed >= timeoutMs) { resolve('timeout'); return }
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

// Copy for an AI run that ended without producing analysis. Returning null for
// the happy path keeps the call site a single assignment.
export function analysisOutcomeMessage(outcome: AnalysisOutcome): string | null {
  switch (outcome) {
    case 'analyzed':
      return null
    case 'no_texts':
      return "There's no published bill text yet, so AI had nothing to analyze. Analysis will run automatically once text is available."
    case 'skipped':
      return "AI couldn't analyze this bill's text. The full document is still available via the source link."
    case 'timeout':
      return 'AI has not finished after 3 minutes. Try refreshing the page shortly.'
  }
}
