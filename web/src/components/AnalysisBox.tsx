import type React from 'react'
import { color, fontSize } from '../styles/tokens'

// The single striped shell for an admin-triggered AI run on the bill detail
// page — used both by the "enable full analysis" empty state and by the AI
// summary section during a re-generate. It exists as one component so two
// progress boxes can never render at once, which is exactly what used to
// happen when re-generate was offered on a bill with nothing to re-generate.
//
// `hatched` = show the stripe layer even at rest. True only for the promote
// box: its at-rest state is an empty state, where the hatch reads as
// "unanalyzed territory". Hatching populated content would make a finished
// summary look pending, so the AI summary section leaves it off and gets the
// stripes only while a run is in flight.
export function AnalysisBox({ running, hatched = false, error, children }: {
  running: boolean
  hatched?: boolean
  error?: string | null
  children: React.ReactNode
}) {
  const showStripes = running || hatched
  return (
    <div
      className="analyzing-box"
      style={{
        background: showStripes ? color.white : color.surfaceSubtle,
        border: `1px solid ${color.borderDefault}`,
      }}
    >
      {showStripes && (
        <div className={`analyzing-box__stripes${running ? ' analyzing-box__stripes--animated' : ''}`} />
      )}
      <div className="analyzing-box__content">
        {children}
        {error && (
          <div role="alert" style={{ fontSize: fontSize.sm, color: color.textDanger, marginTop: 8 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

// The progress affordance for both runs. Placement is the caller's choice —
// beside the AI summary heading for a re-generate, beside the button for a
// promote — so the chip is a sibling of AnalysisBox rather than a slot in it,
// and it deliberately sits outside whatever the caller dims.
export function AnalysisProgressChip({ label }: { label: string }) {
  return (
    <span className="ai-progress-label" role="status">
      <span className="material-symbols-outlined ai-progress-label__icon" aria-hidden="true">autorenew</span>
      {label}
    </span>
  )
}

// Stale content stays visible but recedes while a run is in flight. Shared so
// the two boxes cannot drift to different values.
export const DIMMED_WHILE_RUNNING: React.CSSProperties = { opacity: 0.4 }
