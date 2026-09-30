import { useEffect, useState } from 'react'
import { color, fontSize, fontWeight, radius } from '../styles/tokens'
import { SECTION_LABEL } from '../lib/textStyles'
import { apiFetch } from '../lib/api'
import { councilUrl, plainEmail } from '../pages/People'
import { committeeKey as key } from '../../../shared/councilCommittees'

interface PersonRef { name: string; url: string | null }
interface Staff { name: string; title: string | null; email: string | null; phone: string | null }
interface Committee { slug: string; name: string; url: string; chair: PersonRef | null; members: PersonRef[]; staff: Staff[] }

/** The committee whose name starts an event title such as "Youth Affairs roundtable: ...". */
export function matchCommittee<T extends { name: string }>(committees: T[], eventTitle: string): T | null {
  const t = key(eventTitle)
  if (t.startsWith('committee of the whole') || t.startsWith('whole')) return committees.find(c => /whole/i.test(c.name)) ?? null
  return [...committees].sort((a, b) => key(b.name).length - key(a.name).length).find(c => key(c.name) && t.startsWith(key(c.name))) ?? null
}

/**
 * The committee holding an event: chair, members, and key staff with their
 * contacts, straight from dccouncil.gov (never from the AI), so the team knows
 * who to call.
 */
export function CommitteeCard({ eventTitle }: { eventTitle: string }) {
  const [committee, setCommittee] = useState<Committee | null>(null)
  useEffect(() => {
    let live = true
    apiFetch<{ committees: Committee[] }>('/directory')
      .then(d => { if (live) setCommittee(matchCommittee(d.committees, eventTitle)) })
      .catch(() => {})
    return () => { live = false }
  }, [eventTitle])
  if (!committee) return null
  return (
    <section aria-label={committee.name} style={{ marginTop: 16, padding: 14, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg, background: color.white, fontSize: fontSize.sm, lineHeight: 1.6 }}>
      <span style={SECTION_LABEL}>Committee</span>
      <div style={{ fontWeight: fontWeight.semibold, marginTop: 4 }}>
        {councilUrl(committee.url) ? <a href={councilUrl(committee.url)!} target="_blank" rel="noopener noreferrer" className="blue-link">{committee.name}</a> : committee.name}
      </div>
      {committee.chair && <div><span style={{ color: color.textMuted }}>Chair: </span>{committee.chair.name}</div>}
      {committee.members.length > 0 && <div><span style={{ color: color.textMuted }}>Members: </span>{committee.members.map(m => m.name).join(', ')}</div>}
      {committee.staff.map(s => (
        <div key={s.name}>
          <span style={{ color: color.textMuted }}>{s.title ?? 'Staff'}: </span>{s.name}
          {plainEmail(s.email) && <> · <a href={`mailto:${plainEmail(s.email)}`} className="blue-link">{s.email}</a></>}
          {s.phone && <> · <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} className="blue-link">{s.phone}</a></>}
        </div>
      ))}
    </section>
  )
}
