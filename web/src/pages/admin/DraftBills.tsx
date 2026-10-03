import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { color, radius, fontSize } from '../../styles/tokens'
import { actionBtnBlue } from '../../styles/actionRow'
import { apiFetch, ApiError } from '../../lib/api'
import { SettingsNav } from '../../components/SettingsNav'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, FORM_LABEL } from '../../lib/textStyles'
import { useDemo } from '../../context/DemoContext'
import { RichTextEditor } from '../../components/RichTextEditor'
import { BillBadge } from '../../components/BillBadge'
import { Picker, type PickerOption } from '../../components/Picker'
import { pickerFieldTriggerStyle, PickerFieldCaret } from '../../lib/pickerFieldStyle'
import { billDisplayTitle } from '../../../../shared/billTitle'
import { parseStoredMulti } from '../../../../shared/customFieldValues'
import { CustomFieldsSection, type CustomFieldDef } from '../../components/CustomFieldsSection'
import { RequiredLabel, MissingRequiredReason, requiredName, useRequiredSubmit } from '../../components/RequiredField'

type CollectedValues = Record<string, { value: string; setBy: string | null; updatedAt: string }>


export function DraftBills() {
  const navigate = useNavigate()
  const { demoLocked } = useDemo()

  const [showDraftForm, setShowDraftForm] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftSponsor, setDraftSponsor] = useState('')
  const [draftText, setDraftText] = useState('')
  const [draftNumber, setDraftNumber] = useState('')
  // Seeded with the current year, never '': an empty value matches no <option>,
  // so the <select> would render the first year while holding nothing and the
  // request body would silently omit `year`.
  const [draftYear, setDraftYear] = useState(String(new Date().getFullYear()))
  const [draftState, setDraftState] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [createDraftError, setCreateDraftError] = useState<string | null>(null)
  // Custom fields shown on the create form, and the values collected for them.
  // The values are held in the bill page's serialized form (multi-select as a
  // JSON array string) because the same CustomFieldsSection renders them; they
  // are converted back to the request format on submit.
  const [customFieldDefs, setCustomFieldDefs] = useState<CustomFieldDef[]>([])
  const [customFieldValues, setCustomFieldValues] = useState<CollectedValues>({})
  const [draftList, setDraftList] = useState<{ id: string; billNumber: string; title: string; state: string | null }[] | null>(null)
  // Source for the State field's option list. This admin page isn't wired
  // into useBillFilters' searchParams/facetCounts plumbing, so it calls
  // GET /bills/facets directly rather than reusing that hook.
  //
  // Facets only reports states that already HAVE bills, so it can never tell a
  // single-state tenant from a multi-state one whose bills happen to sit in one
  // state. It is therefore no longer consulted about whether to SHOW the field
  // — only about what to offer in it. `null` means "unknown" (still loading, or
  // the call failed); `statesResolved` distinguishes those from a genuine empty
  // list, so a tenant with no bills yet gets a free-text input instead of a
  // select it cannot satisfy.
  const [knownStates, setKnownStates] = useState<string[] | null>(null)
  const [statesResolved, setStatesResolved] = useState(false)
  // The authoritative single-state signal, from GET /bills/draft-defaults:
  // c.env.STATE when the tenant is configured for one state, null when it
  // tracks many. null (including before the call resolves, or if it fails)
  // shows the State field — the client only ever hides it on positive evidence
  // of a configured state. The real guarantee that a draft never gets state=''
  // is server-side (POST /bills/draft 400s on an empty resolved state); this
  // field is the convenience that lets an admin satisfy that up front.
  const [tenantState, setTenantState] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<{ drafts: { id: string; billNumber: string; title: string; state: string | null }[] }>('/bills/drafts')
      .then(r => setDraftList(r.drafts))
      .catch(() => setDraftList([]))
  }, [])

  useEffect(() => {
    // A failure only hides the custom fields; the draft can still be created.
    apiFetch<CustomFieldDef[]>('/config/custom-fields')
      .then(defs => setCustomFieldDefs(Array.isArray(defs) ? defs : []))
      .catch(() => setCustomFieldDefs([]))
  }, [])

  useEffect(() => {
    apiFetch<{ state: Record<string, number> }>('/bills/facets')
      .then(f => setKnownStates(Object.keys(f.state).sort()))
      .catch(() => setKnownStates(null))
      .finally(() => setStatesResolved(true))
  }, [])

  const needsState = tenantState === null
  const stateOptions = knownStates ?? []
  // Offer a select when facets gave us something to offer; otherwise (a tenant
  // with no bills yet, or a facets outage) let the admin type the state.
  const useStateSelect = !statesResolved || stateOptions.length > 0
  // State is the form's only required field, and only on a multi-state tenant.
  const createGate = useRequiredSubmit({
    missingRequired: needsState && !draftState.trim(),
    blocked: creatingDraft || demoLocked,
  })

  // Fetched when the form opens rather than on mount: the number depends on how
  // many drafts exist, so a stale value from page load could collide.
  // Re-fetched when the chosen state changes, not just when the form opens:
  // both the next draft number and the session-aware year are per-state, so a
  // value computed for the wrong bucket can hand back a number that 409s on
  // create. This deliberately overwrites a hand-typed number when the admin
  // then switches state — the prefill must describe the state actually in use.
  useEffect(() => {
    if (!showDraftForm) return
    const picked = draftState.trim().toUpperCase()
    const qs = picked ? `?state=${encodeURIComponent(picked)}` : ''
    let cancelled = false
    apiFetch<{ billNumber?: string; year?: number; tenantState?: string | null }>('/bills/draft-defaults' + qs)
      .then(d => {
        if (cancelled) return
        setDraftNumber(d.billNumber ?? '')
        if (d.year != null) setDraftYear(String(d.year))
        setTenantState(d.tenantState ?? null)
      })
      .catch(() => { /* keep the current-year default; the server fills the number in when omitted */ })
    return () => { cancelled = true }
  }, [showDraftForm, draftState])

  async function handleCreateDraft() {
    // Title is optional: a draft may be tracked by its number alone and shows
    // as "Untitled draft" until it gets one.
    const title = draftTitle.trim()
    if (demoLocked) return
    if (needsState && !draftState.trim()) return
    setCreatingDraft(true)
    setCreateDraftError(null)
    try {
      const hasContent = (html: string) => html.replace(/<[^>]*>/g, '').trim().length > 0
      const body: Record<string, unknown> = {}
      if (title) body.title = title
      if (draftSponsor.trim()) body.sponsor = draftSponsor.trim()
      if (hasContent(draftSummary)) body.summary = draftSummary
      if (hasContent(draftText)) body.text = draftText
      if (draftNumber.trim()) body.billNumber = draftNumber.trim()
      if (draftYear.trim()) body.year = Number(draftYear)
      if (draftState.trim()) body.state = draftState.trim()
      const multipleById = new Map(customFieldDefs.map(f => [f.id, !!f.multiple]))
      const customFields = Object.fromEntries(
        Object.entries(customFieldValues).map(([fieldId, { value }]) =>
          [fieldId, multipleById.get(fieldId) ? parseStoredMulti(value) : value]),
      )
      if (Object.keys(customFields).length > 0) body.customFields = customFields
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
        setDraftYear(String(new Date().getFullYear()))
        setDraftState('')
        setCustomFieldValues({})
        setCreateDraftError(null)
      })
      navigate('/bills/' + created.id)
    } catch (err) {
      setCreateDraftError(err instanceof ApiError ? err.message : 'Failed to create draft.')
    } finally {
      setCreatingDraft(false)
    }
  }

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
          Create draft bills to track legislation before it is officially filed. Once a bill is filed, you can link the draft to it, which moves all engagement (votes, positions, comments, notes, custom fields, and calendar events) onto the filed bill.
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
                <label htmlFor="draft-number" style={FORM_LABEL}>Bill number</label>
                <input
                  id="draft-number"
                  value={draftNumber}
                  onChange={e => setDraftNumber(e.target.value)}
                  placeholder="D1"
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                {/* eslint-disable-next-line jsx-a11y/label-has-associated-control -- the Picker's trigger is a <button>, not a labelable control; it carries its own aria-label="Year" for the accessible name. */}
                <label style={FORM_LABEL}>Year</label>
                {(() => {
                  // The held value must always be one of the options, and the
                  // current year must always be offerable — the fetched base
                  // can be in the past when central is unreachable and the
                  // fallback is the tenant's newest filed year.
                  const thisYear = new Date().getFullYear()
                  const base = Number(draftYear) || thisYear
                  const years = [...new Set([base, base + 1, base + 2, thisYear])].sort((a, b) => a - b)
                  const yearOptions: PickerOption[] = years.map(y => ({ value: String(y), label: String(y) }))
                  return (
                    <Picker
                      mode="single"
                      value={draftYear}
                      options={yearOptions}
                      onChange={v => { if (v != null) setDraftYear(v) }}
                      ariaLabel="Year"
                      panelMinWidth={100}
                      trigger={({ toggle, open }) => (
                        <button type="button" aria-label="Year" onClick={toggle} style={pickerFieldTriggerStyle()}>
                          <span>{draftYear}</span>
                          <PickerFieldCaret open={open} />
                        </button>
                      )}
                    />
                  )
                })()}
              </div>
            </div>
            {needsState && (
              <div>
                {/* htmlFor only applies in the free-text fallback branch below; the Picker branch's trigger is a <button> carrying its own aria-label. */}
                <RequiredLabel htmlFor={useStateSelect ? undefined : 'draft-state'}>State</RequiredLabel>
                {useStateSelect ? (
                  <Picker
                    mode="single"
                    value={draftState || null}
                    options={stateOptions.map(s => ({ value: s, label: s }))}
                    emptyOption={{ label: 'Select a state…' }}
                    onChange={v => setDraftState(v ?? '')}
                    ariaLabel="State"
                    trigger={({ toggle, open }) => (
                      <button type="button" aria-label={requiredName('State')} onClick={toggle} style={pickerFieldTriggerStyle()}>
                        <span>{draftState || 'Select a state…'}</span>
                        <PickerFieldCaret open={open} />
                      </button>
                    )}
                  />
                ) : (
                  <input
                    id="draft-state"
                    value={draftState}
                    onChange={e => setDraftState(e.target.value.toUpperCase())}
                    placeholder="UT"
                    maxLength={2}
                    aria-required="true"
                    style={inputStyle}
                  />
                )}
              </div>
            )}
            <div>
              <label htmlFor="draft-title" style={FORM_LABEL}>Title</label>
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
              <label htmlFor="draft-sponsor" style={FORM_LABEL}>Sponsor(s)</label>
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
              <label style={FORM_LABEL}>Summary</label>
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
              <label style={FORM_LABEL}>Bill text</label>
              <RichTextEditor
                onChange={html => setDraftText(html)}
                initialContent={draftText}
                placeholder="Paste or type the bill text…"
                enableMentions={false}
                allowEmpty
              />
            </div>
            <CustomFieldsSection
              collect
              fields={customFieldDefs}
              values={customFieldValues}
              isAdmin
              onUpdate={(fieldId, value) => setCustomFieldValues(prev => {
                const next = { ...prev }
                if (value === null) delete next[fieldId]
                else next[fieldId] = { value, setBy: null, updatedAt: '' }
                return next
              })}
            />
            {createDraftError && (
              <div style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{createDraftError}</div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <button
                {...createGate.buttonProps(handleCreateDraft)}
                style={actionBtnBlue(createGate.disabled)}
              >
                {creatingDraft ? 'Creating…' : 'Create draft'}
              </button>
              <button
                onClick={() => { setShowDraftForm(false); setDraftTitle(''); setDraftSummary(''); setDraftSponsor(''); setDraftText(''); setDraftNumber(''); setDraftYear(String(new Date().getFullYear())); setDraftState(''); setCustomFieldValues({}); setCreateDraftError(null) }}
                style={{ fontSize: fontSize.sm, color: color.textSecondary, background: 'none', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, padding: '8px 14px', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <MissingRequiredReason {...createGate.reasonProps} />
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
                      {/* Every row here is a draft by construction (this list comes from
                          /bills/drafts) — isDraft is a literal true, not a field read off d. */}
                      <BillBadge billNumber={d.billNumber} state={d.state} to={'/bills/' + d.id} isDraft />
                      <span style={{ fontSize: fontSize.sm, color: color.textSecondary, flex: 1 }}>{billDisplayTitle({ title: d.title, isDraft: true })}</span>
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
