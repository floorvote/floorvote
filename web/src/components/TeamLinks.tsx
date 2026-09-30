import { useEffect, useState } from 'react'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { SECTION_LABEL } from '../lib/textStyles'
import { apiFetch, ApiError } from '../lib/api'
import { useDemo } from '../context/DemoContext'
import { InfoTooltip } from './InfoTooltip'

interface TeamLink { id: string; title: string; url: string }

/**
 * Team documents for a bill or calendar event: links (usually Google Drive) to
 * the team's letters, testimony, and redlines. Admins add and remove them;
 * everyone sees them. The deep-analysis worker reads them, so analyses and
 * briefs build on what the team has already said.
 */
export function TeamLinks({ kind, subjectId, isAdmin }: { kind: 'bill' | 'event'; subjectId: string; isAdmin: boolean }) {
  const { demoLocked } = useDemo()
  const [links, setLinks] = useState<TeamLink[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    apiFetch<{ links: TeamLink[] }>(`/links/${kind}/${subjectId}`).then(d => { if (live) setLinks(Array.isArray(d?.links) ? d.links : []) }).catch(() => { if (live) setLinks([]) })
    return () => { live = false }
  }, [kind, subjectId])

  if (links === null || (links.length === 0 && !isAdmin)) return null

  async function add() {
    setBusy(true)
    setError(null)
    try {
      const l = await apiFetch<TeamLink>(`/links/${kind}/${subjectId}`, { method: 'POST', body: JSON.stringify({ title, url }) })
      setLinks(ls => [...(ls ?? []), l])
      setTitle(''); setUrl(''); setAdding(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the link.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Remove this document link? The document itself is not affected.')) return
    try {
      await apiFetch(`/links/${id}`, { method: 'DELETE' })
      setLinks(ls => (ls ?? []).filter(l => l.id !== id))
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the link.')
    }
  }

  const input: React.CSSProperties = { fontSize: fontSize.sm, padding: '5px 8px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md }
  return (
    <section aria-label="Team documents" style={{ marginTop: 16, padding: 14, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, background: color.white, fontSize: fontSize.sm }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={SECTION_LABEL}>Team documents</span>
        <InfoTooltip maxWidth={320} align="left" label="About team documents"
          text="Links to our own letters, testimony, and redlines on this item, usually in Google Drive. They open with your own Drive access. The AI that writes deep analyses and hearing briefs reads them, so never link a document with client information." />
        <span style={{ flex: 1 }} />
        {isAdmin && !demoLocked && !adding && (
          <button type="button" onClick={() => setAdding(true)} className="blue-link" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: fontSize.xs }}>Add a document</button>
        )}
      </div>
      {links.length === 0 && !adding && <div style={{ color: color.textMuted, marginTop: 6 }}>None yet. Add our letters or testimony, and the next analysis will build on them.</div>}
      {links.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          {links.map(l => (
            <li key={l.id}>
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="blue-link">{l.title}</a>
              {isAdmin && !demoLocked && (
                <button type="button" onClick={() => remove(l.id)} aria-label={`Remove ${l.title}`}
                  style={{ marginLeft: 8, background: 'none', border: 'none', color: color.textMuted, cursor: 'pointer', fontSize: fontSize.xs }}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <input aria-label="Document title" placeholder="Title, e.g. Joint comment letter (July 1)" value={title} onChange={e => setTitle(e.target.value)} style={{ ...input, flex: '1 1 220px' }} />
          <input aria-label="Document link" placeholder="https://docs.google.com/…" value={url} onChange={e => setUrl(e.target.value)} style={{ ...input, flex: '2 1 280px' }} />
          <button type="button" onClick={add} disabled={busy || !title.trim() || !url.trim()} style={{ ...input, background: color.linkBlue, color: color.white, border: 'none', cursor: 'pointer', fontWeight: fontWeight.medium }}>{busy ? 'Adding…' : 'Add'}</button>
          <button type="button" onClick={() => { setAdding(false); setError(null) }} style={{ ...input, background: 'none', cursor: 'pointer' }}>Cancel</button>
        </div>
      )}
      {error && <div role="alert" style={{ color: color.textErrorRed, fontSize: fontSize.xs, marginTop: 6 }}>{error}</div>}
    </section>
  )
}
