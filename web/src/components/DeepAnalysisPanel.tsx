import { useEffect, useState } from 'react'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { SECTION_LABEL } from '../lib/textStyles'
import { apiFetch, ApiError } from '../lib/api'
import { useDemo } from '../context/DemoContext'
import { InfoTooltip } from './InfoTooltip'
import { safeDate } from '../lib/dates'
import type { BillDeepAnalysis, DeepKind, HearingBrief } from '../../../shared/deepAnalysis'

export interface DeepView {
  enabled: boolean
  status: 'none' | 'pending' | 'claimed' | 'done' | 'error'
  requestedAt?: string
  completedAt?: string | null
  model?: string | null
  content?: BillDeepAnalysis | HearingBrief | null
  stale?: boolean
  error?: string | null
  event?: { id: string; description: string | null; date: string | null; time: string | null; location: string | null; url: string | null; source: string; status: string } | null
}

const LABEL: Record<DeepKind, string> = { bill: 'Deep analysis', hearing: 'Hearing brief' }

const EXPLAINER: Record<DeepKind, string> = {
  bill: 'A longer analysis written by a stronger AI model for high- and medium-priority bills: what each section changes, who it affects, how it fits with existing law, and what to raise at a hearing. It is redone when the bill text changes. Check anything you cite against the bill text.',
  hearing: 'A preparation brief written by a stronger AI model for Council hearings and meetings on the calendar in the next ten days. Check anything you cite against the source.',
}

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSlate, marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    </div>
  )
}

function BillBody({ c }: { c: BillDeepAnalysis }) {
  return (
    <>
      <p style={{ margin: 0, lineHeight: 1.6 }}>{c.bottomLine}</p>
      {c.whatChanges.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSlate, marginBottom: 4 }}>What it changes</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
            {c.whatChanges.map((w, i) => (
              <li key={i}>
                <span style={{ fontWeight: fontWeight.medium }}>{w.section}:</span> {w.change}
                {w.quote && <span style={{ color: color.textSecondary }}> “{w.quote}”</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <List title="Who it affects" items={c.whoItAffects} />
      <List title="How it fits with existing law" items={c.howItFits} />
      <List title="Open questions" items={c.openQuestions} />
      <List title="Questions for the hearing" items={c.testimony.questions} />
      <List title="Amendments worth proposing" items={c.testimony.amendments} />
      <List title="Where Councilmembers stand" items={c.votingRecord ?? []} />
      <List title="What we have already said" items={c.teamPositions ?? []} />
      <List title="Limits of this analysis" items={c.caveats} />
    </>
  )
}

function HearingBody({ c }: { c: HearingBrief }) {
  return (
    <>
      <p style={{ margin: 0, lineHeight: 1.6 }}>{c.overview}</p>
      {c.agenda.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSlate, marginBottom: 4 }}>On the agenda</div>
          <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.55 }}>
            {c.agenda.map((a, i) => (
              <li key={i}>
                <span style={{ fontWeight: fontWeight.medium }}>{a.item}{a.billNumber ? ` (${a.billNumber})` : ''}:</span> {a.whyItMatters}
              </li>
            ))}
          </ul>
        </div>
      )}
      <List title="What to watch" items={c.whatToWatch} />
      <List title="Questions to raise" items={c.questionsToAsk} />
      <List title="Testimony angles" items={c.testimonyAngles} />
      <List title="To prepare" items={c.prep} />
      <List title="Who is in the room" items={c.whoIsInTheRoom ?? []} />
      <List title="What we have already said" items={c.teamPositions ?? []} />
      <List title="Limits of this brief" items={c.caveats} />
    </>
  )
}

/**
 * A subject's deep analysis (bill) or hearing brief (calendar event). Renders
 * nothing when the operator has not turned the queue on. `onLoad` hands the
 * loaded view to a parent that needs it (the hearing brief page's header).
 */
export function DeepAnalysisPanel({ kind, subjectId, isAdmin, onLoad }: { kind: DeepKind; subjectId: string; isAdmin: boolean; onLoad?: (v: DeepView) => void }) {
  const { demoLocked } = useDemo()
  const [view, setView] = useState<DeepView | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    apiFetch<DeepView>(`/deep/${kind}/${subjectId}`)
      .then(v => { if (live && v && typeof v === 'object') { setView(v); onLoad?.(v) } })
      .catch(() => { if (live) setView(null) })
    return () => { live = false }
  }, [kind, subjectId, onLoad])

  if (!view || !view.enabled) return null

  async function request() {
    setRequesting(true)
    setMessage(null)
    try {
      const v = await apiFetch<DeepView>(`/deep/${kind}/${subjectId}/request`, { method: 'POST' })
      setView(v)
      setMessage('Requested. It usually arrives within a few hours.')
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : 'Request failed.')
    } finally {
      setRequesting(false)
    }
  }

  const pending = view.status === 'pending' || view.status === 'claimed'
  const content = view.content
  const canRequest = isAdmin && !demoLocked && !pending

  return (
    <section aria-label={LABEL[kind]} style={{ marginTop: 16, padding: 16, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, background: color.white, fontSize: fontSize.sm, color: color.textSlate }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: content ? 10 : 0 }}>
        <span style={SECTION_LABEL}>{LABEL[kind]}</span>
        <InfoTooltip text={EXPLAINER[kind]} maxWidth={340} align="left" label={`About the ${LABEL[kind].toLowerCase()}`} />
        {view.status === 'done' && view.completedAt && (
          <span style={{ color: color.textMuted, fontSize: fontSize.xs }}>
            {view.model ? `${view.model}, ` : ''}{safeDate(view.completedAt.slice(0, 10)) ?? view.completedAt.slice(0, 10)}
          </span>
        )}
        {pending && (
          <span role="status" style={{ color: color.textAmberDark, fontSize: fontSize.xs, fontWeight: fontWeight.medium }}>
            {view.status === 'claimed' ? 'Being written now' : content ? 'Update pending: the text changed' : 'Pending: usually ready within a few hours'}
          </span>
        )}
        {view.status === 'error' && <span style={{ color: color.textErrorRed, fontSize: fontSize.xs }}>The last attempt failed{view.error ? `: ${view.error}` : ''}</span>}
        <span style={{ flex: 1 }} />
        {canRequest && (
          <button type="button" onClick={request} disabled={requesting} className="blue-link"
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: fontSize.xs }}>
            {requesting ? 'Requesting…' : view.status === 'none' ? `Request a ${LABEL[kind].toLowerCase()}` : 'Redo'}
          </button>
        )}
      </div>
      {message && <div role="status" style={{ color: color.textSecondary, fontSize: fontSize.xs, marginTop: 6 }}>{message}</div>}
      {view.status === 'none' && !isAdmin && (
        <div style={{ color: color.textMuted, marginTop: 6 }}>
          {kind === 'bill' ? 'Written automatically for high- and medium-priority bills.' : 'Written automatically for Council events in the next ten days.'}
        </div>
      )}
      {content && (
        <div style={{ opacity: view.stale ? 0.75 : 1 }}>
          {view.stale && <div style={{ color: color.textMuted, fontSize: fontSize.xs, marginBottom: 8 }}>Written for an earlier version. An update is on the way.</div>}
          {kind === 'bill' ? <BillBody c={content as BillDeepAnalysis} /> : <HearingBody c={content as HearingBrief} />}
        </div>
      )}
    </section>
  )
}
