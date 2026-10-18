import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { apiFetch, ApiError } from '../../lib/api'
import { useConfig } from '../../context/ConfigContext'
import { useDemo } from '../../context/DemoContext'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { computeEventPopoverPosition, type EventPopoverPosition } from './EventPopover'
import {
  EMPTY_EVENT_RULES, eventMatchesRules, hasLegacyParts, legacyNote, legacyParts, stateChoice, withCommittee, withoutLegacyParts, withStateAll, withStateOnly,
  type EventFacets, type EventRuleCommittee, type EventRules,
} from '../../../../shared/eventRules'

interface Committee { committeeId: string; name: string; state: string | null }
interface UpcomingEvent { id: string; facets: EventFacets; trackedOnAgenda: boolean; prioritizedOnAgenda: boolean }
interface Loaded { rules: EventRules | null; committees: Committee[]; events?: UpcomingEvent[]; optionsError: string | null }
interface ConfigurableState { code: string; heading: string; committees: Committee[] }

/**
 * The Calendar page's one gear for which committee events show (#420, #695),
 * for an instance with a covered state whose provider publishes its own
 * calendar. The gear opens one popover with a section per such state, headed
 * by the state and its body ("DC Council") with a summary of its choice. Each
 * section offers every event or only chosen committees, and each change saves
 * as it is made through the event-rules API. With one such state its section
 * is always open. An event with a prioritized bill always shows. A rule saved
 * earlier with kinds, event types, topics, tracked bills, or a committee
 * narrowed to a kind keeps working and shows as one line with Remove
 * (shared/eventRules.ts).
 *
 * Only admins can change the rules, so the page offers it to them alone.
 */
