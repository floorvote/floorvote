export const REGENERATE_PRESERVES_DESCRIPTION =
  'Replaces the summary, tags, and relevance score. Comments, votes, priority, positions, and notes are untouched.'

type MatchType = 'keyword' | 'manual' | null
type TextStatus = 'in_r2' | 'available' | 'no_texts' | 'not_checked' | null
type AiSkipReason = 'pdf_too_large' | null

// Message shown in the "no AI summary yet" box on the bill detail page.
// Branches by whether the bill is monitoring-only (matchType=null) vs fully tracked,
// whether LegiScan has confirmed there's no published text, and whether AI
// permanently failed on the existing text.
//
// Honest about what monitoring-only bills actually get refreshed: only what masterlist
// returns (title/status/last_action). Sponsors and full action history are not.
export function getNoAnalysisMessage(args: {
  matchType: MatchType
  textStatus: TextStatus
  aiSkipReason?: AiSkipReason
}): string {
  const isLightweight = args.matchType === null
  const noTexts = args.textStatus === 'no_texts'

  // Permanent AI failures take priority: text exists but couldn't be analyzed.
  // The bill detail page still shows the underlying text link, so the user has recourse.
  if (args.aiSkipReason === 'pdf_too_large') {
    return "This bill's full text exceeds the length our AI provider can process. The full document is available via the source link below."
  }

  if (isLightweight) {
    if (noTexts) {
      return "This bill doesn't match your keywords, so it isn't being fully analyzed. Status and the latest action are kept current. No bill text published yet."
    }
    return "This bill doesn't match your keywords, so it isn't being fully analyzed. Status and the latest action are kept current. Sponsors, full action history, and bill text are not."
  }

  // Tracked bill (keyword/manual) with text confirmed present but no AI output.
  // Normally transient (AI runs automatically right after text arrives); persistent
  // only when a path set match_type without queueing AI. State the fact only — the
  // action is the adjacent admin "Run analysis" button. (We deliberately don't say
  // "runs automatically": by the time someone reads this it usually hasn't, and
  // pairing that with a run-now button reads as paradoxical.)
  const textConfirmed = args.textStatus === 'in_r2' || args.textStatus === 'available'
  if (textConfirmed) {
    return "This bill's text is available but hasn't been analyzed yet."
  }

  return 'No published bill text yet — analysis will run automatically when text becomes available.'
}
