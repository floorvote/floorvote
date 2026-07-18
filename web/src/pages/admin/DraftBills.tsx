import { useEffect, useState } from 'react'
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
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [createDraftError, setCreateDraftError] = useState<string | null>(null)
  const [draftList, setDraftList] = useState<{ id: string; billNumber: string; title: string; state: string | null }[] | null>(null)

  useEffect(() => {
    apiFetch<{ drafts: { id: string; billNumber: string; title: string; state: string | null }[] }>('/bills/drafts')
      .then(r => setDraftList(r.drafts))
      .catch(() => setDraftList([]))
  }, [])

  async function handleCreateDraft() {
    const title = draftTitle.trim()
    if (!title) return
    setCreatingDraft(true)
    setCreateDraftError(null)
    try {
      const hasContent = (html: string) => html.replace(/<[^>]*>/g, '').trim().length > 0
      const body: Record<string, unknown> = { title }
      if (draftSponsor.trim()) body.sponsor = draftSponsor.trim()
      if (hasContent(draftSummary)) body.summary = draftSummary
      if (hasContent(draftText)) body.text = draftText
      const created = await apiFetch<{ id: string }>('/bills/draft', {
        method: 'POST',
        body: JSON.stringify(body),
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
        <div style={sectionTitle}>Draft bills</div>
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
            <div>
              <label style={labelStyle}>Title <span style={{ fontWeight: fontWeight.semibold, color: color.textDanger }}>*</span></label>
              <input
                value={draftTitle}
                onChange={e => setDraftTitle(e.target.value)}
                placeholder="Bill title…"
                style={inputStyle}
                autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Sponsor(s)</label>
              <input
                value={draftSponsor}
                onChange={e => setDraftSponsor(e.target.value)}
                placeholder="Sponsor name…"
                style={inputStyle}
              />
            </div>
            <div>
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
                disabled={!draftTitle.trim() || creatingDraft}
                style={actionBtnBlue(!draftTitle.trim() || creatingDraft)}
              >
                {creatingDraft ? 'Creating…' : 'Create draft'}
              </button>
              <button
                onClick={() => { setShowDraftForm(false); setDraftTitle(''); setDraftSummary(''); setDraftSponsor(''); setDraftText(''); setCreateDraftError(null) }}
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
                          if (!window.confirm('Delete this draft bill? This permanently removes it and its votes, positions, comments, and notes.')) return
                          try {
                            await apiFetch('/bills/' + d.id, { method: 'DELETE' })
                            setDraftList(prev => prev ? prev.filter(x => x.id !== d.id) : prev)
                          } catch (err) {
                            alert(err instanceof Error ? err.message : 'Failed to delete draft.')
                          }
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: color.textDeleteRed, display: 'flex', alignItems: 'center', flexShrink: 0 }}
                        title="Delete draft"
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
