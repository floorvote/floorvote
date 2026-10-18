import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, ApiError } from '../../lib/api'
import { useBodyEventsName, useHasBodyEvents } from '../../lib/capabilities'
import { useDemo } from '../../context/DemoContext'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { computeEventPopoverPosition, type EventPopoverPosition } from './EventPopover'
import { EMPTY_EVENT_RULES, hasLegacyParts, legacyNote, legacyParts, withCommittee, withoutLegacyParts, type EventRules } from '../../../../shared/eventRules'

interface Committee { committeeId: string; name: string; state: string | null }
interface Loaded { rules: EventRules | null; committees: Committee[]; optionsError: string | null }

/** "All", or how many committees are chosen. */
function choiceLabel(rules: EventRules | null): string {
  if (!rules) return 'All'
  const n = rules.committees.length
  return n === 0 ? 'No committees' : n === 1 ? '1 committee' : `${n} committees`
}

/**
 * The Calendar page's one control for which committee events show (#420),
 * for an instance whose covered state's provider publishes its own calendar:
 * "Council events: All". Its menu has two choices, every event or only chosen
 * committees, and each change saves as it is made through the event-rules API.
 * An event with a prioritized bill always shows. A rule saved earlier with
 * kinds, event types, topics, tracked bills, or a committee narrowed to a kind
 * keeps working and shows as one line with Remove (shared/eventRules.ts).
 *
 * Only admins can change the rules, so the page offers it to them alone.
 */
