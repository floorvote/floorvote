import { useEffect, useMemo, useState } from 'react'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { usePageTitle } from '../hooks/usePageTitle'
import { apiFetch } from '../lib/api'
import { CARD } from '../lib/cardStyle'
import { SECTION_LABEL } from '../lib/textStyles'

interface PersonRef { name: string; url: string | null }
interface Staff { name: string; title: string | null; email: string | null; phone: string | null; url: string | null }
interface Committee { slug: string; name: string; url: string; chair: PersonRef | null; members: PersonRef[]; staff: Staff[]; agencies: string[] }
interface DirectoryEntry { kind: string; name: string; title: string | null; office: string | null; email: string | null; phone: string | null }
interface Councilmember { name: string; role: string | null; termStart: string | null; termEnd: string | null; current: boolean; note?: string | null }
interface CouncilChange { kind: string; committee: string | null; person: string | null; detail: string | null; detectedAt: string }
interface Directory { committees: Committee[]; people: DirectoryEntry[]; updatedAt: string | null; councilmembers?: Councilmember[]; changes?: CouncilChange[] }

/** One Council change as a sentence. */
export function describeChange(c: CouncilChange): string {
  const who = c.person ?? 'Someone'
  const where = c.committee ?? 'a committee'
  switch (c.kind) {
    case 'member_joined': return `${who} joined the Council.${c.detail ? ` ${c.detail}` : ''}`
    case 'member_left': return `${who} left the Council.${c.detail ? ` ${c.detail}` : ''}`
    case 'member_listed': return `${who} is listed as serving on the Council.${c.detail ? ` ${c.detail}` : ''}`
    case 'member_unlisted': return `${who} is no longer listed as serving on the Council.${c.detail ? ` ${c.detail}` : ''}`
    case 'chair_changed': return `${who} now chairs the ${where}.${c.detail ? ` ${c.detail}` : ''}`
    case 'member_added': return `${who} joined the ${where}.`
    case 'member_removed': return `${who} left the ${where}.`
    case 'staff_added': return `${who}${c.detail ? `, ${c.detail},` : ''} joined the ${where} staff.`
    case 'staff_removed': return `${who}${c.detail ? `, ${c.detail},` : ''} left the ${where} staff.`
    case 'staff_title': return `${who} (${where}): ${c.detail ?? 'new title'}`
    case 'committee_added': return `New committee: ${where}.`
    case 'committee_removed': return `${where} is no longer a Council committee.`
    default: return `${who}${c.committee ? ` (${c.committee})` : ''}: ${c.detail ?? c.kind}`
  }
}

/** Scraped values reach an href only when they look like what they claim to be. */
export const plainEmail = (e: string | null) => e && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e) ? e : null
export const councilUrl = (u: string | null) => u && /^https:\/\/(www\.)?dccouncil\.gov\//i.test(u) ? u : null

function Contact({ email, phone }: { email: string | null; phone: string | null }) {
  const safe = plainEmail(email)
  return (
    <>
      {safe ? <a href={`mailto:${safe}`} className="blue-link">{safe}</a> : email}
      {email && phone && <span style={{ color: color.textMuted }}> · </span>}
      {phone && <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="blue-link">{phone}</a>}
    </>
  )
}

function Person({ p }: { p: PersonRef }) {
  const url = councilUrl(p.url)
  return url ? <a href={url} target="_blank" rel="noopener noreferrer" className="blue-link">{p.name}</a> : <>{p.name}</>
}

/**
 * /people: the DC Council's committees and staff, from dccouncil.gov. Who chairs
 * and sits on each committee, its key staff, the agencies it oversees, and the
 * full staff directory, searchable.
 */
