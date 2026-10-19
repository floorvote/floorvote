import { useEffect, useMemo, useRef, useState } from 'react'
import { apiFetch, ApiError } from '../../lib/api'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, HELPER_TEXT } from '../../lib/textStyles'
import { committeeGroups, type CommitteeInfo, type CommitteeOption } from '../../lib/committeeGroups'
import { actionRowStyle, actionBtnRed } from '../../styles/actionRow'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { ProceduralTag } from '../BillList/CommitteeFilter'
import { percentOf } from './KeywordMatchSummary'
import { centralSyncWarning, type KeywordResyncResult } from './aiConfig'

/** The running total for a set of picks: every bill, the ones that would be fully analyzed, and those not analyzed now. */
type Summary = { total: number; analyzed: number; added: number }

/** GET /admin/bill-committees. */
type Picker = {
  counts: Record<string, number>
  info: CommitteeInfo
  stateTotals: Record<string, number>
  selected: string[]
  summary: Summary
}

/** How long picking must pause before the total is recounted, since a count reads every bill. */
const DEBOUNCE_MS = 400

const count = (n: number) => n.toLocaleString('en-US')
const bills = (n: number) => `${count(n)} ${n === 1 ? 'bill' : 'bills'}`
function isSummary(value: unknown): value is Summary {
  const s = value as Summary | null
  return !!s && [s.total, s.analyzed, s.added].every(n => typeof n === 'number')
}

function isPicker(value: unknown): value is Picker {
  const p = value as Picker | null
  return !!p && typeof p.counts === 'object' && typeof p.info === 'object' && typeof p.stateTotals === 'object'
    && Array.isArray(p.selected) && isSummary(p.summary)
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x))

/**
 * The Bill committees card (#471), under Bill keywords: an admin picks committees, and every bill referred to one is
 * fully analyzed, in addition to keyword matches. Each committee shows a bar of its size against its state's bills and
 * its count. Procedural committees (Rules, Calendars), which can hold half a session, are hidden behind a reveal and
 * shown with a warning, as `shared/committees.ts` names them. A running total gives the bills that would be fully
 * analyzed and their share. Saving goes through a review step that states the total and share, and the bills not
 * analyzed now (each one data fetch, as a keyword match costs), and requires an acknowledgment when a procedural
 * committee is picked. A save stores the picks, which register them with central, and runs the keyword re-run.
 */
