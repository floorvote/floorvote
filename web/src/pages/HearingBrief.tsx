import { useCallback, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { usePageTitle } from '../hooks/usePageTitle'
import { useAuth } from '../hooks/useAuth'
import { DeepAnalysisPanel, type DeepView } from '../components/DeepAnalysisPanel'
import { TeamLinks } from '../components/TeamLinks'
import { CommitteeCard } from '../components/CommitteeCard'

/** /calendar/brief/:eventId: the hearing brief for one calendar event. */
export function HearingBrief() {
  const { eventId = '' } = useParams()
  const { user } = useAuth()
  const [event, setEvent] = useState<DeepView['event']>(undefined)
  usePageTitle(event?.description ? `Brief: ${event.description}` : 'Hearing brief')
  const onLoad = useCallback((v: DeepView) => setEvent(v.event ?? null), [])
  const isAdmin = user?.role === 'admin' || user?.role === 'owner'

  return (
    <div style={{ padding: '24px 32px', maxWidth: 820, margin: '0 auto', color: color.textSlate }}>
      <Link to="/calendar" className="blue-link" style={{ fontSize: fontSize.sm }}>← Calendar</Link>
      <h1 style={{ fontSize: fontSize.xl, fontWeight: fontWeight.semibold, margin: '12px 0 4px' }}>{event?.description ?? 'Hearing brief'}</h1>
      {event && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary }}>
          {[event.date, event.time, event.location].filter(Boolean).join(' · ')}
          {event.status === 'cancelled' && <span style={{ color: color.textErrorRed }}> · Cancelled</span>}
          {event.url && <> · <a href={event.url} target="_blank" rel="noopener noreferrer" className="blue-link">Council page and witness sign-up</a></>}
        </div>
      )}
      {event === null && <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>This event is no longer on the calendar.</div>}
      {event?.description && <CommitteeCard eventTitle={event.description} />}
      <TeamLinks kind="event" subjectId={eventId} isAdmin={isAdmin} />
      <DeepAnalysisPanel kind="hearing" subjectId={eventId} isAdmin={isAdmin} onLoad={onLoad} />
    </div>
  )
}
