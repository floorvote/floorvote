import { useEffect, useState } from 'react'
import { color, fontSize, fontWeight, radius } from '../../styles/tokens'
import { actionRowStyle, actionBtnBlue } from '../../styles/actionRow'
import { apiFetch, ApiError } from '../../lib/api'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, FORM_LABEL, HELPER_TEXT } from '../../lib/textStyles'
import { ResizableTextarea } from '../../components/ResizableTextarea'
import { InfoTooltip } from '../../components/InfoTooltip'
import { safeDate } from '../../lib/dates'
import {
  COUNCIL_CALENDAR_PRESETS, COUNCIL_HEARING_TYPE_HINTS, type CouncilCalendarRulesShape,
} from '../../../../shared/councilCalendarPresets'

type Loaded = { rules: CouncilCalendarRulesShape | null; committees: string[]; types: string[] }
type PreviewEvent = { date: string; time: string | null; title: string; url: string }

const COMMITTEE_LABELS: Record<string, string> = {
  'Legislative Meeting': 'Legislative meetings (including breakfast meetings)',
}

/** Form state: committee → '' (every event) or one hearing type. */
interface FormState {
  committees: Map<string, string>
  types: Set<string>
  keywords: string
  trackedBills: boolean
}

function toForm(rules: CouncilCalendarRulesShape | null): FormState {
  const committees = new Map<string, string>()
  // A committee listed more than once keeps its broadest entry: "every event" wins.
  for (const i of rules?.include ?? []) {
    const prior = committees.get(i.committee)
    committees.set(i.committee, prior === '' || !i.type ? '' : prior ?? i.type)
  }
  return {
    committees,
    types: new Set(rules?.types ?? []),
    keywords: (rules?.topicKeywords ?? []).join('\n'),
    trackedBills: rules?.trackedBills ?? true,
  }
}

function toRules(f: FormState): CouncilCalendarRulesShape {
  return {
    include: [...f.committees].map(([committee, type]) => type ? { committee, type } : { committee }),
    types: [...f.types],
    topicKeywords: f.keywords.split('\n').map(k => k.trim()).filter(Boolean),
    trackedBills: f.trackedBills,
  }
}

/**
 * Settings → Configuration → DC Council calendar. Each team picks the
 * committees, hearing types, and agencies whose Council hearings and meetings
 * go on its calendar, with or without a bill attached.
 */
