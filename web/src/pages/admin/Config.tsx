import { useEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { actionRowStyle, actionRowStyleFirst, actionBtnBlue, actionBtnRed } from '../../styles/actionRow'
import { apiFetch, ApiError } from '../../lib/api'
import { normalizeOrgNoun, MAX_ORG_NOUN_LENGTH } from '../../lib/orgNoun'
import { exportAllData } from '../../lib/exportData'
import { SettingsNav } from '../../components/SettingsNav'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, FORM_LABEL, HELPER_TEXT, SR_ONLY } from '../../lib/textStyles'
import { TOOLTIP_STYLE, tooltipPosition, COUNT_BADGE } from '../../lib/chipStyles'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useAuth } from '../../hooks/useAuth'
import { useDemo } from '../../context/DemoContext'
import { ResizableTextarea } from '../../components/ResizableTextarea'
import { HintText } from '../../components/HintText'
import { DropIndicator, REORDER_KEY_HINT, ReorderLiveRegion, useDragReorder } from '../../components/dragReorder'
import { ReprocessScopeModal, type ReprocessScope } from '../../components/ReprocessScopeModal'
import { aiInstructionsChanged, configChanged, type ConfigSnapshot, centralSyncWarning, type KeywordResyncResult } from './aiConfig'
import { buildDefaultAiContext, buildDefaultRelevanceQuestion, isAiConfigDefault } from '../../../../shared/aiDefaults'
import { DEFAULT_TAXONOMY, serializeTaxonomy, type TaxonomyItem } from '../../../../shared/taxonomy'
import { useUnsavedRegistration } from '../../lib/unsavedText'
import TagTaxonomyTable from './TagTaxonomyTable'
import { rowsFromTaxonomy, rowsToTaxonomy, type TaxonomyRow } from './taxonomyRows'

type ConfigData = {
  keywords?: string[]
  association_name?: string
  org_noun?: string
  ai_context?: string
  relevance_question?: string
  tag_taxonomy?: { name: string; description?: string }[]
  matched_bills_count?: number
  prioritized_bills_count?: number
  new_match_min_relevance?: number
}

type CustomFieldDef = {
  id: string
  name: string
  slug: string | null
  type: 'binary' | 'dropdown' | 'text' | 'date'
  options: string[] | null
  multiple?: boolean
  displayOrder: number
  pinned: boolean
}

const PRESET_NOUNS = ['team', 'association', 'coalition'] as const

// One typographic treatment for all three AI-instruction editors. They are the
// same kind of field and must read as a set; they previously drifted (the tag
// box was monospace, none set a line-height, so each inherited a different
// family-dependent default). Height is the only thing that varies per field.
const aiTextareaStyle: React.CSSProperties = {
  fontSize: fontSize.sm,
  lineHeight: 1.5,
}

