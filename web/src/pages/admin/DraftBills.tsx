import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { actionBtnBlue } from '../../styles/actionRow'
import { apiFetch, ApiError } from '../../lib/api'
import { SettingsNav } from '../../components/SettingsNav'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE } from '../../lib/textStyles'
import { useDemo } from '../../context/DemoContext'
import { RichTextEditor } from '../../components/RichTextEditor'
import { BillBadge } from '../../components/BillBadge'

export function DraftBills() {
  const navigate = useNavigate()
  const { demoLocked } = useDemo()

  const [showDraftForm, setShowDraftForm] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftSponsor, setDraftSponsor] = useState('')
  const [draftText, setDraftText] = useState('')
  const [draftNumber, setDraftNumber] = useState('')
  const [draftYear, setDraftYear] = useState('')
  const [draftState, setDraftState] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [createDraftError, setCreateDraftError] = useState<string | null>(null)
  const [draftList, setDraftList] = useState<{ id: string; billNumber: string; title: string; state: string | null }[] | null>(null)
  // Fallback source for the state list and multi-state signal: this admin
  // page isn't wired into useBillFilters' searchParams/facetCounts plumbing,
  // so it calls GET /bills/facets directly rather than reusing that hook.
  // isMultiState mirrors useBillFilters' own notion (knownStates.size > 1)
  // rather than inventing a second one.
  //
  // null means "we don't yet know" — either the facets call hasn't resolved
  // or it failed. That must NOT be treated as "single state": a multi-state
  // tenant whose bills currently all sit in one state, or a facets outage,
  // would otherwise hide the State field and reproduce the exact
  // state='' bug this field exists to prevent. Only an array with exactly
  // one entry counts as confirmed single-state.
  const [knownStates, setKnownStates] = useState<string[] | null>(null)

  useEffect(() => {
    apiFetch<{ drafts: { id: string; billNumber: string; title: string; state: string | null }[] }>('/bills/drafts')
      .then(r => setDraftList(r.drafts))
      .catch(() => setDraftList([]))
  }, [])

  useEffect(() => {
    apiFetch<{ state: Record<string, number> }>('/bills/facets')
      .then(f => setKnownStates(Object.keys(f.state).sort()))
      .catch(() => setKnownStates(null))
  }, [])

  const isMultiState = knownStates === null || knownStates.length > 1

  // Fetched when the form opens rather than on mount: the number depends on how
  // many drafts exist, so a stale value from page load could collide.
  useEffect(() => {
    if (!showDraftForm) return
    apiFetch<{ billNumber: string; year: number }>('/bills/draft-defaults')
      .then(d => { setDraftNumber(d.billNumber ?? ''); setDraftYear(d.year != null ? String(d.year) : '') })
      .catch(() => { /* leave blank; the server fills both in when omitted */ })
  }, [showDraftForm])

  async function handleCreateDraft() {
    const title = draftTitle.trim()
    if (!title || demoLocked) return
    if (isMultiState && !draftState.trim()) return
    setCreatingDraft(true)
    setCreateDraftError(null)
    try {
      const hasContent = (html: string) => html.replace(/<[^>]*>/g, '').trim().length > 0
      const body: Record<string, unknown> = { title }
      if (draftSponsor.trim()) body.sponsor = draftSponsor.trim()
      if (hasContent(draftSummary)) body.summary = draftSummary
      if (hasContent(draftText)) body.text = draftText
      if (draftNumber.trim()) body.billNumber = draftNumber.trim()
      if (draftYear.trim()) body.year = Number(draftYear)
      if (draftState.trim()) body.state = draftState.trim()
      const created = await apiFetch<{ id: string }>('/bills/draft', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      // Tear the form down BEFORE navigating. The rich-text editors register
      // with the unsaved-text registry; unmounting them deregisters, so the
      // nav guard sees a clean page. Navigating first raised a confirm about
      // text that had in fact just been saved — and cancelling it stranded an
      // already-created draft behind a still-full form, so the next submit
      // created a duplicate. flushSync forces the unmount (and its
      // deregistration effect) to commit before navigate() runs the
      // blocker's dirty check — without it, the check races the effect and
      // still sees the stale, dirty registrations.
      flushSync(() => {
        setShowDraftForm(false)
        setDraftTitle('')
        setDraftSummary('')
        setDraftSponsor('')
        setDraftText('')
        setDraftNumber('')
        setDraftYear('')
        setDraftState('')
        setCreateDraftError(null)
      })
      navigate('/bills/' + created.id)
    } catch (err) {
      setCreateDraftError(err instanceof ApiError ? err.message : 'Failed to create draft.')
    } finally {
      setCreatingDraft(false)
    }
  }

  const labelStyle: React.CSSProperties = { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textSlate, display: 'block', marginBottom: 4 }
  const inputStyle: React.CSSProperties = { width: '100%', fontSize: fontSize.sm, padding: '8px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, boxSizing: 'border-box', fontFamily: 'inherit' }
  const sectionCard: React.CSSProperties = { ...CARD, padding: 24, marginBottom: 20 }
  const sectionTitle: React.CSSProperties = CARD_TITLE
  const sectionIntro: React.CSSProperties = { fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6, marginBottom: 20 }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <SettingsNav />

      {demoLocked && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }}>
          This is a demo instance — settings are read-only.
        </div>
      )}

      {/* Draft bills */}
      <div style={sectionCard}>
        <h1 style={sectionTitle}>Draft bills</h1>
        <div style={sectionIntro}>
          Create draft bills to track legislation before it is officially filed. Once a bill is filed, you can link it to the draft to merge all engagement (votes, positions, comments, notes) onto the filed bill.
        </div>
        {!showDraftForm && (
          <button
            onClick={() => { setShowDraftForm(true); setCreateDraftError(null) }}
            disabled={demoLocked}
            style={actionBtnBlue(demoLocked)}
          >
            Add draft bill
          </button>
        )}
        {showDraftForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ flex: 1 }}>
                <label htmlFor="draft-number" style={labelStyle}>Bill number</label>
                <input
                  id="draft-number"
                  value={draftNumber}
                  onChange={e => setDraftNumber(e.target.value)}
                  placeholder="D1"
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="draft-year" style={labelStyle}>Year</label>
                <select
                  id="draft-year"
                  value={draftYear}
                  onChange={e => setDraftYear(e.target.value)}
                  style={inputStyle}
                >
                  {(() => {
                    const base = Number(draftYear) || new Date().getFullYear()
                    const years = [base, base + 1, base + 2]
                    return years.map(y => <option key={y} value={String(y)}>{y}</option>)
                  })()}
                </select>
              </div>
            </div>
            {isMultiState && (
              <div>
                <label htmlFor="draft-state" style={labelStyle}>
                  State <span style={{ fontWeight: fontWeight.semibold, color: color.textDanger }}>*</span>
                </label>
                <select
                  id="draft-state"
                  value={draftState}
                  onChange={e => setDraftState(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Select a state…</option>
                  {(knownStates ?? []).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="draft-title" style={labelStyle}>Title <span style={{ fontWeight: fontWeight.semibold, color: color.textDanger }}>*</span></label>
              <input
                id="draft-title"
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                placeholder="Bill title…"
                style={inputStyle}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: this field appears only after the user clicks "Add draft bill", so moving focus into the newly-revealed form (rather than leaving it on the trigger button) matches WAI-ARIA guidance for on-demand-revealed forms.
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="draft-sponsor" style={labelStyle}>Sponsor(s)</label>
              <input
                id="draft-sponsor"
                value={draftSponsor}
                onChange={e => setDraftSponsor(e.target.value)}
                placeholder="Sponsor name…"
                style={inputStyle}
              />
            </div>
            <div>
              {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- RichTextEditor is a Tiptap wrapper with no id/aria-labelledby prop to associate with; giving it one is a component-API change out of scope here. */}
              <label style={labelStyle}>Summary</label>
              <RichTextEditor
                onChange={html => setDraftSummary(html)}
                initialContent={draftSummary}
                placeholder="Optional summary…"
                enableMentions={false}
                allowEmpty
              />
            </div>
            <div>
              {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- RichTextEditor is a Tiptap wrapper with no id/aria-labelledby prop to associate with; giving it one is a component-API change out of scope here. */}
              <label style={labelStyle}>Bill text</label>
              <RichTextEditor
                onChange={html => setDraftText(html)}
                initialContent={draftText}
                placeholder="Paste or type the bill text…"
                enableMentions={false}
                allowEmpty
              />
            </div>
            {createDraftError && (
              <div style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{createDraftError}</div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button
                onClick={handleCreateDraft}
                disabled={!draftTitle.trim() || (isMultiState && !draftState.trim()) || creatingDraft || demoLocked}
                style={actionBtnBlue(!draftTitle.trim() || (isMultiState && !draftState.trim()) || creatingDraft || demoLocked)}
              >
                {creatingDraft ? 'Creating…' : 'Create draft'}
              </button>
              <button
                onClick={() => { setShowDraftForm(false); setDraftTitle(''); setDraftSummary(''); setDraftSponsor(''); setDraftText(''); setDraftNumber(''); setDraftYear(''); setDraftState(''); setCreateDraftError(null) }}
                style={{ fontSize: fontSize.sm, color: color.textSecondary, background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '8px 14px', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {draftList !== null && (
          <div style={{ marginTop: showDraftForm ? 20 : 12 }}>
            {draftList.length === 0
              ? <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>No draft bills yet.</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {draftList.map(d => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <BillBadge billNumber={d.billNumber} state={d.state} to={'/bills/' + d.id} />
                      <span style={{ fontSize: fontSize.sm, color: color.textSecondary, flex: 1 }}>{d.title}</span>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (demoLocked) return
                          if (!window.confirm('Delete this draft bill? This permanently removes it and its votes, positions, comments, and notes.')) return
                          try {
                            await apiFetch('/bills/' + d.id, { method: 'DELETE' })
                            setDraftList(prev => prev ? prev.filter(x => x.id !== d.id) : prev)
                          } catch (err) {
                            alert(err instanceof Error ? err.message : 'Failed to delete draft.')
                          }
                        }}
                        disabled={demoLocked}
                        style={{
                          background: 'none', border: 'none', padding: 4, display: 'flex', alignItems: 'center', flexShrink: 0,
                          color: demoLocked ? color.borderStrong : color.textErrorRed,
                          cursor: demoLocked ? 'not-allowed' : 'pointer',
                        }}
                        title={demoLocked ? 'Locked in demo mode' : 'Delete draft'}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>delete</span>
                      </button>
                    </div>
                  ))}
                </div>
              )
            }
          </div>
        )}
      </div>
    </div>
  )
}