export function BillCommitteesCard({ demoLocked }: { demoLocked: boolean }) {
  const [picker, setPicker] = useState<Picker | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string[]>([])
  const [picks, setPicks] = useState<string[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [answeredKey, setAnsweredKey] = useState<string>('[]')
  const [showProcedural, setShowProcedural] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<KeywordResyncResult | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    let cancelled = false
    apiFetch<Picker>('/admin/bill-committees')
      .then(p => {
        if (cancelled) return
        if (!isPicker(p)) { setLoadError('Could not load committees.'); return }
        setPicker(p)
        setSaved(p.selected)
        setPicks(p.selected)
        setSummary(p.summary)
        setAnsweredKey(JSON.stringify([...p.selected].sort()))
        loaded.current = true
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load committees.') })
    return () => { cancelled = true }
  }, [])

  const picksKey = JSON.stringify([...picks].sort())
  const pending = picksKey !== answeredKey

  useEffect(() => {
    if (!loaded.current || !pending) return
    let cancelled = false
    const timer = setTimeout(() => {
      apiFetch<Summary>('/admin/bill-committees/summary', { method: 'POST', body: JSON.stringify({ committees: JSON.parse(picksKey) }) })
        .then(s => { if (!cancelled) { setSummary(isSummary(s) ? s : null); setAnsweredKey(picksKey) } })
        .catch(() => { if (!cancelled) { setSummary(null); setAnsweredKey(picksKey) } })
    }, DEBOUNCE_MS)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [picksKey, pending])

  const groups = useMemo(() => picker ? committeeGroups(picker.counts, picker.info, picks) : [], [picker, picks])
  const procedural = groups.flatMap(g => g.options.filter(o => o.procedural))
  const pickedProcedural = procedural.filter(o => picks.includes(o.value))

  function toggle(id: string) {
    setReviewing(false)
    setAcknowledged(false)
    setResult(null)
    setPicks(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  }

  async function save() {
    setSaving(true)
    setSaveError(null)
    try {
      await apiFetch('/admin/config', { method: 'PUT', body: JSON.stringify({ bill_committees: picks }) })
      setSaved(picks)
      setReviewing(false)
      setAcknowledged(false)
      try {
        setResult(await apiFetch<KeywordResyncResult>('/admin/keyword-resync', { method: 'POST' }))
      } catch {
        // The picks are saved, and the next full pass applies them. The re-run only applies them sooner.
        setResult(null)
      }
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  const changed = !sameSet(picks, saved)
  const share = (s: Summary) => <strong>{count(s.analyzed)} of {bills(s.total)} ({percentOf(s.analyzed, s.total)})</strong>

  function row(option: CommitteeOption, state: string) {
    const total = picker?.stateTotals[state] ?? 0
    const width = total > 0 ? Math.max(1, Math.round((option.count / total) * 100)) : 0
    return (
      <li key={option.value} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px 72px', alignItems: 'center', gap: 12, padding: '4px 0' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: fontSize.sm, color: color.textPrimary, minWidth: 0, cursor: demoLocked ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={picks.includes(option.value)} onChange={() => toggle(option.value)} disabled={demoLocked} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{option.label}</span>
          {option.procedural && <ProceduralTag />}
        </label>
        <div
          role="meter"
          aria-label={`${option.label}: ${count(option.count)} of ${bills(total)}`}
          aria-valuenow={option.count}
          aria-valuemin={0}
          aria-valuemax={total}
          style={{ height: 8, background: color.surfaceMuted, borderRadius: radius.pill, overflow: 'hidden' }}
        >
          <div style={{ width: `${width}%`, height: '100%', background: option.procedural ? color.accentAmber : color.accentBlue }} />
        </div>
        <span style={{ ...HELPER_TEXT, textAlign: 'right' }}>{bills(option.count)}</span>
      </li>
    )
  }

  return (
    <div style={{ ...CARD, padding: 24, marginBottom: 20 }}>
      <h2 style={CARD_TITLE}>Bill committees</h2>
      <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6, marginBottom: 20 }}>
        Bills referred to a committee picked here are <em>fully analyzed</em>, in addition to the bills that match the keywords above. Each bar shows how many of the session's bills the committee has had.
      </div>

      {loadError ? (
        <div style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{loadError}</div>
      ) : !picker ? (
        <div style={HELPER_TEXT}>Loading…</div>
      ) : groups.length === 0 ? (
        <div style={HELPER_TEXT}>No committee referrals yet. Committees appear here as bills are referred to them.</div>
      ) : (
        <>
          <div style={{ maxHeight: 420, overflowY: 'auto', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '8px 12px' }}>
            {groups.map(g => {
              const visible = g.options.filter(o => !o.procedural || showProcedural || picks.includes(o.value))
              if (visible.length === 0) return null
              return (
                <div key={g.state}>
                  {groups.length > 1 && <div style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: color.textMuted, margin: '8px 0 4px' }}>{g.state}</div>}
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{visible.map(o => row(o, g.state))}</ul>
                </div>
              )
            })}
          </div>

          {procedural.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setShowProcedural(s => !s)}
                style={{ background: 'none', border: 'none', padding: 0, color: color.linkBlue, cursor: 'pointer', fontSize: fontSize.sm }}
              >
                {showProcedural ? 'Hide procedural committees' : `Show procedural committees (${procedural.length})`}
              </button>
              {showProcedural && (
                <div style={{ background: color.bgAmberPriority, border: `1px solid ${color.borderYellow}`, borderRadius: radius.md, padding: '10px 14px', fontSize: fontSize.sm, color: color.textAmberWarning, marginTop: 8 }}>
                  Procedural committees, such as Rules and Calendars, route or schedule bills rather than weigh what they say, and one can handle half a session's bills. Picking one fully analyzes every bill it handles.
                </div>
              )}
            </div>
          )}

          <div role="status" style={{ ...HELPER_TEXT, color: color.textSlate, marginTop: 12, opacity: pending ? 0.6 : 1 }}>
            {summary && <>Fully analyzed with these committees and the keywords: {share(summary)}.</>}
            {pending && <> Updating…</>}
          </div>

          {reviewing && summary && !pending ? (
            <div role="group" aria-label="Review and save" style={{ marginTop: 16, padding: 16, border: `1px solid ${color.borderStrong}`, borderRadius: radius.md }}>
              <p style={{ margin: 0, fontSize: fontSize.sm, color: color.textPrimary, lineHeight: 1.6 }}>
                Saving fully analyzes {share(summary)}, keyword matches included.{' '}
                {summary.added > 0
                  ? <>That adds <strong>{bills(summary.added)} that are not analyzed now</strong>. Each is fetched once from the data provider, as a keyword match is, which counts against its monthly call limit, and then analyzed by the AI.</>
                  : <>It adds no bill that is not analyzed now.</>}
              </p>
              {pickedProcedural.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, fontSize: fontSize.sm, color: color.textAmberWarning }}>
                  <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />
                  <span>
                    I understand that {pickedProcedural.map(o => o.label).join(', ')} {pickedProcedural.length === 1 ? 'is a procedural committee' : 'are procedural committees'}, which can handle a large share of the session, and that every bill referred to {pickedProcedural.length === 1 ? 'it' : 'them'} will be fully analyzed.
                  </span>
                </label>
              )}
              <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || (pickedProcedural.length > 0 && !acknowledged)}
                  style={actionBtnRed(saving || (pickedProcedural.length > 0 && !acknowledged))}
                >
                  {saving ? 'Saving…' : 'Save committees'}
                </button>
                <button
                  type="button"
                  onClick={() => { setReviewing(false); setAcknowledged(false) }}
                  style={{ background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '8px 14px', fontSize: fontSize.sm, color: color.textSecondary, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={actionRowStyle}>
              <button
                type="button"
                onClick={() => { setReviewing(true); setResult(null) }}
                disabled={demoLocked || !changed || pending || !summary}
                style={actionBtnRed(demoLocked || !changed || pending || !summary)}
              >
                Review and save…
              </button>
              {result && (
                <span style={{ fontSize: fontSize.sm, color: color.textSuccess }}>
                  {result.queued > 0 ? `Saved — ${bills(result.queued)} queued for full analysis` : 'Saved'}
                </span>
              )}
              {result && centralSyncWarning(result) && (
                <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{centralSyncWarning(result)}</span>
              )}
              {saveError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{saveError}</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