export function CouncilCalendarSettings({ demoLocked }: { demoLocked: boolean }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => toForm(null))
  const [preset, setPreset] = useState('')
  const [preview, setPreview] = useState<PreviewEvent[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)

  useEffect(() => {
    apiFetch<Loaded>('/admin/council-calendar')
      .then(d => { setLoaded(d); setForm(toForm(d.rules)) })
      .catch(() => setLoadError('Could not load the Council calendar settings.'))
  }, [])

  function edit(patch: Partial<FormState>) {
    setForm(f => ({ ...f, ...patch }))
    setPreview(null)
    setMessage(null)
  }

  function toggleCommittee(name: string, on: boolean) {
    const committees = new Map(form.committees)
    if (on) committees.set(name, '')
    else committees.delete(name)
    edit({ committees })
  }

  function toggleType(name: string, on: boolean) {
    const types = new Set(form.types)
    if (on) types.add(name)
    else types.delete(name)
    edit({ types })
  }

  function applyPreset(id: string) {
    const p = COUNCIL_CALENDAR_PRESETS.find(x => x.id === id)
    if (!p) return
    edit(toForm(p.rules))
    setPreset('')
    setMessage({ text: `Filled in "${p.label}". Review it, then save.` })
  }

  async function runPreview() {
    setPreviewing(true)
    setMessage(null)
    try {
      const r = await apiFetch<{ events: PreviewEvent[] }>('/admin/council-calendar/preview', { method: 'POST', body: JSON.stringify({ rules: toRules(form) }) })
      setPreview(r.events)
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : 'Preview failed.', error: true })
    } finally {
      setPreviewing(false)
    }
  }

  async function save(clear = false) {
    setSaving(true)
    setMessage(null)
    try {
      const r = await apiFetch<{ rules: CouncilCalendarRulesShape | null; sync: { upserted: number } | null; syncError?: string | null }>(
        '/admin/council-calendar', { method: 'PUT', body: JSON.stringify({ rules: clear ? null : toRules(form) }) })
      if (clear) {
        setForm(toForm(null))
        setLoaded(l => l && { ...l, rules: null })
        setMessage({ text: 'Council events are off. They have been removed from the calendar.' })
      } else {
        setLoaded(l => l && { ...l, rules: r.rules })
        setMessage(r.syncError
          ? { text: r.syncError }
          : { text: `Saved. The calendar now has ${r.sync?.upserted ?? 0} Council event${r.sync?.upserted === 1 ? '' : 's'} from the next five months.` })
      }
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : 'Save failed.', error: true })
    } finally {
      setSaving(false)
    }
  }

  const label: React.CSSProperties = FORM_LABEL
  const hint: React.CSSProperties = { ...HELPER_TEXT, marginTop: 4 }
  const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: fontSize.sm, color: color.textSlate, padding: '3px 0' }
  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', columnGap: 16 }
  const select: React.CSSProperties = { fontSize: fontSize.xs, padding: '1px 4px', borderRadius: radius.sm, border: `1px solid ${color.borderDefault}`, background: color.white, maxWidth: 170 }

  return (
    <div style={{ ...CARD, padding: 24, marginBottom: 20 }}>
      <h2 style={CARD_TITLE}>DC Council calendar</h2>
      <div style={{ fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6, marginBottom: 20 }}>
        Choose which Council hearings and meetings go on your calendar, including the ones with no bill attached: performance and budget oversight hearings, roundtables, and legislative and breakfast meetings. Events come from the Council's hearing calendar and update hourly. Bill hearings for prioritized bills and deadlines for tracked bills appear on their own.
      </div>

      {loadError && <div style={{ ...hint, color: color.textErrorRed }}>{loadError}</div>}
      {!loaded && !loadError && <div style={hint}>Loading…</div>}
      {loaded && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <label htmlFor="council-preset" style={{ ...label, marginBottom: 0 }}>Start from a preset</label>
            <select id="council-preset" value={preset} onChange={e => setPreset(e.target.value)} style={{ ...select, fontSize: fontSize.sm, maxWidth: 280 }} disabled={demoLocked}>
              <option value="">Choose…</option>
              {COUNCIL_CALENDAR_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <button onClick={() => applyPreset(preset)} disabled={!preset || demoLocked} style={actionBtnBlue(!preset || demoLocked)}>Fill in</button>
            {preset && <span style={{ ...hint, marginTop: 0, flexBasis: '100%' }}>{COUNCIL_CALENDAR_PRESETS.find(p => p.id === preset)?.description} Replaces the choices below until you save.</span>}
          </div>

          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
            <legend style={label}>Committees: every event they hold</legend>
            <div style={grid}>
              {loaded.committees.map(name => {
                const on = form.committees.has(name)
                return (
                  <div key={name} style={checkRow}>
                    <input type="checkbox" id={`cc-${name}`} checked={on} onChange={e => toggleCommittee(name, e.target.checked)} disabled={demoLocked} />
                    <label htmlFor={`cc-${name}`} style={{ flex: 1 }}>{COMMITTEE_LABELS[name] ?? name}</label>
                    {on && (
                      <select aria-label={`Which ${name} events`} value={form.committees.get(name) ?? ''} style={select} disabled={demoLocked}
                        onChange={e => { const committees = new Map(form.committees); committees.set(name, e.target.value); edit({ committees }) }}>
                        <option value="">All events</option>
                        {loaded.types.map(t => <option key={t} value={t}>{t}s only</option>)}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          </fieldset>

          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 20px' }}>
            <legend style={label}>Hearing types: every one, whichever committee holds it</legend>
            <div style={grid}>
              {loaded.types.map(t => (
                <div key={t} style={checkRow}>
                  <input type="checkbox" id={`ct-${t}`} checked={form.types.has(t)} onChange={e => toggleType(t, e.target.checked)} disabled={demoLocked} />
                  <label htmlFor={`ct-${t}`}>{t}</label>
                  {COUNCIL_HEARING_TYPE_HINTS[t] && <InfoTooltip text={COUNCIL_HEARING_TYPE_HINTS[t]} maxWidth={300} align="left" label={`About ${t}`} />}
                </div>
              ))}
            </div>
            <div style={hint}>Most teams leave these off and use agencies below: there are about 60 performance oversight and 50 budget oversight hearings each spring.</div>
          </fieldset>

          <div style={{ marginBottom: 20 }}>
            <label htmlFor="council-keywords" style={label}>Agencies and topics</label>
            <ResizableTextarea id="council-keywords" value={form.keywords} onChange={e => edit({ keywords: e.target.value })}
              initialHeight={140} minHeight={60} style={{ fontFamily: 'monospace', fontSize: fontSize.sm }} disabled={demoLocked} />
            <div style={hint}>
              One per line, matched against each event's agenda, where oversight and budget hearings name the agency: <code>department of corrections</code> catches that agency's hearings in any committee. Same syntax as bill keywords: add <code>*</code> to widen a word (<code>juvenile*</code>).
            </div>
          </div>

          <div style={{ ...checkRow, marginBottom: 4 }}>
            <input type="checkbox" id="council-tracked" checked={form.trackedBills} onChange={e => edit({ trackedBills: e.target.checked })} disabled={demoLocked} />
            <label htmlFor="council-tracked">Also add any event whose agenda lists a bill we track</label>
          </div>

          <div style={actionRowStyle}>
            <button onClick={() => save()} disabled={saving || demoLocked} style={actionBtnBlue(saving || demoLocked)}>
              {saving ? 'Saving…' : 'Save and update calendar'}
            </button>
            <button onClick={runPreview} disabled={previewing} style={{ ...actionBtnBlue(previewing), background: color.white, color: color.linkBlue, border: `1px solid ${color.borderDefault}` }}>
              {previewing ? 'Checking…' : 'Preview'}
            </button>
            {loaded.rules && !demoLocked && (
              <button onClick={() => { if (window.confirm('Turn off Council events? They will be removed from your calendar.')) void save(true) }}
                disabled={saving} className="blue-link" style={{ background: 'none', border: 'none', fontSize: fontSize.sm, cursor: 'pointer', padding: 0 }}>
                Turn off
              </button>
            )}
            {message && <span role="status" style={{ fontSize: fontSize.sm, color: message.error ? color.textErrorRed : color.textSuccess, flexShrink: 1 }}>{message.text}</span>}
          </div>

          {preview && (
            <div style={{ marginTop: 12, fontSize: fontSize.sm, color: color.textSlate }}>
              <div style={{ fontWeight: fontWeight.medium, marginBottom: 6 }}>
                {preview.length === 0 ? 'No upcoming Council events match these choices.' : `${preview.length} upcoming Council event${preview.length === 1 ? '' : 's'} match these choices:`}
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {preview.slice(0, 25).map(e => (
                  <li key={e.url}>
                    <span style={{ color: color.textMuted }}>{safeDate(e.date) ?? e.date}{e.time ? ` ${e.time}` : ''}</span>{' '}
                    <a href={e.url} target="_blank" rel="noopener noreferrer" className="blue-link">{e.title}</a>
                  </li>
                ))}
              </ul>
              {preview.length > 25 && <div style={hint}>and {preview.length - 25} more</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