export function BodyEventsControl({ onChanged }: { onChanged?: () => void }) {
  const { config } = useConfig()
  const { demoLocked } = useDemo()
  const capable = Object.entries(config?.capabilities ?? {}).filter(([, cap]) => cap.bodyEvents)
  const hasBodyEvents = capable.length > 0
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [rules, setRulesState] = useState<EventRules | null>(null)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [pos, setPos] = useState<EventPopoverPosition | null>(null)
  const [openState, setOpenState] = useState<string | null>(null)
  const panelRef = useRef<PopPanelHandle>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const ids = useId()
  // The latest choice, so quick clicks build on each other, and what the server last confirmed, so a failed save can revert.
  const rulesRef = useRef<EventRules | null>(null)
  const confirmedRef = useRef<EventRules | null>(null)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  // Each commit's order, and the run of saves a failure cancels (bumped on every failure).
  const seqRef = useRef(0)
  const epochRef = useRef(0)
  /** The last rules "All events" cleared, for switching back to "Only these committees". */
  const stashedRef = useRef<EventRules | null>(null)
  /** The committees a state had when it was last set to "All events", for switching only that state back. */
  const stateStashRef = useRef<Map<string, EventRuleCommittee[]>>(new Map())
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

  function toggleMenu() {
    if (pos) { panelRef.current?.close(); return }
    const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect(8, 80, 0, 0)
    const p = computeEventPopoverPosition(rect, { width: 340, align: 'right' })
    setPos({ ...p, positionStyle: { ...p.positionStyle, maxHeight: 'min(82vh, 640px)' } })
  }

  const allCommittees = loaded?.committees ?? []
  const solo = capable.length === 1
  // One state's committees: those central lists for it. With one state, a committee no state is named for is its own too: one only an event or a saved rule names.
  const states: ConfigurableState[] = capable.map(([code, cap]) => ({
    code,
    heading: `${code} ${cap.bodyName?.trim() || 'Legislature'}`,
    committees: allCommittees.filter(c => c.state === code || (solo && !c.state)),
  }))
  const configured = states.map(s => s.code)
  const idsOf = (s: ConfigurableState) => s.committees.map(c => c.committeeId)
  const ready = !!loaded && !loadFailed
  const filtered = ready && states.some(s => stateChoice(rules, s.code, idsOf(s)).mode === 'only')
  const parts = legacyParts(rules)
  const kept = hasLegacyParts(parts)
  const chosen = new Set((rules?.committees ?? []).map(c => c.committeeId))
  const sectionOpen = (s: ConfigurableState) => solo || (openState ?? configured[0]) === s.code

  function chooseAll(s: ConfigurableState) {
    const mine = new Set(idsOf(s))
    stateStashRef.current.set(s.code, (rulesRef.current?.committees ?? []).filter(c => mine.has(c.committeeId)))
    void commit(withStateAll(rulesRef.current, s.code, configured, idsOf(s)))
  }

  function chooseOnly(s: ConfigurableState) {
    const current = rulesRef.current
    if (!current) {
      // Everything showed: with one state, restore what "All events" cleared, as it stood. With several, bring back this state's committees and what was kept from an earlier setting.
      if (solo) { void commit(stashedRef.current ?? EMPTY_EVENT_RULES); return }
      const was = stashedRef.current
      const base: EventRules | null = was ? { ...was, committees: [], allStates: undefined } : null
      void commit(withStateOnly(base, s.code, configured, stateStashRef.current.get(s.code) ?? [], idsOf(s)))
      return
    }
    void commit(withStateOnly(current, s.code, configured, stateStashRef.current.get(s.code) ?? [], idsOf(s)))
  }

  /** What the section's line says: upcoming events of the state that show under the rules now, of all it has. */
  function upcoming(s: ConfigurableState): { shown: number; total: number } {
    const mine = (loaded?.events ?? []).filter(e => e.facets.state === s.code || (solo && !e.facets.state))
    const shown = rules ? mine.filter(e => eventMatchesRules(e.facets, rules, { tracked: e.trackedOnAgenda, prioritized: e.prioritizedOnAgenda })).length : mine.length
    return { shown, total: mine.length }
  }

  const trigger: React.CSSProperties = {
    position: 'relative', width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: pos ? color.countChipBg : 'transparent', border: 'none', borderRadius: radius.md, cursor: ready ? 'pointer' : 'default',
    color: color.textSecondary, padding: 0, fontFamily: 'inherit',
  }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: fontSize.sm, color: color.textSlate, padding: '4px 0' }
  const small: React.CSSProperties = { fontSize: fontSize.xs, color: color.textSecondary, lineHeight: 1.5, margin: 0 }
  const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, fontSize: fontSize.xs, cursor: demoLocked ? 'default' : 'pointer', fontFamily: 'inherit' }
  const visuallyHidden: React.CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }
  const noteId = `${ids}-filtered`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={ready ? toggleMenu : undefined}
        disabled={!ready}
        aria-label="Committee events settings"
        aria-haspopup="dialog"
        aria-expanded={!!pos}
        aria-describedby={filtered ? noteId : undefined}
        title={loadFailed ? 'Could not load which committee events show.' : 'Committee events'}
        style={trigger}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: fontSize.xxl, lineHeight: 1 }}>settings</span>
        {filtered && (
          <>
            <span data-testid="committee-filter-dot" aria-hidden="true" style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: radius.sm, background: color.accentAmber, border: `1.5px solid ${color.surfaceMuted}` }} />
            <span id={noteId} style={visuallyHidden}>Some committee events are filtered.</span>
          </>
        )}
      </button>
      {pos && ready && (
        <PopPanel
          ref={panelRef}
          onClose={() => setPos(null)}
          triggerRef={triggerRef}
          ariaLabel="Committee events"
          transformOrigin={pos.transformOrigin}
          enterOffsetY={pos.enterOffsetY}
          positionStyle={pos.positionStyle}
        >
          <div ref={menuRef} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
            <div>
              <div style={{ fontSize: fontSize.base, fontWeight: fontWeight.semibold, color: color.textPrimary }}>Committee events</div>
              <p style={{ ...small, marginTop: 2 }}>The legislature&apos;s own calendar, set for each state that publishes one.</p>
            </div>

            {states.map(s => {
              const open = sectionOpen(s)
              const choice = stateChoice(rules, s.code, idsOf(s))
              const only = choice.mode === 'only'
              const summary = !only ? 'All events' : `${choice.committeeIds.length} of ${s.committees.length} committees`
              const titleId = `${ids}-${s.code}-title`
              const { shown, total } = upcoming(s)
              const headStyle: React.CSSProperties = { flex: 1, fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textPrimary, textAlign: 'left' }
              return (
                <section key={s.code} role="group" aria-labelledby={titleId} style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, overflow: 'hidden' }}>
                  {solo
                    ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: color.surfaceMuted }}>
                        <span id={titleId} style={headStyle}>{s.heading}</span>
                        <span data-testid={`state-summary-${s.code}`} style={small}>{summary}</span>
                      </div>
                    )
                    : (
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpenState(open ? '' : s.code)}
                        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: open ? color.surfaceMuted : color.white, border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}
                      >
                        <span id={titleId} style={headStyle}>{s.heading}</span>
                        <span data-testid={`state-summary-${s.code}`} style={small}>{summary}</span>
                        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: fontSize.xl, lineHeight: 1, color: color.textMuted }}>{open ? 'expand_less' : 'expand_more'}</span>
                      </button>
                    )}
                  {open && (
                    <div style={{ padding: '8px 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div role="radiogroup" aria-label={`Which ${s.heading} events show`}>
                        <label style={row}>
                          <input type="radio" name={`body-events-choice-${s.code}`} checked={!only} disabled={demoLocked}
                            onChange={() => { if (only) chooseAll(s) }} />
                          All events
                        </label>
                        <label style={row}>
                          <input type="radio" name={`body-events-choice-${s.code}`} checked={only} disabled={demoLocked}
                            onChange={() => { if (!only) chooseOnly(s) }} />
                          Only these committees
                        </label>
                      </div>

                      {only && (
                        <fieldset style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
                          <legend style={{ ...small, fontWeight: fontWeight.medium, marginBottom: 2 }}>Committees</legend>
                          {s.committees.length === 0 && <p style={small}>No committees are listed yet.</p>}
                          {s.committees.map(c => (
                            <label key={c.committeeId} style={row}>
                              <input type="checkbox" checked={chosen.has(c.committeeId)} disabled={demoLocked}
                                onChange={e => void commit(withCommittee(rulesRef.current, c, e.target.checked))} />
                              {c.name}
                            </label>
                          ))}
                        </fieldset>
                      )}

                      <p style={{ ...small, background: color.surfaceMuted, borderRadius: radius.md, padding: '6px 8px' }}>
                        Showing {shown} of {total} upcoming events
                      </p>
                    </div>
                  )}
                </section>
              )
            })}

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