export function BodyEventsControl({ onChanged }: { onChanged?: () => void }) {
  const hasBodyEvents = useHasBodyEvents()
  const body = useBodyEventsName()
  const { demoLocked } = useDemo()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [rules, setRulesState] = useState<EventRules | null>(null)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [pos, setPos] = useState<EventPopoverPosition | null>(null)
  const panelRef = useRef<PopPanelHandle>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // The latest choice, so quick clicks build on each other, and what the server last confirmed, so a failed save can revert.
  const rulesRef = useRef<EventRules | null>(null)
  const confirmedRef = useRef<EventRules | null>(null)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  // Each commit's order, and the run of saves a failure cancels (bumped on every failure).
  const seqRef = useRef(0)
  const epochRef = useRef(0)
  /** The last rules "All events" cleared, for switching back to "Only these committees". */
  const stashedRef = useRef<EventRules | null>(null)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const setRules = useCallback((next: EventRules | null) => { rulesRef.current = next; setRulesState(next) }, [])

  useEffect(() => {
    if (!hasBodyEvents) return
    let cancelled = false
    apiFetch<Loaded>('/admin/event-rules')
      .then(d => {
        if (cancelled) return
        confirmedRef.current = d.rules
        setRules(d.rules)
        setLoaded(d)
      })
      .catch(() => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [hasBodyEvents, setRules])

  if (!hasBodyEvents) return null

  /**
   * Show the choice at once and save it, one save after another so they land
   * in the order made. A failed save reverts to what the server last took and
   * drops the saves queued behind it: they were built on a state the server
   * never accepted, so sending them would leave it holding rules the screen
   * does not show.
   */
  function commit(next: EventRules | null) {
    // "All events" is undoable in the session: keep the rules it clears.
    if (next === null && rulesRef.current) stashedRef.current = rulesRef.current
    const seq = ++seqRef.current
    const epoch = epochRef.current
    setRules(next)
    setMessage(null)
    queueRef.current = queueRef.current.then(async () => {
      if (epoch !== epochRef.current) return
      try {
        await apiFetch('/admin/event-rules', { method: 'PUT', body: JSON.stringify({ rules: next }) })
        confirmedRef.current = next
        // The newest save is the one on screen; an older one landing later must not replace it.
        if (seq === seqRef.current) { setRules(next); setMessage({ text: 'Saved.' }) }
        onChangedRef.current?.()
      } catch (e) {
        epochRef.current++
        setRules(confirmedRef.current)
        setMessage({ text: e instanceof ApiError ? e.message : 'Could not save. Try again.', error: true })
      }
    })
    return queueRef.current
  }

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect(8, 80, 0, 0)
    setPos(computeEventPopoverPosition(rect, { width: 320, align: 'right' }))
  }

  function toggleMenu() {
    if (pos) { panelRef.current?.close(); return }
    openMenu()
  }

  const parts = legacyParts(rules)
  const kept = hasLegacyParts(parts)
  const committees = loaded?.committees ?? []
  const multiState = new Set(committees.map(c => c.state).filter(Boolean)).size > 1
  const chosen = new Set((rules?.committees ?? []).map(c => c.committeeId))
  const ready = !!loaded && !loadFailed

  const trigger: React.CSSProperties = {
    background: color.white, color: color.textSlate, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
    padding: '9px 14px', borderRadius: radius.md, border: `1px solid ${color.borderDefault}`, cursor: ready ? 'pointer' : 'default',
    fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
  }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: fontSize.sm, color: color.textSlate, padding: '4px 0' }
  const small: React.CSSProperties = { fontSize: fontSize.xs, color: color.textSecondary, lineHeight: 1.5, margin: 0 }
  const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, fontSize: fontSize.xs, cursor: demoLocked ? 'default' : 'pointer', fontFamily: 'inherit' }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={ready ? toggleMenu : undefined}
        disabled={!ready}
        aria-haspopup="dialog"
        aria-expanded={!!pos}
        title={loadFailed ? `Could not load which ${body} events show.` : undefined}
        style={trigger}
      >
        <span>{ready ? `${body} events: ${choiceLabel(rules)}` : `${body} events`}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d={pos ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {pos && ready && (
        <PopPanel
          ref={panelRef}
          onClose={() => setPos(null)}
          triggerRef={triggerRef}
          ariaLabel={`${body} events`}
          transformOrigin={pos.transformOrigin}
          enterOffsetY={pos.enterOffsetY}
          positionStyle={pos.positionStyle}
        >
          <div ref={menuRef} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
            <div role="radiogroup" aria-label={`Which ${body} events show`}>
              <label style={row}>
                <input type="radio" name="body-events-choice" checked={!rules} disabled={demoLocked}
                  onChange={() => { if (rules) void commit(null) }} />
                All events
              </label>
              <label style={row}>
                <input type="radio" name="body-events-choice" checked={!!rules} disabled={demoLocked}
                  onChange={() => { if (!rules) void commit(stashedRef.current ?? EMPTY_EVENT_RULES) }} />
                Only these committees
              </label>
            </div>

            {rules && (
              <fieldset style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
                <legend style={{ ...small, fontWeight: fontWeight.medium, marginBottom: 2 }}>Committees</legend>
                {committees.length === 0 && <p style={small}>No committees are listed yet.</p>}
                {committees.map(c => (
                  <label key={c.committeeId} style={row}>
                    <input type="checkbox" checked={chosen.has(c.committeeId)} disabled={demoLocked}
                      onChange={e => void commit(withCommittee(rulesRef.current, c, e.target.checked))} />
                    {multiState && c.state ? `${c.name} (${c.state})` : c.name}
                  </label>
                ))}
              </fieldset>
            )}

            {rules && kept && (
              <p style={{ ...small, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span>{legacyNote(parts)}</span>
                <button type="button" className="blue-link" style={linkButton} disabled={demoLocked}
                  onClick={() => {
                    void commit(withoutLegacyParts(rulesRef.current ?? EMPTY_EVENT_RULES)).then(() => {
                      // Remove leaves the menu, so keep the keyboard's place in it.
                      if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.querySelector<HTMLElement>('input:checked')?.focus()
                    })
                  }}>Remove</button>
              </p>
            )}

            <p style={small}>Events with a prioritized bill always show up on the calendar.</p>
            {loaded?.optionsError && <p style={{ ...small, color: color.textAmberDark }}>{loaded.optionsError}</p>}
            <div role="status" style={{ ...small, color: color.textSuccess, minHeight: 0 }}>{message && !message.error ? message.text : ''}</div>
            {message?.error && <div role="alert" style={{ ...small, color: color.textErrorRed }}>{message.text}</div>}
          </div>
        </PopPanel>
      )}
    </>
  )
}
