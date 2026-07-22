import { useEffect, useRef, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { actionRowStyle, actionRowStyleFirst, actionBtnBlue, actionBtnRed } from '../../styles/actionRow'
import { apiFetch, ApiError } from '../../lib/api'
import { normalizeOrgNoun, MAX_ORG_NOUN_LENGTH } from '../../lib/orgNoun'
import { exportAllData } from '../../lib/exportData'
import { SettingsNav } from '../../components/SettingsNav'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, FORM_LABEL, HELPER_TEXT, SR_ONLY } from '../../lib/textStyles'
import { TOOLTIP_STYLE, tooltipPosition } from '../../lib/chipStyles'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useAuth } from '../../hooks/useAuth'
import { useDemo } from '../../context/DemoContext'
import { ResizableTextarea } from '../../components/ResizableTextarea'
import { HintText } from '../../components/HintText'
import { ReprocessScopeModal, type ReprocessScope } from '../../components/ReprocessScopeModal'
import { parseTagTaxonomy, aiInstructionsChanged } from './aiConfig'

type ConfigData = {
  keywords?: string[]
  association_name?: string
  org_noun?: string
  ai_context?: string
  relevance_question?: string
  tag_taxonomy?: { name: string; description?: string }[]
  instance_preset?: string
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

type PresetFull = {
  slug: string
  name: string
  description: string
  aiContext: string
  relevanceQuestion: string
  taxonomy: { name: string; description?: string }[]
  keywords: string[]
}

const DEFAULT_AI_CONTEXT = `You are analyzing a bill for a policy organization.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number (e.g. "Requires all counties to...", "Establishes a new procedure for...", "Prohibits local governments from..."). Be concise and proportional to the bill's complexity — a simple or narrow amendment warrants 1–2 sentences; a multi-part or substantive bill may warrant a short paragraph.`

const DEFAULT_RELEVANCE_QUESTION = "Rate how relevant this bill is to the organization's legislative priorities."

const DEFAULT_TAXONOMY = [
  'Health & Healthcare', 'Education', 'Elections & Voting', 'Housing & Land Use',
  'Transportation & Infrastructure', 'Environment & Natural Resources',
  'Criminal Justice & Public Safety', 'Taxation & Revenue', 'Labor & Employment',
  'Business & Economic Development', 'Social Services & Human Services',
  'Courts & Civil Procedure', 'State Government & Administration',
  'Local Government', 'Agriculture & Rural Affairs',
].join('\n')

const PRESET_NOUNS = ['team', 'association', 'coalition'] as const

export function Config() {
  usePageTitle('Settings')
  const { user } = useAuth()
  const { demoLocked } = useDemo()
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [keywords, setKeywords] = useState('')
  const [associationName, setAssociationName] = useState('')
  const [orgNoun, setOrgNoun] = useState<string>('team')
  const [nounChoice, setNounChoice] = useState<string>('team')
  const [customNoun, setCustomNoun] = useState<string>('')
  const [aiContext, setAiContext] = useState('')
  const [relevanceQuestion, setRelevanceQuestion] = useState('')
  const [tagTaxonomy, setTagTaxonomy] = useState('')

  const [instancePreset, setInstancePreset] = useState<string | null>(null)
  const [presets, setPresets] = useState<PresetFull[]>([])
  const [selectedPresetSlug, setSelectedPresetSlug] = useState('')
  const [applyingPreset, setApplyingPreset] = useState(false)
  const [applyPresetResult, setApplyPresetResult] = useState<string | null>(null)

  const [savingKeywords, setSavingKeywords] = useState(false)
  const [savedKeywords, setSavedKeywords] = useState(false)
  const [saveKeywordsError, setSaveKeywordsError] = useState<string | null>(null)
  const [syncKeywordsResult, setSyncKeywordsResult] = useState<{ queued: number; demoted: number; protectedAsManual: number } | null>(null)

  const [matchedBillsCount, setMatchedBillsCount] = useState<number | null>(null)
  const [prioritizedBillsCount, setPrioritizedBillsCount] = useState<number | null>(null)
  const [savingAi, setSavingAi] = useState(false)
  const [savedAi, setSavedAi] = useState(false)
  const [saveAiError, setSaveAiError] = useState<string | null>(null)
  const [saveAiResult, setSaveAiResult] = useState<{ queued: number } | null>(null)
  const [showScopeModal, setShowScopeModal] = useState(false)
  const aiSnapshot = useRef<{ aiContext: string; relevanceQuestion: string; tagTaxonomy: string } | null>(null)

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
  const [cfDragFrom, setCfDragFrom] = useState<number | null>(null)
  const [cfDragOver, setCfDragOver] = useState<number | null>(null)
  const [cfTooltip, setCfTooltip] = useState<{ key: string; x: number; y: number } | null>(null)

  useEffect(() => {
    apiFetch<CustomFieldDef[]>('/admin/custom-fields').then(setCustomFields).catch(() => {})
  }, [])

  useEffect(() => {
    Promise.all([
      apiFetch<ConfigData>('/admin/config'),
      apiFetch<PresetFull[]>('/admin/presets'),
    ])
      .then(([data, presetList]) => {
        setKeywords(Array.isArray(data.keywords) && data.keywords.length > 0 ? data.keywords.join('\n') : '')
        setAssociationName(data.association_name ?? '')
        const noun = data.org_noun ?? 'team'
        setOrgNoun(noun)
        if ((PRESET_NOUNS as readonly string[]).includes(noun)) { setNounChoice(noun); setCustomNoun('') }
        else { setNounChoice('custom'); setCustomNoun(noun) }
        setAiContext(data.ai_context ?? '')
        setRelevanceQuestion(data.relevance_question ?? '')
        setNewMatchMinRelevance(typeof data.new_match_min_relevance === 'number' ? data.new_match_min_relevance : 0)
        const taxonomyString = (Array.isArray(data.tag_taxonomy) && data.tag_taxonomy.length > 0
          ? data.tag_taxonomy
              .map((t: { name: string; description?: string }) => t.description ? `${t.name}: ${t.description}` : t.name)
              .join('\n')
          : '')
        setTagTaxonomy(taxonomyString)
        setInstancePreset(data.instance_preset ?? null)
        setMatchedBillsCount(data.matched_bills_count ?? null)
        setPrioritizedBillsCount(data.prioritized_bills_count ?? null)
        aiSnapshot.current = {
          aiContext: data.ai_context ?? '',
          relevanceQuestion: data.relevance_question ?? '',
          tagTaxonomy: taxonomyString,
        }
        if (Array.isArray(presetList)) setPresets(presetList)
      })
      .catch(() => setFetchError('Failed to load configuration.'))
      .finally(() => setLoading(false))
  }, [])

  function getActivePreset(): PresetFull | null {
    if (!instancePreset) return null
    return presets.find(p => p.slug === instancePreset) ?? null
  }

  function resetToPreset(field: 'aiContext' | 'relevanceQuestion' | 'tagTaxonomy' | 'keywords') {
    const preset = getActivePreset()
    if (!preset) {
      if (field === 'aiContext') setAiContext('')
      if (field === 'relevanceQuestion') setRelevanceQuestion('')
      if (field === 'tagTaxonomy') setTagTaxonomy('')
      if (field === 'keywords') setKeywords('')
    } else {
      if (field === 'aiContext') setAiContext(preset.aiContext)
      if (field === 'relevanceQuestion') setRelevanceQuestion(preset.relevanceQuestion)
      if (field === 'tagTaxonomy') setTagTaxonomy(
        preset.taxonomy.map(t => t.description ? `${t.name}: ${t.description}` : t.name).join('\n')
      )
      if (field === 'keywords') setKeywords(preset.keywords.join('\n'))
    }
  }

  async function handleSaveKeywords() {
    const newKeywords = keywords.split('\n').map((s) => s.trim()).filter(Boolean)

    // Fetch preview counts before asking the user to confirm
    let confirmMsg = 'Save and sync keywords?'
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
        const result = await apiFetch<{ queued: number; demoted: number; protectedAsManual: number }>('/admin/keyword-resync', { method: 'POST' })
        setSyncKeywordsResult(result)
        // Refresh the matched bill count shown in the AI rerun confirmation
        apiFetch<ConfigData>('/admin/config').then(d => { setMatchedBillsCount(d.matched_bills_count ?? null); setPrioritizedBillsCount(d.prioritized_bills_count ?? null) }).catch(() => {})
      } catch {
        // Resync failure is non-fatal — keywords were saved successfully
      }
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

    const parsed = parseTagTaxonomy(tagTaxonomy)
    if (!parsed.ok) {
      setSaveAiError(parsed.error)
      return
    }

    const current = { aiContext, relevanceQuestion, tagTaxonomy }
    const changed = aiSnapshot.current == null || aiInstructionsChanged(aiSnapshot.current, current)

    setSavingAi(true)
    setSavedAi(false)
    try {
      await apiFetch('/admin/config', {
        method: 'PUT',
        body: JSON.stringify({
          ai_context: aiContext.trim() || null,
          relevance_question: relevanceQuestion.trim() || null,
          tag_taxonomy: parsed.value,
        }),
      })
      aiSnapshot.current = {
        aiContext: aiContext.trim(),
        relevanceQuestion: relevanceQuestion.trim(),
        tagTaxonomy,
      }
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

  async function handleApplyPreset() {
    if (!selectedPresetSlug) return
    if (!confirm(`Apply the "${presets.find(p => p.slug === selectedPresetSlug)?.name ?? selectedPresetSlug}" preset? This will overwrite your current AI context, relevance question, tag taxonomy, and keywords.`)) return
    setApplyingPreset(true)
    setApplyPresetResult(null)
    try {
      await apiFetch(`/admin/apply-preset/${selectedPresetSlug}`, { method: 'POST' })
      const data = await apiFetch<ConfigData>('/admin/config')
      const taxonomyString = (Array.isArray(data.tag_taxonomy) && data.tag_taxonomy.length > 0
        ? data.tag_taxonomy
            .map((t: { name: string; description?: string }) => t.description ? `${t.name}: ${t.description}` : t.name)
            .join('\n')
        : '')
      setAiContext(data.ai_context ?? '')
      setRelevanceQuestion(data.relevance_question ?? '')
      setTagTaxonomy(taxonomyString)
      setKeywords(Array.isArray(data.keywords) && data.keywords.length > 0 ? data.keywords.join('\n') : '')
      setInstancePreset(data.instance_preset ?? null)
      aiSnapshot.current = {
        aiContext: data.ai_context ?? '',
        relevanceQuestion: data.relevance_question ?? '',
        tagTaxonomy: taxonomyString,
      }
      setApplyPresetResult(`Preset applied.`)
    } catch {
      setApplyPresetResult('Failed to apply preset.')
    } finally {
      setApplyingPreset(false)
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

  const labelStyle: React.CSSProperties = FORM_LABEL
  const hintStyle: React.CSSProperties = { ...HELPER_TEXT, marginTop: 4 }
  const inputStyle: React.CSSProperties = { width: '100%', fontSize: fontSize.sm, padding: '8px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, boxSizing: 'border-box', fontFamily: 'inherit' }
  const selectStyle: React.CSSProperties = { fontSize: fontSize.sm, padding: '8px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, boxSizing: 'border-box', fontFamily: 'inherit', color: color.textSlate, background: color.white }
  const resetBtnStyle: React.CSSProperties = { fontSize: fontSize.sm, color: color.textMuted, background: 'none', border: 'none', cursor: demoLocked ? 'not-allowed' : 'pointer', padding: 0, textDecoration: 'underline' }

  if (fetchError) return <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}><SettingsNav /><div style={{ color: color.textErrorRed, fontSize: fontSize.sm, marginTop: 24 }}>{fetchError}</div></div>

  const activePreset = getActivePreset()
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

      {/* Preset panel */}
      <div style={{ background: color.surfaceSubtle, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, padding: 16, marginBottom: 20 }}>
        {loading ? (
          <div style={hintStyle}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.textPrimary }}>
                Preset:{' '}
                <span style={{ fontWeight: fontWeight.normal, color: instancePreset ? color.accentBlue : color.textMuted }}>
                  {instancePreset ? (presets.find(p => p.slug === instancePreset)?.name ?? instancePreset) : 'None'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
                <select
                  value={selectedPresetSlug}
                  onChange={e => { setSelectedPresetSlug(e.target.value); setApplyPresetResult(null) }}
                  style={selectStyle}
                >
                  <option value=''>Load a preset…</option>
                  {presets.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}
                </select>
                <button
                  onClick={handleApplyPreset}
                  disabled={!selectedPresetSlug || applyingPreset || demoLocked}
                  style={{ fontSize: fontSize.sm, padding: '8px 12px', background: (selectedPresetSlug && !demoLocked) ? color.accentBlue : color.borderDefault, color: (selectedPresetSlug && !demoLocked) ? color.white : color.textMuted, border: 'none', borderRadius: radius.md, cursor: (selectedPresetSlug && !demoLocked) ? 'pointer' : 'not-allowed', fontWeight: fontWeight.medium }}
                >
                  {applyingPreset ? 'Applying…' : 'Apply'}
                </button>
              </div>
            </div>
            {selectedPresetSlug && presets.find(p => p.slug === selectedPresetSlug) && (
              <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginTop: 8 }}>
                {presets.find(p => p.slug === selectedPresetSlug)?.description}
              </div>
            )}
            {applyPresetResult && (
              <div style={{ fontSize: fontSize.sm, color: applyPresetResult.startsWith('Failed') ? color.textErrorRed : color.textSuccess, marginTop: 8 }}>
                {applyPresetResult}
              </div>
            )}
          </>
        )}
      </div>

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
                {(keywords.trim() || activePreset) && (
                  <button type='button' onClick={() => resetToPreset('keywords')} disabled={demoLocked} style={resetBtnStyle}>
                    {activePreset ? 'Reset to preset' : 'Clear'}
                  </button>
                )}
              </div>
              <ResizableTextarea
                id="config-keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
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
                  {(aiContext.trim() || activePreset) && (
                    <button type='button' onClick={() => resetToPreset('aiContext')} disabled={demoLocked} style={resetBtnStyle}>
                      {activePreset ? 'Reset to preset' : 'Reset to default'}
                    </button>
                  )}
                </div>
                <ResizableTextarea
                  id="config-ai-context"
                  value={aiContext}
                  onChange={(e) => setAiContext(e.target.value)}
                  initialHeight={160}
                  minHeight={60}
                  style={{ fontSize: fontSize.sm }}
                  placeholder={DEFAULT_AI_CONTEXT}
                />
                <div style={hintStyle}>System instructions sent to the AI for every bill. Controls the summary style and framing.</div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <label htmlFor="config-relevance-question" style={{ ...labelStyle, marginBottom: 0 }}>Relevance score</label>
                  {(relevanceQuestion.trim() || activePreset) && (
                    <button type='button' onClick={() => resetToPreset('relevanceQuestion')} disabled={demoLocked} style={resetBtnStyle}>
                      {activePreset ? 'Reset to preset' : 'Reset to default'}
                    </button>
                  )}
                </div>
                <input
                  id="config-relevance-question"
                  value={relevanceQuestion}
                  onChange={(e) => setRelevanceQuestion(e.target.value)}
                  style={inputStyle}
                  placeholder={DEFAULT_RELEVANCE_QUESTION}
                />
                <div style={hintStyle}>Prompt sent to guide the AI in scoring each bill's relevance from 1–10.</div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <label htmlFor="config-tag-taxonomy" style={{ ...labelStyle, marginBottom: 0 }}>Tags</label>
                  {(tagTaxonomy.trim() || activePreset) && (
                    <button type='button' onClick={() => resetToPreset('tagTaxonomy')} disabled={demoLocked} style={resetBtnStyle}>
                      {activePreset ? 'Reset to preset' : 'Reset to default'}
                    </button>
                  )}
                </div>
                <ResizableTextarea
                  id="config-tag-taxonomy"
                  value={tagTaxonomy}
                  onChange={(e) => setTagTaxonomy(e.target.value)}
                  initialHeight={200}
                  minHeight={60}
                  style={{ fontFamily: 'monospace', fontSize: fontSize.sm }}
                  placeholder={DEFAULT_TAXONOMY}
                />
                <div style={hintStyle}>
                  One tag per line. The AI will only assign tags from this list. Tags can stand alone or include an optional description (after a colon) to provide additional context. For example:<br />
                  <code style={{ fontFamily: 'monospace', fontSize: fontSize.sm, background: color.surfaceMuted, borderRadius: radius.sm, padding: '0 4px' }}>Municipal Court</code><br />
                  <code style={{ fontFamily: 'monospace', fontSize: fontSize.sm, background: color.surfaceMuted, borderRadius: radius.sm, padding: '0 4px' }}>Elections: Local election administration, voting rights, voter registration, voting equipment, etc.</code>
                </div>
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
              <label style={{ fontSize: fontSize.sm, whiteSpace: 'nowrap', color: newMatchMinRelevance > 0 ? color.partyDemBlue : color.textSlate, fontWeight: newMatchMinRelevance > 0 ? fontWeight.medium : fontWeight.normal }}>
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
          Fields are hidden from members until at least one value is set. Drag to reorder.
        </div>

        {/* Field list */}
        {customFields.length > 0 && (
          <div style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, overflow: 'hidden', marginBottom: 14, position: 'relative' }}>
            {customFields.map((field, i) => (
              <div key={field.id}>
                {cfDragOver === i && cfDragFrom !== null && cfDragFrom !== i && cfDragFrom !== i - 1 && (
                  <div style={{ height: 2, background: color.accentBlue, margin: '0 12px' }} />
                )}
                <div
                  draggable={cfEditing !== field.id && !demoLocked}
                  onDragStart={demoLocked ? undefined : e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); setCfDragFrom(i); (e.currentTarget as HTMLElement).style.opacity = '0.4' }}
                  onDragEnd={demoLocked ? undefined : e => { (e.currentTarget as HTMLElement).style.opacity = '1'; setCfDragFrom(null); setCfDragOver(null) }}
                  onDragOver={demoLocked ? undefined : e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setCfDragOver(i) }}
                  onDrop={demoLocked ? undefined : e => {
                    e.preventDefault()
                    setCfDragFrom(null)
                    setCfDragOver(null)
                    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'))
                    const toIdx = i
                    if (fromIdx === toIdx) return
                    const reordered = [...customFields]
                    const [moved] = reordered.splice(fromIdx, 1)
                    reordered.splice(toIdx, 0, moved)
                    setCustomFields(reordered)
                    apiFetch('/admin/custom-fields/reorder', {
                      method: 'PUT',
                      body: JSON.stringify({ order: reordered.map(f => f.id) }),
                    }).catch(() => {})
                  }}
                  style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', background: color.white, borderTop: i > 0 ? `1px solid ${color.surfaceMuted}` : 'none', gap: 10, cursor: cfEditing === field.id ? 'default' : demoLocked ? 'not-allowed' : 'grab' }}
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
                      <span style={{ fontSize: fontSize.base, color: demoLocked ? color.borderDefault : color.borderStrong, cursor: demoLocked ? 'not-allowed' : 'grab', userSelect: 'none', flexShrink: 0 }}>⠿</span>
                      <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.medium }}>{field.name}</span>
                      <button
                        onClick={demoLocked ? undefined : () => {
                          setCfEditing(field.id)
                          setCfEditName(field.name)
                          setCfEditOptions(field.type === 'dropdown' && field.options ? field.options.join(', ') : '')
                          setCfEditMultiple(field.multiple ?? false)
                          setCfEditError(null)
                        }}
                        disabled={demoLocked}
                        onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCfTooltip({ key: `${field.id}-edit`, x: r.left + r.width / 2, y: r.top }) }}
                        onMouseLeave={() => setCfTooltip(null)}
                        style={{ background: 'none', border: 'none', color: demoLocked ? color.borderDefault : color.textMuted, cursor: demoLocked ? 'not-allowed' : 'pointer', padding: '2px', display: 'inline-flex', alignItems: 'center' }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: fontSize.xl }}>edit</span>
                      </button>
                      <span style={{ flex: 1 }} />
                      {field.type === 'text' && (
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
                          onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCfTooltip({ key: `${field.id}-pin`, x: r.left + r.width / 2, y: r.top }) }}
                          onMouseLeave={() => setCfTooltip(null)}
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
                      )}
                      <span
                        onMouseEnter={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setCfTooltip({ key: `${field.id}-type`, x: r.left + r.width / 2, y: r.top }) }}
                        onMouseLeave={() => setCfTooltip(null)}
                        style={{
                          fontSize: fontSize.sm, padding: '2px 8px', borderRadius: radius.lg, fontWeight: fontWeight.medium,
                          display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'default',
                          ...(field.type === 'binary' ? { background: color.bgAmberPriority, color: color.textAmberDark }
                            : field.type === 'dropdown' ? { background: color.bgBlueChip, color: color.filterBadgeNavy }
                            : field.type === 'text' ? { background: color.surfaceMuted, color: color.textSlate500 }
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
                        style={{ background: 'none', border: 'none', color: demoLocked ? color.borderDefault : color.textDeleteRed, cursor: demoLocked ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                        title={demoLocked ? undefined : `Delete "${field.name}"`}
                      ><span className="material-symbols-outlined" style={{ fontSize: fontSize.base }}>delete</span></button>
                      {cfTooltip && cfTooltip.key.startsWith(field.id) && (() => {
                        const el = cfTooltip.key.slice(field.id.length + 1)
                        const text = el === 'pin'
                          ? (field.pinned
                            ? 'Unpin this field. Pinned fields, when they are filled out, appear above the AI summary on bill detail pages.'
                            : 'Pin this field. Pinned fields, when they are filled out, appear above the AI summary on bill detail pages.')
                          : el === 'edit'
                            ? (demoLocked ? 'Read-only in demo mode' : 'Edit')
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
            {/* Drop zone after last item for dragging to bottom */}
            <div
              onDragOver={demoLocked ? undefined : e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setCfDragOver(customFields.length) }}
              onDrop={demoLocked ? undefined : e => {
                e.preventDefault()
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'))
                setCfDragFrom(null)
                setCfDragOver(null)
                if (fromIdx === customFields.length - 1) return
                const reordered = [...customFields]
                const [moved] = reordered.splice(fromIdx, 1)
                reordered.push(moved)
                setCustomFields(reordered)
                apiFetch('/admin/custom-fields/reorder', {
                  method: 'PUT',
                  body: JSON.stringify({ order: reordered.map(f => f.id) }),
                }).catch(() => {})
              }}
              style={{ minHeight: 8 }}
            >
              {cfDragOver === customFields.length && cfDragFrom !== null && cfDragFrom !== customFields.length - 1 && (
                <div style={{ height: 2, background: color.accentBlue, margin: '0 12px' }} />
              )}
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
              {clearingInteractions ? 'Clearing…' : 'Clear all user interactions'}
            </button>
            <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 1 }}>
              Permanently deletes all votes, comments, notes, official positions, bill priorities, and feed history. Users, bills, and AI summaries are kept. <strong>Only Owners can do this. It cannot be undone.</strong>
            </span>
            {clearResult && <span style={{ fontSize: fontSize.sm, color: clearResult === 'Cleared.' ? color.textSuccess : color.textErrorRed, flexShrink: 0 }}>{clearResult}</span>}
          </div>
        )}

      </div>

      </>

    </div>
  )
}
