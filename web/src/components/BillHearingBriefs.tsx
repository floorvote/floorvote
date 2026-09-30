import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { color, fontSize } from '../styles/tokens'
import { apiFetch } from '../lib/api'
import { DeepAnalysisPanel } from './DeepAnalysisPanel'
import { TeamLinks } from './TeamLinks'

interface BillHearing { id: string; date: string | null; time: string | null; description: string }

/**
 * The Council events a bill is on, each with its hearing brief and team
 * documents. A hearing notice's page shows its roundtable's brief here, since
 * the brief and documents belong to the event.
 */
export function BillHearingBriefs({ billId, isAdmin }: { billId: string; isAdmin: boolean }) {
  const [events, setEvents] = useState<BillHearing[]>([])
  useEffect(() => {
    let live = true
    apiFetch<{ enabled: boolean; events: BillHearing[] }>(`/deep/bill/${billId}/hearings`)
      .then(d => { if (live) setEvents(d?.enabled && Array.isArray(d.events) ? d.events : []) })
      .catch(() => { if (live) setEvents([]) })
    return () => { live = false }
  }, [billId])
  if (events.length === 0) return null
  return (
    <>
      {events.map(e => (
        <div key={e.id}>
          <div style={{ fontSize: fontSize.sm, color: color.textSecondary, margin: '16px 0 4px' }}>
            <Link to={`/calendar/brief/${e.id}`} className="blue-link">{e.description}</Link>
            {(e.date || e.time) && <span> · {[e.date, e.time].filter(Boolean).join(' · ')}</span>}
          </div>
          <TeamLinks kind="event" subjectId={e.id} isAdmin={isAdmin} />
          <DeepAnalysisPanel kind="hearing" subjectId={e.id} isAdmin={isAdmin} />
        </div>
      ))}
    </>
  )
}