export function People() {
  usePageTitle('People')
  const [data, setData] = useState<Directory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    apiFetch<Directory>('/directory').then(setData).catch(() => setError('The Council directory is unavailable right now.'))
  }, [])

  const needle = q.trim().toLowerCase()
  const committees = useMemo(() => (data?.committees ?? []).filter(c => !needle || [
    c.name, c.chair?.name, ...c.members.map(m => m.name), ...c.staff.map(s => `${s.name} ${s.title ?? ''}`), ...c.agencies,
  ].some(x => (x ?? '').toLowerCase().includes(needle))), [data, needle])
  const people = useMemo(() => (data?.people ?? []).filter(p => !needle || [p.name, p.title, p.office]
    .some(x => (x ?? '').toLowerCase().includes(needle))), [data, needle])

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1000, margin: '0 auto', color: color.textSlate }}>
      <h1 style={{ fontSize: fontSize.xl, fontWeight: fontWeight.semibold, margin: '0 0 4px' }}>People</h1>
      <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16 }}>
        DC Council committees and staff, from <a href="https://dccouncil.gov/committees/" target="_blank" rel="noopener noreferrer" className="blue-link">dccouncil.gov</a>, updated daily.
      </div>
      <input
        type="search" value={q} onChange={e => setQ(e.target.value)} aria-label="Search people, committees, and agencies"
        placeholder="Search a name, office, committee, or agency"
        style={{ width: '100%', maxWidth: 420, padding: '7px 10px', fontSize: fontSize.sm, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, marginBottom: 20 }}
      />
      {error && <div style={{ color: color.textErrorRed, fontSize: fontSize.sm }}>{error}</div>}
      {!data && !error && <div style={{ color: color.textMuted, fontSize: fontSize.sm }}>Loading…</div>}
      {data && (
        <>
          {(data.changes ?? []).length > 0 && !needle && (
            <section aria-label="Recent Council changes" style={{ ...CARD, padding: 14, marginBottom: 24, fontSize: fontSize.sm }}>
              <h2 style={{ ...SECTION_LABEL, display: 'block', marginBottom: 8 }}>Recent Council changes</h2>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
                {(data.changes ?? []).slice(0, 15).map((c, i) => (
                  <li key={i}><span style={{ color: color.textMuted }}>{c.detectedAt.slice(0, 10)}</span> {describeChange(c)}</li>
                ))}
              </ul>
            </section>
          )}

          {(data.councilmembers ?? []).length > 0 && !needle && (
            <>
              <h2 style={{ ...SECTION_LABEL, display: 'block', marginBottom: 10 }}>Councilmembers</h2>
              <div style={{ ...CARD, padding: 14, marginBottom: 24, fontSize: fontSize.sm, lineHeight: 1.6 }}>
                <div>{(data.councilmembers ?? []).filter(m => m.current).map(m => `${m.name}${m.role && /chair/i.test(m.role) ? ` (${m.role})` : ''}`).join(', ')}</div>
                {(data.councilmembers ?? []).filter(m => m.note).map(m => (
                  <div key={m.name} style={{ marginTop: 6, color: color.textMuted }}>{m.name}: {m.note}</div>
                ))}
                {(data.councilmembers ?? []).some(m => !m.current) && (
                  <div style={{ marginTop: 6, color: color.textSecondary }}>
                    <span style={{ color: color.textMuted }}>Not currently serving this Council Period: </span>
                    {(data.councilmembers ?? []).filter(m => !m.current).map(m => `${m.name} (${m.termStart ?? '?'} to ${m.termEnd ?? '?'})`).join('; ')}
                  </div>
                )}
              </div>
            </>
          )}

          <h2 style={{ ...SECTION_LABEL, display: 'block', marginBottom: 10 }}>Committees ({committees.length})</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 28 }}>
            {committees.map(c => (
              <section key={c.slug} aria-label={c.name} style={{ ...CARD, padding: 14, fontSize: fontSize.sm, lineHeight: 1.55 }}>
                {councilUrl(c.url)
                  ? <a href={councilUrl(c.url)!} target="_blank" rel="noopener noreferrer" className="blue-link" style={{ fontWeight: fontWeight.semibold, fontSize: fontSize.base }}>{c.name}</a>
                  : <span style={{ fontWeight: fontWeight.semibold, fontSize: fontSize.base }}>{c.name}</span>}
                {c.chair && <div style={{ marginTop: 6 }}><span style={{ color: color.textMuted }}>Chair: </span><Person p={c.chair} /></div>}
                {c.members.length > 0 && (
                  <div><span style={{ color: color.textMuted }}>Members: </span>
                    {c.members.map((m, i) => <span key={m.name}>{i > 0 && ', '}<Person p={m} /></span>)}
                  </div>
                )}
                {c.staff.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ color: color.textMuted }}>Key staff</div>
                    {c.staff.map(s => (
                      <div key={s.name}>
                        {s.name}{s.title ? `, ${s.title}` : ''}<br />
                        <span style={{ fontSize: fontSize.xs }}><Contact email={s.email} phone={s.phone} /></span>
                      </div>
                    ))}
                  </div>
                )}
                {c.agencies.length > 0 && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: 'pointer', color: color.textMuted }}>Agencies it oversees ({c.agencies.length})</summary>
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{c.agencies.map(a => <li key={a}>{a}</li>)}</ul>
                  </details>
                )}
              </section>
            ))}
          </div>

          <h2 style={{ ...SECTION_LABEL, display: 'block', marginBottom: 10 }}>Council staff directory ({people.length})</h2>
          <div style={{ ...CARD, padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize.sm }}>
              <thead>
                <tr style={{ textAlign: 'left', color: color.textMuted, fontSize: fontSize.xs }}>
                  <th style={{ padding: '8px 12px' }}>Name</th><th style={{ padding: '8px 12px' }}>Title</th>
                  <th style={{ padding: '8px 12px' }}>Office</th><th style={{ padding: '8px 12px' }}>Contact</th>
                </tr>
              </thead>
              <tbody>
                {people.slice(0, 300).map(p => (
                  <tr key={`${p.name}|${p.email ?? p.office ?? ''}`} style={{ borderTop: `1px solid ${color.borderDefault}` }}>
                    <td style={{ padding: '6px 12px' }}>{p.name}</td>
                    <td style={{ padding: '6px 12px' }}>{p.title ?? ''}</td>
                    <td style={{ padding: '6px 12px', textTransform: 'capitalize' }}>{p.office ?? ''}</td>
                    <td style={{ padding: '6px 12px' }}><Contact email={p.email} phone={p.phone} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