export function Config() {
  usePageTitle('Settings')
  const { user } = useAuth()
  const { demoLocked } = useDemo()
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  type ResettableField = 'aiContext' | 'relevanceQuestion' | 'tagTaxonomy' | 'keywords'
  // Captures the pre-reset value for each field so a "Reset to default"/"Clear"
  // click can be undone. Cleared for a field when: the field is edited manually
  // (resurrecting stale text would be worse than no undo), Undo is clicked, or a
  // save that covers that field succeeds.
  // undoValues[field] is a string for the three text fields and TaxonomyRow[]
  // for the taxonomy, because a row with a description and no name has no
  // string form — round-tripping it through one would delete what is being typed.
  const [undoValues, setUndoValues] =
    useState<Partial<Record<ResettableField, string | TaxonomyRow[]>>>({})

  const [keywords, setKeywords] = useState('')
  const [associationName, setAssociationName] = useState('')
  const [orgNoun, setOrgNoun] = useState<string>('team')
  const [nounChoice, setNounChoice] = useState<string>('team')
  const [customNoun, setCustomNoun] = useState<string>('')
  const [aiContext, setAiContext] = useState('')
  const [relevanceQuestion, setRelevanceQuestion] = useState('')
  const [taxonomyRows, setTaxonomyRows] = useState<TaxonomyRow[]>([])
  // The snapshot and the reprocess check both take strings. The rows are
  // canonical; this is their projection, and it is order-preserving on
  // purpose — see aiConfig.ts on why configChanged stays order-sensitive
  // while aiInstructionsChanged deliberately is not.
  const tagTaxonomy = serializeTaxonomy(rowsToTaxonomy(taxonomyRows))

  const [savingKeywords, setSavingKeywords] = useState(false)
  const [savedKeywords, setSavedKeywords] = useState(false)
  const [saveKeywordsError, setSaveKeywordsError] = useState<string | null>(null)
  const [syncKeywordsResult, setSyncKeywordsResult] = useState<KeywordResyncResult | null>(null)

  const [matchedBillsCount, setMatchedBillsCount] = useState<number | null>(null)
  const [prioritizedBillsCount, setPrioritizedBillsCount] = useState<number | null>(null)
  const [savingAi, setSavingAi] = useState(false)
  const [savedAi, setSavedAi] = useState(false)
  const [saveAiError, setSaveAiError] = useState<string | null>(null)
  const [saveAiResult, setSaveAiResult] = useState<{ queued: number } | null>(null)
  const [showScopeModal, setShowScopeModal] = useState(false)
  // Snapshot of every savable field, as last loaded or successfully saved.
  // Backs both the "did AI instructions change" reprocess-modal decision (via
  // aiInstructionsChanged, ai-fields subset) and the page's unsaved-changes
  // dirty check (all fields) below.
  const configSnapshot = useRef<ConfigSnapshot | null>(null)
  // The rows as last loaded or saved. The snapshot's string cannot stand in
  // for this: reverting the unsaved-changes guard through it would flatten a
  // multi-line description and drop a row that has one but no name yet.
  const savedTaxonomyRows = useRef<TaxonomyRow[]>([])

  const [newMatchMinRelevance, setNewMatchMinRelevance] = useState(0)
  const [savingNewMatch, setSavingNewMatch] = useState(false)
  const [savedNewMatch, setSavedNewMatch] = useState(false)
  const [saveNewMatchError, setSaveNewMatchError] = useState<string | null>(null)

  const [savingLabels, setSavingLabels] = useState(false)
  const [savedLabels, setSavedLabels] = useState(false)
  const [saveLabelsError, setSaveLabelsError] = useState<string | null>(null)

  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshAllResult, setRefreshAllResult] = useState<string | null>(null)

  const [rotatingCalSlug, setRotatingCalSlug] = useState(false)
  const [rotateCalResult, setRotateCalResult] = useState<string | null>(null)

  const [clearingInteractions, setClearingInteractions] = useState(false)
  const [clearResult, setClearResult] = useState<string | null>(null)

  const [exportFormat, setExportFormat] = useState<'json' | 'csv'>('csv')
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([])
  const [cfName, setCfName] = useState('')
  const [cfType, setCfType] = useState<'binary' | 'dropdown' | 'text' | 'date'>('text')
  const [cfOptions, setCfOptions] = useState('')
  const [cfMultiple, setCfMultiple] = useState(false)
  const [cfAdding, setCfAdding] = useState(false)
  const [cfEditing, setCfEditing] = useState<string | null>(null)
  const [cfEditName, setCfEditName] = useState('')
  const [cfEditOptions, setCfEditOptions] = useState('')
  const [cfEditMultiple, setCfEditMultiple] = useState(false)
  const [cfEditError, setCfEditError] = useState<string | null>(null)
  // Drag- and keyboard-reorder, shared with the tag table
  // (TagTaxonomyTable.tsx) and saved views (BillList/ViewSwitcher.tsx) — see
  // components/dragReorder.tsx. Persistence stays here, because it is this
  // list's own: a fire-and-forget PUT on the move. `to` arrives already
  // adjusted for the splice-out shift, so this is a plain remove-then-insert
  // with no arithmetic of its own — the downward-drag off-by-one that used to
  // live here is now unrepresentable.
  //
  // A pointer was the only way into this list before: dragging cannot be done
  // without one, so the grip is where the keyboard route has to live. It is
  // the ONLY keyboard route here (unlike the tag table, whose fields carry the
  // shortcut too), so the grip is a Tab stop — which the primitive makes it by
  // default. On a demo tenant the whole interaction is disabled, and a
  // disabled grip is neither focusable nor labelled with a shortcut it has
  // not got. A row being edited renders no grip at all (below), so it is no
  // more a keyboard target than it is a drag source.
  const cfDnd = useDragReorder({
    count: customFields.length,
    disabled: demoLocked,
    label: i => customFields[i].name,
    onReorder: (from, to) => {
      const reordered = [...customFields]
      const [moved] = reordered.splice(from, 1)
      reordered.splice(to, 0, moved)
      setCustomFields(reordered)
      apiFetch('/admin/custom-fields/reorder', {
        method: 'PUT',
        body: JSON.stringify({ order: reordered.map(f => f.id) }),
      }).catch(() => {})
    },
  })
  const [cfTooltip, setCfTooltip] = useState<{ key: string; x: number; y: number } | null>(null)

  useEffect(() => {
    apiFetch<CustomFieldDef[]>('/admin/custom-fields').then(setCustomFields).catch(() => {})
  }, [])

  useEffect(() => {
    apiFetch<ConfigData>('/admin/config')
      .then((data) => {
        const keywordsString = Array.isArray(data.keywords) && data.keywords.length > 0 ? data.keywords.join('\n') : ''
        setKeywords(keywordsString)
        const associationNameValue = data.association_name ?? ''
        setAssociationName(associationNameValue)
        const noun = data.org_noun ?? 'team'
        setOrgNoun(noun)
        if ((PRESET_NOUNS as readonly string[]).includes(noun)) { setNounChoice(noun); setCustomNoun('') }
        else { setNounChoice('custom'); setCustomNoun(noun) }
        const aiContextValue = data.ai_context ?? ''
        setAiContext(aiContextValue)
        const relevanceQuestionValue = data.relevance_question ?? ''
        setRelevanceQuestion(relevanceQuestionValue)
        const newMatchMinRelevanceValue = typeof data.new_match_min_relevance === 'number' ? data.new_match_min_relevance : 0
        setNewMatchMinRelevance(newMatchMinRelevanceValue)
        const loadedRows = rowsFromTaxonomy(
          Array.isArray(data.tag_taxonomy) ? data.tag_taxonomy as TaxonomyItem[] : [],
        )
        // Built from the same expression the page derives (rows -> rowsToTaxonomy
        // -> serializeTaxonomy), so the snapshot is definitionally equal to what
        // it will be compared against. Building this from the raw API array
        // instead would make configChanged permanently true whenever a stored
        // row has untrimmed data (an empty name, or whitespace-only fields) —
        // reachable via a direct API write even though not through this UI.
        const taxonomyString = serializeTaxonomy(rowsToTaxonomy(loadedRows))
        setTaxonomyRows(loadedRows)
        savedTaxonomyRows.current = loadedRows
        setMatchedBillsCount(data.matched_bills_count ?? null)
        setPrioritizedBillsCount(data.prioritized_bills_count ?? null)
        configSnapshot.current = {
          keywords: keywordsString,
          aiContext: aiContextValue,
          relevanceQuestion: relevanceQuestionValue,
          tagTaxonomy: taxonomyString,
          associationName: associationNameValue,
          orgNoun: noun,
          newMatchMinRelevance: newMatchMinRelevanceValue,
        }
      })
      .catch(() => setFetchError('Failed to load configuration.'))
      .finally(() => setLoading(false))
  }, [])

  // Merges a patch of newly-saved field(s) into the snapshot, leaving any
  // other (still-unsaved) fields' snapshot values untouched. current* falls
  // back to the live field values only in the not-yet-loaded edge case.
  function updateSnapshot(patch: Partial<ConfigSnapshot>) {
    configSnapshot.current = {
      keywords, aiContext, relevanceQuestion, tagTaxonomy, associationName, orgNoun, newMatchMinRelevance,
      ...configSnapshot.current,
      ...patch,
    }
  }

  function clearUndoValue(field: ResettableField) {
    setUndoValues(prev => {
      if (!(field in prev)) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  function resetToDefault(field: ResettableField) {
    // The taxonomy captures its rows rather than the derived string, so Undo
    // restores exactly what was on screen.
    const current: string | TaxonomyRow[] = field === 'tagTaxonomy'
      ? taxonomyRows
      : { aiContext, relevanceQuestion, keywords }[field]
    setUndoValues(prev => ({ ...prev, [field]: current }))
    if (field === 'aiContext') setAiContext('')
    if (field === 'relevanceQuestion') setRelevanceQuestion('')
    if (field === 'tagTaxonomy') setTaxonomyRows([])
    if (field === 'keywords') setKeywords('')
  }

  function undoReset(field: ResettableField) {
    const previous = undoValues[field]
    if (previous === undefined) return
    if (field === 'aiContext') setAiContext(previous as string)
    if (field === 'relevanceQuestion') setRelevanceQuestion(previous as string)
    if (field === 'tagTaxonomy') setTaxonomyRows(previous as TaxonomyRow[])
    if (field === 'keywords') setKeywords(previous as string)
    clearUndoValue(field)
  }

  // The outbound half of resetToDefault: puts the resolved default text INTO
  // the editor so a tenant can edit it, rather than retyping it from the
  // placeholder — which, being a placeholder, cannot even be selected. This is
  // an ordinary unsaved edit; nothing is stored until the tenant saves, and a
  // tenant who never clicks this keeps the blank-means-default behavior, so a
  // later association rename still flows through untouched.
  function seedFromDefault(field: ResettableField) {
    if (field === 'aiContext') setAiContext(buildDefaultAiContext(associationName))
    if (field === 'relevanceQuestion') setRelevanceQuestion(buildDefaultRelevanceQuestion(associationName))
    if (field === 'tagTaxonomy') {
      // Capture before overwriting, exactly as resetToDefault does. The seed
      // control shows whenever no row has a NAME, but a row can hold a typed
      // description with no name yet — the state the table is at that moment
      // flagging in red — and overwriting it with the default list would
      // destroy that text with nothing to get it back.
      setUndoValues(prev => ({ ...prev, tagTaxonomy: taxonomyRows }))
      setTaxonomyRows(rowsFromTaxonomy(DEFAULT_TAXONOMY))
      return
    }
    // Unreachable through the current UI for the two text fields:
    // renderResetControl only renders the seed button when undoValues[field]
    // is already undefined, so this call never has anything to clear today.
    // Kept anyway so that seeding can never strand a stale undo value if that
    // render ordering ever changes.
    clearUndoValue(field)
  }

  // Wraps a field's onChange so any manual edit (as opposed to the undoReset
  // restore above) drops that field's undo affordance.
  function editField(field: ResettableField, setter: (v: string) => void) {
    return (value: string) => {
      setter(value)
      clearUndoValue(field)
    }
  }

  async function handleSaveKeywords() {
    const newKeywords = keywords.split('\n').map((s) => s.trim()).filter(Boolean)

    // Fetch preview counts before asking the user to confirm
    let confirmMsg = 'Save and sync keywords?'
    if (newKeywords.length === 0) {
      // An empty list can only ever preview as all-zeros (see
      // /admin/keyword-resync-preview's early return), so skip the network
      // call and go straight to copy that describes what actually happens.
      // This is the most consequential action on the page — it turns off
      // future bill capture entirely — so it must not read as a no-op.
      confirmMsg = 'Save an empty keyword list?\n\nNo new bills will be captured for full analysis from now on. Bills already analyzed keep their summaries and stay in the tracker. Nothing will be downgraded.'
    } else {
      try {
        const preview = await apiFetch<{ wouldAdd: number; wouldDemote: number; wouldProtect: number }>(
          '/admin/keyword-resync-preview',
          { method: 'POST', body: JSON.stringify({ keywords: newKeywords }) }
        )
        const parts: string[] = []
        if (preview.wouldAdd > 0) {
          const b = preview.wouldAdd === 1 ? '1 additional bill' : `${preview.wouldAdd} additional bills`
          parts.push(`${b} will be fully analyzed`)
        }
        if (preview.wouldDemote > 0) {
          const b = preview.wouldDemote === 1 ? '1 bill' : `${preview.wouldDemote} bills`
          parts.push(`${b} will be downgraded to status monitoring`)
        }
        if (preview.wouldProtect > 0) {
          const b = preview.wouldProtect === 1 ? '1 matched bill has' : `${preview.wouldProtect} matched bills have`
          parts.push(`${b} existing engagement and will be kept as manual`)
        }
        if (parts.length > 0) {
          confirmMsg = `Save and sync keywords?\n\n${parts.map(p => '• ' + p).join('\n')}`
        } else {
          confirmMsg = 'Save keywords? No bills will be added or downgraded.'
        }
      } catch {
        // Preview failure is non-fatal — fall back to generic confirm
      }
    }

    if (!confirm(confirmMsg)) return
    setSavingKeywords(true)
    setSavedKeywords(false)
    setSaveKeywordsError(null)
    setSyncKeywordsResult(null)
    try {
      await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify({ keywords: newKeywords }),
      })
      try {
        const result = await apiFetch<KeywordResyncResult>('/admin/keyword-resync', { method: 'POST' })
        setSyncKeywordsResult(result)
        // Refresh the matched bill count shown in the AI rerun confirmation
        apiFetch<ConfigData>('/admin/config').then(d => { setMatchedBillsCount(d.matched_bills_count ?? null); setPrioritizedBillsCount(d.prioritized_bills_count ?? null) }).catch(() => {})
      } catch {
        // Resync failure is non-fatal — keywords were saved successfully
      }
      clearUndoValue('keywords')
      updateSnapshot({ keywords })
      setSavedKeywords(true)
      setTimeout(() => { setSavedKeywords(false); setSyncKeywordsResult(null) }, 4000)
    } catch (err) {
      setSaveKeywordsError(err instanceof ApiError ? err.message : 'Failed to save.')
    } finally {
      setSavingKeywords(false)
    }
  }

  async function handleSaveAi() {
    setSaveAiError(null)
    setSaveAiResult(null)

    // Blank means default: a table with no named rows saves null, so a tenant
    // who empties it goes back to inheriting DEFAULT_TAXONOMY rather than
    // storing an empty list.
    const taxonomy = rowsToTaxonomy(taxonomyRows)

    const current = { aiContext, relevanceQuestion, tagTaxonomy }
    // Resolve both sides against the snapshot's association name (the last
    // saved name), not the live associationName state: an unsaved edit to the
    // Labels field is not yet in force, so it must not affect this comparison.
    const changed = configSnapshot.current == null
      || aiInstructionsChanged(configSnapshot.current, current, configSnapshot.current.associationName)

    setSavingAi(true)
    setSavedAi(false)
    try {
      await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify({
          ai_context: aiContext.trim() || null,
          relevance_question: relevanceQuestion.trim() || null,
          tag_taxonomy: taxonomy.length > 0 ? taxonomy : null,
        }),
      })
      updateSnapshot({ aiContext, relevanceQuestion, tagTaxonomy })
      savedTaxonomyRows.current = taxonomyRows
      setUndoValues(prev => {
        const next = { ...prev }
        delete next.aiContext
        delete next.relevanceQuestion
        delete next.tagTaxonomy
        return next
      })
      setSavedAi(true)
      setTimeout(() => setSavedAi(false), 5000)
      if (changed && (matchedBillsCount ?? 0) > 0) setShowScopeModal(true)
    } catch (err) {
      setSaveAiError(err instanceof ApiError ? err.message : 'Failed to save.')
    } finally {
      setSavingAi(false)
    }
  }

  async function handleSaveNewMatch() {
    setSaveNewMatchError(null)
    const n = Number.isFinite(newMatchMinRelevance) && newMatchMinRelevance > 0 ? Math.min(10, Math.floor(newMatchMinRelevance)) : 0
    setSavingNewMatch(true)
    setSavedNewMatch(false)
    try {
      await apiFetch('/admin/config', { method: 'PUT', body: JSON.stringify({ new_match_min_relevance: n }) })
      setNewMatchMinRelevance(n)
      updateSnapshot({ newMatchMinRelevance: n })
      setSavedNewMatch(true)
      setTimeout(() => setSavedNewMatch(false), 5000)
    } catch (err) {
      setSaveNewMatchError(err instanceof ApiError ? err.message : 'Failed to save.')
    } finally {
      setSavingNewMatch(false)
    }
  }

  async function runReprocess(scope: ReprocessScope) {
    setShowScopeModal(false)
    setSaveAiResult(null)
    try {
      const result = await apiFetch<{ queued: number }>(`/admin/reprocess-llm-all?scope=${scope}`, { method: 'POST' })
      setSaveAiResult(result)
      setTimeout(() => setSaveAiResult(null), 5000)
    } catch {
      // Non-fatal: instructions were already saved.
    }
  }

  async function handleSaveLabels() {
    setSavingLabels(true)
    setSavedLabels(false)
    setSaveLabelsError(null)
    try {
      await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify({
          association_name: associationName.trim() || null,
          org_noun: normalizeOrgNoun(nounChoice === 'custom' ? customNoun : nounChoice),
        }),
      })
      updateSnapshot({ associationName, orgNoun })
      setSavedLabels(true)
      setTimeout(() => setSavedLabels(false), 2000)
    } catch (err) {
      setSaveLabelsError(err instanceof ApiError ? err.message : 'Failed to save.')
    } finally {
      setSavingLabels(false)
    }
  }

  async function handleRefreshMetadata() {
    if (!confirm('Refresh every bill\'s metadata (sponsors, history, status) from the central LegiScan cache? AI summaries will be left untouched.')) return
    setRefreshingAll(true)
    setRefreshAllResult(null)
    try {
      const result = await apiFetch<{ queued: number }>('/admin/refresh-metadata', { method: 'POST' })
      setRefreshAllResult(`Queued ${result.queued} bill${result.queued === 1 ? '' : 's'} for metadata refresh.`)
    } catch {
      setRefreshAllResult('Failed to start.')
    } finally {
      setRefreshingAll(false)
    }
  }

  async function handleRotateCalendarSlug() {
    if (!confirm('This will generate a new calendar subscription link and immediately disable the old one. Anyone currently subscribed will need to resubscribe. Continue?')) return
    setRotatingCalSlug(true)
    setRotateCalResult(null)
    try {
      await apiFetch('/calendar/regenerate-slug', { method: 'POST' })
      setRotateCalResult('Calendar link reset. Share the new link from the Subscribe button.')
      setTimeout(() => setRotateCalResult(null), 3000)
    } catch {
      setRotateCalResult('Failed to reset calendar link.')
    } finally {
      setRotatingCalSlug(false)
    }
  }

  async function handleClearInteractions() {
    if (demoLocked || user?.role !== 'owner') return
    const input = prompt('This will permanently delete all votes, comments, notes, official positions, bill priorities, and feed history. Type RESET to confirm.')
    if (input !== 'RESET') return
    setClearingInteractions(true)
    setClearResult(null)
    try {
      await apiFetch('/admin/clear-interactions', { method: 'POST' })
      setClearResult('Cleared.')
      setTimeout(() => setClearResult(null), 3000)
    } catch {
      setClearResult('Failed to clear.')
    } finally {
      setClearingInteractions(false)
    }
  }

  async function handleExport() {
    setExporting(true)
    setExportProgress('Starting…')
    setExportError(null)
    try {
      await exportAllData(exportFormat, (table, index, total) => {
        if (table === 'done') {
          setExportProgress('Building zip…')
        } else {
          setExportProgress(`Exporting ${table}… (${index + 1}/${total})`)
        }
      })
      setExportProgress(null)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed.')
      setExportProgress(null)
    } finally {
      setExporting(false)
    }
  }

  async function handleAddCustomField() {
    const name = cfName.trim()
    if (!name) return
    setCfAdding(true)
    try {
      const options = cfType === 'dropdown'
        ? cfOptions.split(',').map(s => s.trim()).filter(Boolean)
        : undefined
      const created = await apiFetch<CustomFieldDef>('/admin/custom-fields', {
        method: 'POST',
        body: JSON.stringify({ name, type: cfType, options, multiple: cfType === 'dropdown' ? cfMultiple : undefined }),
      })
      setCustomFields(prev => [...prev, created])
      setCfName('')
      setCfOptions('')
      setCfType('text')
      setCfMultiple(false)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to create field.')
    } finally {
      setCfAdding(false)
    }
  }

  async function handleDeleteCustomField(id: string) {
    if (!window.confirm('Delete this custom field? All values on all bills will be removed.')) return
    try {
      await apiFetch(`/admin/custom-fields/${id}`, { method: 'DELETE' })
      setCustomFields(prev => prev.filter(f => f.id !== id))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete field.')
    }
  }

  async function handleSaveCustomFieldEdit(id: string) {
    const field = customFields.find(f => f.id === id)
    if (!field) return
    setCfEditError(null)
    try {
      const body: Record<string, unknown> = {}
      const newName = cfEditName.trim()
      if (newName && newName !== field.name) body.name = newName
      if (field.type === 'dropdown') {
        const opts = cfEditOptions.split(',').map(s => s.trim()).filter(Boolean)
        body.options = opts
        if (cfEditMultiple !== (field.multiple ?? false)) body.multiple = cfEditMultiple
      }
      const newOpts = field.type === 'dropdown' ? cfEditOptions.split(',').map(s => s.trim()).filter(Boolean) : field.options
      await apiFetch(`/admin/custom-fields/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      setCustomFields(prev => prev.map(f => {
        if (f.id !== id) return f
        return {
          ...f,
          name: newName || f.name,
          options: newOpts,
          multiple: field.type === 'dropdown' ? cfEditMultiple : f.multiple,
        }
      }))
      setCfEditing(null)
    } catch (err) {
      if (err instanceof ApiError && err.message.toLowerCase().includes('multi_to_single_conflict')) {
        setCfEditError('Cannot switch to single-select: some bills have multiple values for this field. Clean them up first.')
      } else {
        const body = err instanceof ApiError ? (err as ApiError & { body?: { error?: string; billIds?: string[] } }).body : undefined
        if (body?.error === 'multi_to_single_conflict' && Array.isArray(body.billIds)) {
          setCfEditError(`Cannot switch to single-select: ${body.billIds.length} bill${body.billIds.length === 1 ? '' : 's'} have multiple values for this field. Clean them up first.`)
        } else {
          alert(err instanceof ApiError ? err.message : 'Failed to update field.')
        }
      }
    }
  }

  // Registers the page's savable fields with the app-wide unsaved-changes
  // guard (UnsavedTextProvider, mounted in AppLayout — Config renders as a
  // descendant route of it). Excludes custom fields (separate CRUD that saves
  // immediately) and transient UI state (export format, modals, tooltips).
  useUnsavedRegistration({
    isDirty: () => {
      const snap = configSnapshot.current
      if (!snap) return false
      return configChanged(snap, {
        keywords, aiContext, relevanceQuestion, tagTaxonomy, associationName, orgNoun, newMatchMinRelevance,
      })
    },
    reset: () => {
      const snap = configSnapshot.current
      if (!snap) return
      setKeywords(snap.keywords)
      setAiContext(snap.aiContext)
      setRelevanceQuestion(snap.relevanceQuestion)
      setTaxonomyRows(savedTaxonomyRows.current)
      setAssociationName(snap.associationName)
      setOrgNoun(snap.orgNoun)
      if ((PRESET_NOUNS as readonly string[]).includes(snap.orgNoun)) { setNounChoice(snap.orgNoun); setCustomNoun('') }
      else { setNounChoice('custom'); setCustomNoun(snap.orgNoun) }
      setNewMatchMinRelevance(snap.newMatchMinRelevance)
      // Fields are being force-reverted to their last-saved values, so any
      // pending "Undo a reset" affordance no longer applies to what's on screen.
      setUndoValues({})
    },
  })

  const labelStyle: React.CSSProperties = FORM_LABEL
  const hintStyle: React.CSSProperties = { ...HELPER_TEXT, marginTop: 4 }
  const inputStyle: React.CSSProperties = { width: '100%', fontSize: fontSize.sm, padding: '8px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, boxSizing: 'border-box', fontFamily: 'inherit' }
  const selectStyle: React.CSSProperties = { fontSize: fontSize.sm, padding: '8px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, boxSizing: 'border-box', fontFamily: 'inherit', color: color.textSlate, background: color.white }
  const resetBtnStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none', cursor: demoLocked ? 'not-allowed' : 'pointer', padding: 0, textDecoration: 'underline' }

  // Renders either "Undo" (if this field was just reset/cleared) or the
  // reset/clear trigger itself — mutually exclusive, same slot, same style.
  function renderResetControl(field: ResettableField, hasValue: boolean, label: string) {
    if (undoValues[field] !== undefined) {
      return (
        <button type='button' onClick={() => undoReset(field)} disabled={demoLocked} style={resetBtnStyle}>
          Undo
        </button>
      )
    }
    if (!hasValue) {
      // Allowlist rather than exclude: only these three fields have a seeder
      // wired up in seedFromDefault. A future ResettableField member falls
      // through to the disabled branch below instead of silently rendering a
      // seed button that does nothing when clicked.
      const seedable: ResettableField[] = ['aiContext', 'relevanceQuestion', 'tagTaxonomy']
      if (!seedable.includes(field)) return null
      return (
        <button type='button' onClick={() => seedFromDefault(field)} disabled={demoLocked} style={resetBtnStyle}>
          Start from default
        </button>
      )
    }
    return (
      <button type='button' onClick={() => resetToDefault(field)} disabled={demoLocked} style={resetBtnStyle}>
        {label}
      </button>
    )
  }

  if (fetchError) return <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}><SettingsNav /><div style={{ color: color.textErrorRed, fontSize: fontSize.sm, marginTop: 24 }}>{fetchError}</div></div>

  const sectionCard: React.CSSProperties = { ...CARD, padding: 24, marginBottom: 20 }
  const sectionTitle: React.CSSProperties = CARD_TITLE
  const sectionIntro: React.CSSProperties = { fontSize: fontSize.sm, color: color.textSecondary, lineHeight: 1.6, marginBottom: 20 }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <SettingsNav />
      {/* No single visible title represents this page as a whole (the sections below —
          Bill keywords, AI instructions, etc. — are co-equal, not a page title), so name
          it for screen readers with a visually-hidden <h1> instead. */}
      <h1 style={SR_ONLY}>Settings</h1>

      {demoLocked && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }}>
          This is a demo instance — settings are read-only.
        </div>
      )}

      <>

      {/* Bill keywords */}
      <div style={sectionCard}>
        <h2 style={sectionTitle}>Bill keywords</h2>
        <div style={sectionIntro}>
          All bills from particular legislative sessions are <em>monitored</em>: title, status, and the most recent action are refreshed multiple times daily from LegiScan. Bills that match the below keywords are <em>fully analyzed</em>, which adds full bill text, sponsors, complete action history, hearings, amendments, and supplementary documents — processed through AI for a summary, tags, and relevance score. (Admins can also manually select bills to be fully analyzed, even if those bills don't match keywords.)
        </div>

        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : (
          <>
            {!keywords.trim() && (
              <div style={{ background: color.bgAmberPriority, border: `1px solid ${color.borderYellow}`, borderRadius: radius.md, padding: '10px 14px', fontSize: fontSize.sm, color: color.textAmberWarning, marginBottom: 16 }}>
                No keywords configured — bills won't be automatically captured. Add at least one keyword to start receiving bills.
              </div>
            )}

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <label htmlFor="config-keywords" style={{ ...labelStyle, marginBottom: 0 }}>Keywords</label>
                {renderResetControl('keywords', !!keywords.trim(), 'Clear')}
              </div>
              <ResizableTextarea
                id="config-keywords"
                value={keywords}
                onChange={(e) => editField('keywords', setKeywords)(e.target.value)}
                initialHeight={160}
                minHeight={60}
                style={{ fontFamily: 'monospace', fontSize: fontSize.sm }}
              />
              <div style={hintStyle}>
                <HintText text={'One keyword or phrase per line. Matching is case-insensitive and checks bill titles and descriptions — a keyword matches if it appears anywhere in that text. Partial matches work: `reapportion` matches "reapportionment", "reapportioning". Multi-word phrases work: `board of canvassers` only matches that exact phrase.'} />
              </div>
            </div>

            <div style={actionRowStyle}>
              <button onClick={handleSaveKeywords} disabled={savingKeywords || demoLocked} style={actionBtnRed(savingKeywords || demoLocked)}>
                {savingKeywords ? 'Saving…' : 'Save keywords and sync'}
              </button>
              <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
                Saves keywords, queues new matches for <em>full analysis</em>, and downgrades bills that no longer match to <em>monitoring</em>. (Bills with existing interactions, positions, or that admins have manually selected for analysis are not downgraded.)
              </span>
              {savedKeywords && (
                <span style={{ fontSize: fontSize.sm, color: color.textSuccess, flexShrink: 0 }}>
                  {syncKeywordsResult && (syncKeywordsResult.queued > 0 || syncKeywordsResult.demoted > 0)
                    ? `Saved — ${[
                        syncKeywordsResult.queued > 0 ? `${syncKeywordsResult.queued} bill${syncKeywordsResult.queued !== 1 ? 's' : ''} queued for full analysis` : '',
                        syncKeywordsResult.demoted > 0 ? `${syncKeywordsResult.demoted} downgraded to status monitoring` : '',
                      ].filter(Boolean).join(', ')}`
                    : 'Saved'}
                </span>
              )}
              {savedKeywords && syncKeywordsResult && centralSyncWarning(syncKeywordsResult) && (
                <span style={{ fontSize: fontSize.sm, color: color.textErrorRed, flexShrink: 1 }}>
                  {centralSyncWarning(syncKeywordsResult)}
                </span>
              )}
              {saveKeywordsError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{saveKeywordsError}</span>}
            </div>
          </>
        )}
      </div>

      {/* AI instructions */}
      <div style={sectionCard}>
        <h2 style={sectionTitle}>AI instructions</h2>
        <div style={sectionIntro}>
          When a bill is fully analyzed, the AI reads its full text and produces a summary, a relevance score, and a set of tags. The instructions below control how it does that.
        </div>

        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <label htmlFor="config-ai-context" style={{ ...labelStyle, marginBottom: 0 }}>Bill summary</label>
                  {renderResetControl('aiContext', !!aiContext.trim(), 'Reset to default')}
                </div>
                <ResizableTextarea
                  id="config-ai-context"
                  value={aiContext}
                  onChange={(e) => editField('aiContext', setAiContext)(e.target.value)}
                  initialHeight={200}
                  minHeight={60}
                  style={aiTextareaStyle}
                  placeholder={buildDefaultAiContext(associationName)}
                />
                <div style={hintStyle}>System instructions sent to the AI for every bill. Controls the summary style and framing.</div>
                {isAiConfigDefault(aiContext) && (
                  <div style={hintStyle}>
                    Leaving this blank uses the generic instructions shown above. Personalizing them improves summaries and relevance scores.
                  </div>
                )}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <label htmlFor="config-relevance-question" style={{ ...labelStyle, marginBottom: 0 }}>Relevance score</label>
                  {renderResetControl('relevanceQuestion', !!relevanceQuestion.trim(), 'Reset to default')}
                </div>
                <ResizableTextarea
                  id="config-relevance-question"
                  value={relevanceQuestion}
                  onChange={(e) => editField('relevanceQuestion', setRelevanceQuestion)(e.target.value)}
                  initialHeight={120}
                  minHeight={60}
                  style={aiTextareaStyle}
                  placeholder={buildDefaultRelevanceQuestion(associationName)}
                />
                <div style={hintStyle}>Prompt sent to guide the AI in scoring each bill's relevance from 1–10.</div>
                {isAiConfigDefault(relevanceQuestion) && (
                  <div style={hintStyle}>
                    Leaving this blank uses the generic instructions shown above. Personalizing them improves summaries and relevance scores.
                  </div>
                )}
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                  <span id="config-tags-label" style={{ ...labelStyle, marginBottom: 0 }}>
                    Tags
                    <span data-testid="tag-count" style={{ ...COUNT_BADGE, marginLeft: 6 }}>
                      {rowsToTaxonomy(taxonomyRows).length}
                    </span>
                  </span>
                  {renderResetControl('tagTaxonomy', rowsToTaxonomy(taxonomyRows).length > 0, 'Clear all')}
                </div>
                {/* The tag table's grip is not a Tab stop, so unlike custom
                    fields nothing focusable advertises the shortcut on screen
                    — and at narrow widths mobile.css hides the grip outright.
                    Same sentence as custom fields, from the same constant, so
                    the two cannot come to describe the shortcut differently. */}
                <div style={{ ...hintStyle, marginBottom: 6 }}>
                  Drag a handle to reorder, or focus a tag's name or description. {REORDER_KEY_HINT}
                </div>
                <div role="group" aria-labelledby="config-tags-label">
                  <TagTaxonomyTable
                    rows={taxonomyRows}
                    idPrefix="config-tags"
                    onChange={rows => { setTaxonomyRows(rows); clearUndoValue('tagTaxonomy') }}
                    onSort={rows => {
                      // A sort discards a hand-curated order, so it must be
                      // undoable through the Tags field's existing Undo
                      // affordance — the same capture-before-overwrite
                      // resetToDefault and seedFromDefault already use.
                      //
                      // Unlike those two, the sort trigger stays on screen
                      // after it fires, so nothing stops a second click.
                      // Capturing unconditionally would let that second
                      // click overwrite the captured value with the
                      // already-sorted rows, silently replacing "undo back
                      // to my hand-curated order" with "undo back to my
                      // first sort." Capturing only when nothing is captured
                      // yet keeps Undo meaning "back to before I started
                      // sorting" no matter how many times the header is
                      // clicked in a row. handleSaveAi deletes
                      // undoValues.tagTaxonomy on a successful save, and
                      // undoReset clears it too, so this guard can never
                      // strand a stale value.
                      setUndoValues(prev => 'tagTaxonomy' in prev ? prev : { ...prev, tagTaxonomy: taxonomyRows })
                      setTaxonomyRows(rows)
                    }}
                  />
                </div>
                <div style={hintStyle}>
                  The AI will only assign tags from this list. A description is optional
                  context for the model — it never appears in the app.
                </div>
                {isAiConfigDefault(tagTaxonomy) && (
                  <div style={hintStyle}>
                    Leaving this blank uses the generic tag list. Personalizing it keeps tags
                    meaningful to your {orgNoun}'s own priorities and issue areas.
                  </div>
                )}
              </div>
            </div>

            <div style={actionRowStyle}>
              <button onClick={handleSaveAi} disabled={savingAi || demoLocked} style={actionBtnBlue(savingAi || demoLocked)}>
                {savingAi ? 'Saving…' : 'Save AI instructions'}
              </button>
              {savedAi && (
                <span style={{ fontSize: fontSize.sm, color: color.textSuccess, flexShrink: 0 }}>
                  {saveAiResult ? `Saved — ${saveAiResult.queued} bill${saveAiResult.queued !== 1 ? 's' : ''} queued` : 'Saved'}
                </span>
              )}
              {saveAiError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{saveAiError}</span>}
            </div>
          </>
        )}
      </div>

      {/* New matches */}
      <div style={sectionCard}>
        <h2 style={sectionTitle}>New matches</h2>
        <div style={sectionIntro}>
          Newly keyword-matched bills appear in the “New matches” list on the Bills page, awaiting a priority decision. Raise the minimum relevance score to hide low-relevance matches from that list.
        </div>
        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : (
          <>
            <style>{`
              input[type=range].config-relevance-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 14px; }
              input[type=range].config-relevance-slider::-webkit-slider-runnable-track {
                background: linear-gradient(to right, ${color.accentAmber} 0%, ${color.accentAmber} ${(newMatchMinRelevance / 10) * 100}%, ${color.borderDefault} ${(newMatchMinRelevance / 10) * 100}%, ${color.borderDefault} 100%);
                height: 4px; border-radius: 4px;
              }
              input[type=range].config-relevance-slider::-webkit-slider-thumb {
                -webkit-appearance: none; width: 14px; height: 14px; background: ${color.accentAmber};
                border-radius: 50%; margin-top: -5px; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,0.2);
              }
              input[type=range].config-relevance-slider::-moz-range-track { background: ${color.borderDefault}; height: 4px; border-radius: 4px; }
              input[type=range].config-relevance-slider::-moz-range-progress { background: ${color.accentAmber}; height: 4px; border-radius: 4px 0 0 4px; }
              input[type=range].config-relevance-slider::-moz-range-thumb { background: ${color.accentAmber}; border-radius: 50%; width: 14px; height: 14px; border: none; cursor: pointer; }
            `}</style>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: newMatchMinRelevance > 0 ? color.bgInfo : color.white,
              border: `1px solid ${newMatchMinRelevance > 0 ? color.tagBorderBlue : color.borderDefault}`,
              borderRadius: radius.md, padding: '6px 10px',
            }}>
              <label style={{ fontSize: fontSize.sm, whiteSpace: 'nowrap', color: newMatchMinRelevance > 0 ? color.linkBlue : color.textSlate, fontWeight: newMatchMinRelevance > 0 ? fontWeight.medium : fontWeight.normal }}>
                Minimum relevance: <span style={{ display: 'inline-block', width: 26, textAlign: 'left' }}>{newMatchMinRelevance === 0 ? 'All' : newMatchMinRelevance < 10 ? `${newMatchMinRelevance}+` : '10'}</span>
              </label>
              <input
                type='range'
                className='config-relevance-slider'
                min={0}
                max={10}
                step={1}
                value={newMatchMinRelevance}
                onChange={(e) => setNewMatchMinRelevance(Number(e.target.value))}
                style={{ width: 120, cursor: 'pointer' }}
              />
            </div>
            <div style={{ ...hintStyle, marginTop: 8 }}>Relevance runs 1–10. “All” (0) surfaces every match; higher values hide lower-relevance bills.</div>
            <div style={actionRowStyle}>
              <button onClick={handleSaveNewMatch} disabled={savingNewMatch || demoLocked} style={actionBtnBlue(savingNewMatch || demoLocked)}>
                {savingNewMatch ? 'Saving…' : 'Save'}
              </button>
              {savedNewMatch && <span style={{ fontSize: fontSize.sm, color: color.textSuccess, flexShrink: 0 }}>Saved</span>}
              {saveNewMatchError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{saveNewMatchError}</span>}
            </div>
          </>
        )}
      </div>

      {/* Custom fields */}
      <div style={sectionCard}>
        <h2 style={sectionTitle}>Custom fields</h2>
        <div style={sectionIntro}>
          Define fields that appear on every bill detail page. Admins and owners can set values per bill.
          Fields are hidden from members until at least one value is set. Drag a handle to
          reorder, or focus one. {REORDER_KEY_HINT}
        </div>

        {/* Field list */}
        {customFields.length > 0 && (
          <div style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden', marginBottom: 14, position: 'relative' }}>
            {/* First child, not last: the tail drop zone below has to stay
                the last thing in this container. SR_ONLY is absolutely
                positioned, and this container is the nearest relative one. */}
            <ReorderLiveRegion announcement={cfDnd.announcement} />
            {customFields.map((field, i) => (
              <div key={field.id}>
                {cfDnd.indicatorBefore(i) && <DropIndicator />}
                {/* The drop target is the whole row, but `draggable` is on the
                    grip alone (below). With it on the row the grip was purely
                    decorative and the browser's drag image was the entire row —
                    the "whole row moving" feel neither of the other two lists
                    has. The source row's dimming is state-driven too, rather
                    than a style.opacity mutation on the DOM node, so React is
                    never rendering against a value it does not own. */}
                <div
                  {...cfDnd.dropProps(i)}
                  style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', background: color.white, borderTop: i > 0 ? `1px solid ${color.surfaceMuted}` : 'none', gap: 10, cursor: 'default', ...cfDnd.sourceStyle(i) }}
                >
                  {cfEditing === field.id ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <input
                        type="text"
                        value={cfEditName}
                        onChange={e => setCfEditName(e.target.value)}
                        style={{ fontSize: fontSize.sm, padding: '5px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, fontFamily: 'inherit' }}
                      />
                      {field.type === 'dropdown' && (
                        <>
                          <input
                            type="text"
                            value={cfEditOptions}
                            onChange={e => setCfEditOptions(e.target.value)}
                            placeholder="Option 1, Option 2, Option 3"
                            style={{ fontSize: fontSize.sm, padding: '5px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, fontFamily: 'inherit' }}
                          />
                          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: fontSize.sm, color: color.textSlate, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={cfEditMultiple}
                              onChange={e => setCfEditMultiple(e.target.checked)}
                              style={{ margin: 0, accentColor: color.accentBlue }}
                            />
                            Allow multiple selections
                          </label>
                        </>
                      )}
                      {cfEditError && (
                        <div style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{cfEditError}</div>
                      )}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => handleSaveCustomFieldEdit(field.id)} disabled={demoLocked} style={{ fontSize: fontSize.sm, padding: '3px 10px', borderRadius: radius.sm, border: 'none', background: demoLocked ? color.borderDefault : color.accentBlue, color: demoLocked ? color.textMuted : color.white, cursor: demoLocked ? 'not-allowed' : 'pointer' }}>Save</button>
                        <button onClick={() => { setCfEditing(null); setCfEditError(null) }} style={{ fontSize: fontSize.sm, padding: '3px 10px', borderRadius: radius.sm, border: `1px solid ${color.borderDefault}`, background: color.white, color: color.textSlate, cursor: 'pointer' }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span
                        {...cfDnd.gripProps(i)}
                        style={{ fontSize: fontSize.base, color: demoLocked ? color.borderDefault : color.borderStrong, cursor: demoLocked ? 'not-allowed' : 'grab', userSelect: 'none', flexShrink: 0 }}
                      >⠿</span>
                      <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>{field.name}</span>
                      {/* Hover handlers sit on the wrapper, not the button. A disabled
                          button fires no pointer events, so on a demo tenant — where
                          every one of these is disabled — the tooltip explaining the
                          control would never appear, which is exactly when a visitor
                          most needs it. */}
                      <span
                        onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCfTooltip({ key: `${field.id}-edit`, x: r.left + r.width / 2, y: r.top }) }}
                        onMouseLeave={() => setCfTooltip(null)}
                        style={{ display: 'inline-flex', alignItems: 'center' }}
                      >
                        <button
                          onClick={demoLocked ? undefined : () => {
                            setCfEditing(field.id)
                            setCfEditName(field.name)
                            setCfEditOptions(field.type === 'dropdown' && field.options ? field.options.join(', ') : '')
                            setCfEditMultiple(field.multiple ?? false)
                            setCfEditError(null)
                          }}
                          disabled={demoLocked}
                          style={{ background: 'none', border: 'none', color: demoLocked ? color.borderDefault : color.textMuted, cursor: demoLocked ? 'not-allowed' : 'pointer', padding: '2px', display: 'inline-flex', alignItems: 'center' }}
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>edit</span>
                        </button>
                      </span>
                      <span style={{ flex: 1 }} />
                      {field.type === 'text' && (
                        <span
                          onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCfTooltip({ key: `${field.id}-pin`, x: r.left + r.width / 2, y: r.top }) }}
                          onMouseLeave={() => setCfTooltip(null)}
                          style={{ display: 'inline-flex', alignItems: 'center' }}
                        >
                        <button
                          onClick={demoLocked ? undefined : async () => {
                            const newPinned = !field.pinned
                            await apiFetch(`/admin/custom-fields/${field.id}`, {
                              method: 'PUT',
                              body: JSON.stringify({ pinned: newPinned }),
                            })
                            setCustomFields(prev => prev.map(f => f.id === field.id ? { ...f, pinned: newPinned } : f))
                          }}
                          disabled={demoLocked}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: demoLocked ? 'not-allowed' : 'pointer',
                            padding: 2,
                            display: 'flex',
                            alignItems: 'center',
                            color: field.pinned ? color.accentBlue : color.borderStrong,
                          }}
                        >
                          <span
                            className="material-symbols-outlined"
                            style={{
                              fontSize: fontSize.xl,
                              fontVariationSettings: field.pinned ? "'FILL' 1" : "'FILL' 0",
                              transform: 'rotate(45deg)',
                              display: 'inline-block',
                            }}
                          >
                            keep
                          </span>
                        </button>
                        </span>
                      )}
                      <span
                        onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCfTooltip({ key: `${field.id}-type`, x: r.left + r.width / 2, y: r.top }) }}
                        onMouseLeave={() => setCfTooltip(null)}
                        style={{
                          fontSize: fontSize.sm, padding: '2px 8px', borderRadius: radius.lg, fontWeight: fontWeight.medium,
                          display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'default',
                          ...(field.type === 'binary' ? { background: color.bgAmberPriority, color: color.textAmberDark }
                            : field.type === 'dropdown' ? { background: color.bgBlueChip, color: color.linkBlue }
                            // countChipBg, not surfaceMuted: the near-white surfaceMuted fill
                            // made this chip vanish against the white card while its amber/blue/
                            // violet siblings read as chips.
                            : field.type === 'text' ? { background: color.countChipBg, color: color.textSlate500 }
                            : { background: color.bgVioletChip, color: color.textVioletChip })
                        }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>
                          {field.type === 'binary' ? 'check_box' : field.type === 'dropdown' ? 'list' : field.type === 'text' ? 'notes' : 'event'}
                        </span>
                        {field.type === 'binary' ? 'Checkbox'
                          : field.type === 'dropdown' ? `${field.multiple ? 'Multi-dropdown' : 'Dropdown'} · ${field.options?.length ?? 0} options`
                          : field.type === 'text' ? 'Text'
                          : 'Date'}
                      </span>
                      <button
                        onClick={demoLocked ? undefined : () => handleDeleteCustomField(field.id)}
                        disabled={demoLocked}
                        style={{ background: 'none', border: 'none', color: demoLocked ? color.borderDefault : color.textErrorRed, cursor: demoLocked ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                        title={demoLocked ? undefined : `Delete "${field.name}"`}
                      ><span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>delete</span></button>
                      {cfTooltip && cfTooltip.key.startsWith(field.id) && (() => {
                        const el = cfTooltip.key.slice(field.id.length + 1)
                        const text = el === 'pin'
                          ? (field.pinned
                            ? 'Unpin this field. Pinned fields, when they are filled out, appear above the AI summary on bill detail pages.'
                            : 'Pin this field. Pinned fields, when they are filled out, appear above the AI summary on bill detail pages.')
                          : el === 'edit'
                            ? (demoLocked ? 'Rename this field, or change its dropdown options — locked in the demo' : 'Edit')
                            : (field.type === 'binary' ? 'Yes/no toggle'
                              : field.type === 'dropdown' ? 'Pick from a predefined list'
                              : field.type === 'text' ? 'Free-form text with markdown; URLs auto-linked'
                              : 'Date picker')
                        return (
                          <span style={{ ...tooltipPosition(cfTooltip), ...TOOLTIP_STYLE, maxWidth: 280, whiteSpace: 'normal' }}>
                            {text}
                          </span>
                        )
                      })()}
                    </>
                  )}
                </div>
              </div>
            ))}
            {/* The append-at-end zone, which insert-before semantics cannot
                otherwise reach. It is not a special case in the primitive:
                it is simply slot `count`. */}
            <div {...cfDnd.tailDropProps()} style={{ minHeight: 8 }}>
              {cfDnd.indicatorAtEnd() && <DropIndicator />}
            </div>
          </div>
        )}
        {customFields.length === 0 && (
          <div style={{ fontSize: fontSize.sm, color: color.textMuted, marginBottom: 14 }}>No custom fields defined yet.</div>
        )}

        {/* Add new field form */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 2 }}>Name</div>
            <input
              type="text"
              value={cfName}
              onChange={e => setCfName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddCustomField()}
              placeholder="Field name…"
              style={{ fontSize: fontSize.sm, padding: '5px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, width: 180, fontFamily: 'inherit', color: color.textSlate }}
            />
          </div>
          <div>
            <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 2 }}>Type</div>
            <select
              value={cfType}
              onChange={e => setCfType(e.target.value as typeof cfType)}
              style={{ ...selectStyle, width: '100%' }}
            >
              <option value="text">Text</option>
              <option value="binary">Checkbox</option>
              <option value="dropdown">Dropdown</option>
              <option value="date">Date</option>
            </select>
          </div>
          {cfType === 'dropdown' && (
            <>
              <div>
                <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 2 }}>Options (comma-separated)</div>
                <input
                  type="text"
                  value={cfOptions}
                  onChange={e => setCfOptions(e.target.value)}
                  placeholder="Option 1, Option 2, Option 3"
                  style={{ fontSize: fontSize.sm, padding: '5px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, width: 260, fontFamily: 'inherit', color: color.textSlate }}
                />
              </div>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: fontSize.sm, color: color.textSlate, cursor: 'pointer', paddingBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={cfMultiple}
                  onChange={e => setCfMultiple(e.target.checked)}
                  style={{ margin: 0, accentColor: color.accentBlue }}
                />
                Allow multiple selections
              </label>
            </>
          )}
          <button
            onClick={handleAddCustomField}
            disabled={cfAdding || !cfName.trim() || demoLocked}
            style={{ background: cfName.trim() && !demoLocked ? color.accentBlue : color.borderDefault, color: cfName.trim() && !demoLocked ? color.white : color.textMuted, border: 'none', borderRadius: radius.md, padding: '8px 20px', cursor: cfName.trim() && !demoLocked ? 'pointer' : 'not-allowed', fontSize: fontSize.sm, fontWeight: fontWeight.medium }}
          >
            {cfAdding ? 'Adding…' : 'Add field'}
          </button>
        </div>

      </div>

      {/* Labels */}
      <div style={sectionCard}>
        <h2 style={sectionTitle}>Labels</h2>
        <div style={sectionIntro}>
          Display labels shown throughout the app. These are cosmetic — changing them doesn't affect any bill data.
        </div>
        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div>
                <label htmlFor="config-association-name" style={labelStyle}>Group name</label>
                <input id="config-association-name" value={associationName} onChange={(e) => setAssociationName(e.target.value)} style={inputStyle} placeholder="e.g. Prairie Policy Alliance" />
                <div style={hintStyle}>Shown in the top-left of the sidebar.</div>
              </div>
              <div>
                <label htmlFor="config-noun-choice" style={labelStyle}>What you call your group</label>
                <select
                  id="config-noun-choice"
                  value={nounChoice}
                  onChange={(e) => {
                    const v = e.target.value
                    setNounChoice(v)
                    if (v === 'custom') { setOrgNoun(normalizeOrgNoun(customNoun)) }
                    else { setOrgNoun(v); setCustomNoun('') }
                  }}
                  style={{ ...selectStyle, width: '100%' }}
                >
                  <option value="team">Team</option>
                  <option value="association">Association</option>
                  <option value="coalition">Coalition</option>
                  <option value="custom">Custom…</option>
                </select>
                {nounChoice === 'custom' && (
                  <input
                    value={customNoun}
                    onChange={(e) => { setCustomNoun(e.target.value); setOrgNoun(normalizeOrgNoun(e.target.value)) }}
                    style={{ ...inputStyle, marginTop: 8 }}
                    placeholder="e.g. league, network, caucus"
                    maxLength={MAX_ORG_NOUN_LENGTH}
                  />
                )}
                <div style={hintStyle}>The word for your group in copy like "your {orgNoun}'s position." Used throughout the app.</div>
              </div>
            </div>

            <div style={actionRowStyle}>
              <button onClick={handleSaveLabels} disabled={savingLabels || demoLocked} style={actionBtnBlue(savingLabels || demoLocked)}>
                {savingLabels ? 'Saving…' : 'Save'}
              </button>
              {savedLabels && <span style={{ fontSize: fontSize.sm, color: color.textSuccess }}>Saved</span>}
              {saveLabelsError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{saveLabelsError}</span>}
            </div>
          </>
        )}
      </div>

      {showScopeModal && (
        <ReprocessScopeModal
          matchedBillsCount={matchedBillsCount}
          prioritizedBillsCount={prioritizedBillsCount}
          onChoose={runReprocess}
          onDismiss={() => setShowScopeModal(false)}
        />
      )}

      {/* Additional operations */}
      <div style={{ ...sectionCard, marginBottom: 0 }}>
        <h2 style={sectionTitle}>Additional operations</h2>

        <div style={actionRowStyleFirst}>
          <div
            role="button"
            tabIndex={0}
            aria-disabled={exporting || demoLocked}
            onClick={exporting || demoLocked ? undefined : handleExport}
            onKeyDown={(e) => {
              if (exporting || demoLocked) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleExport()
              }
            }}
            style={{
              width: 224, flexShrink: 0, borderRadius: radius.md, padding: '8px 14px',
              background: demoLocked ? color.borderDefault : exporting ? color.accentBlueMuted : color.accentBlue,
              color: demoLocked ? color.textMuted : color.white,
              cursor: exporting || demoLocked ? 'not-allowed' : 'pointer',
              fontSize: fontSize.sm, fontWeight: fontWeight.medium, lineHeight: 1.4,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              userSelect: 'none',
            }}
          >
            {exporting ? (exportProgress ?? 'Exporting…') : (
              <>
                Download all data as
                <select
                  value={exportFormat}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => e.stopPropagation()}
                  onChange={e => { e.stopPropagation(); setExportFormat(e.target.value as 'csv' | 'json') }}
                  style={{
                    background: 'transparent', color: color.white, border: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.6)',
                    fontSize: fontSize.sm, fontWeight: fontWeight.semibold, cursor: 'pointer',
                    padding: 0, outline: 'none', fontFamily: 'inherit',
                  }}
                >
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                </select>
              </>
            )}
          </div>
          <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
            Downloads a zip of every bill you track, have analyzed with AI, have prioritized, or that has any engagement — votes, positions, comments, or notes. The zip also contains data on members, votes, positions, comments, personal notes, custom fields, calendar events, and bill amendments, supplements, and roll-call votes. Bills that have not been analyzed and have no priority or engagement are excluded. Full bill text is also excluded; access that text via the state legislature links in the export.
          </span>
          {exportError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed, flexShrink: 0 }}>{exportError}</span>}
        </div>

        <div style={actionRowStyle}>
          <button onClick={handleRefreshMetadata} disabled={refreshingAll || demoLocked} style={actionBtnRed(refreshingAll || demoLocked)}>
            {refreshingAll ? 'Working…' : 'Refresh bill metadata'}
          </button>
          <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
            Refreshes every bill's sponsors, committee, history, and status from the central LegiScan cache. AI summaries are not touched. Use if bill details look stale.
          </span>
          {refreshAllResult && <span style={{ fontSize: fontSize.sm, color: color.textSecondary, flexShrink: 0 }}>{refreshAllResult}</span>}
        </div>

        {(user?.role === 'admin' || user?.role === 'owner') && (
          <div style={actionRowStyle}>
            <button onClick={handleRotateCalendarSlug} disabled={rotatingCalSlug || demoLocked} style={actionBtnRed(rotatingCalSlug || demoLocked)}>
              {rotatingCalSlug ? 'Resetting…' : 'Reset calendar link'}
            </button>
            <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
              Generates a new calendar subscription link and immediately disables the old one. Use this if the current link may have been shared with someone who should no longer have access.
            </span>
            {rotateCalResult && <span style={{ fontSize: fontSize.sm, color: rotateCalResult.startsWith('Failed') ? color.textErrorRed : color.textSecondary, flexShrink: 0 }}>{rotateCalResult}</span>}
          </div>
        )}

        {(user?.role === 'admin' || user?.role === 'owner') && (
          <div style={actionRowStyle}>
            <button onClick={handleClearInteractions} disabled={clearingInteractions || demoLocked || user?.role !== 'owner'} style={actionBtnRed(clearingInteractions || demoLocked || user?.role !== 'owner')}>
              {clearingInteractions ? 'Clearing…' : 'Clear all member interactions'}
            </button>
            <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
              Permanently deletes all votes, comments, notes, official positions, bill priorities, and feed history. Members, bills, and AI summaries are kept. <strong>Only owners can do this. It cannot be undone.</strong>
            </span>
            {clearResult && <span style={{ fontSize: fontSize.sm, color: clearResult === 'Cleared.' ? color.textSuccess : color.textErrorRed, flexShrink: 0 }}>{clearResult}</span>}
          </div>
        )}

      </div>

      </>

    </div>
  )
}
