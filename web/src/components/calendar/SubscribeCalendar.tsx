import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { computeEventPopoverPosition, type EventPopoverPosition } from './EventPopover'
import { useDemo } from '../../context/DemoContext'

export function SubscribeCalendar() {
  const { demoLocked } = useDemo()
  const [info, setInfo] = useState<{ webcalUrl: string; feedUrl: string; googleUrl: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)
  const [pos, setPos] = useState<EventPopoverPosition | null>(null)
  const panelRef = useRef<PopPanelHandle>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    apiFetch<{ webcalUrl: string; feedUrl: string; googleUrl: string }>('/calendar/info')
      .then(setInfo)
      .catch((e) => console.error('[calendar/info] fetch failed', e))
  }, [])

  const openPanel = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect(8, 80, 0, 0)
    setPos(computeEventPopoverPosition(rect, { width: 260, align: 'right' }))
  }, [])

  // The week-ahead email's footer links `/calendar#subscribe` and lands the reader
  // on the open chooser. It cannot link an ICS URL directly: the only feed route is
  // slug-secret (`/api/calendar/feed/:slug.ics`), and mailing that slug would put the
  // association's shared feed secret in every inbox, revocable only by rotating it
  // out from under every existing subscriber.
  //
  // The hash is consumed once, not left in the URL: it is an instruction ("open this"),
  // not a location, so a reload or a back-navigation after closing should not re-open.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!info || autoOpenedRef.current || window.location.hash !== '#subscribe') return
    autoOpenedRef.current = true
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    openPanel()
  }, [info, openPanel])

  if (!info) return null

  const trigger: React.CSSProperties = {
    background: color.white, color: color.textSlate, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
    padding: '9px 16px', borderRadius: radius.md, border: `1px solid ${color.borderDefault}`, cursor: 'pointer',
  }
  const rowStyle = (i: number, disabled: boolean): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left', border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    padding: '8px 10px', borderRadius: radius.md, fontSize: fontSize.sm, color: color.textSlate,
    // fontFamily (not `font: inherit`, which would reset font-size to 16px).
    textDecoration: 'none', fontFamily: 'inherit', background: (!disabled && hovered === i) ? color.surfaceMuted : color.white,
  })

  function open() {
    if (pos) { panelRef.current?.close(); return }
    openPanel()
  }

  return (
    <>
      <button ref={triggerRef} type="button" onClick={open} style={trigger}>Subscribe</button>
      {pos && (
        <PopPanel
          ref={panelRef}
          onClose={() => setPos(null)}
          triggerRef={triggerRef}
          ariaLabel="Subscribe to calendar"
          transformOrigin={pos.transformOrigin}
          enterOffsetY={pos.enterOffsetY}
          positionStyle={pos.positionStyle}
        >
          <div style={{ padding: 6 }}>
            <a href={demoLocked ? undefined : info.webcalUrl} type="text/calendar" style={rowStyle(0, demoLocked)}
              aria-disabled={demoLocked || undefined} tabIndex={demoLocked ? -1 : undefined}
              onClick={demoLocked ? (e) => e.preventDefault() : undefined}
              onMouseEnter={() => !demoLocked && setHovered(0)} onMouseLeave={() => setHovered(null)}>Subscribe in your calendar app (like Microsoft Outlook or Apple Calendar)</a>
            <a href={demoLocked ? undefined : info.googleUrl} target="_blank" rel="noopener noreferrer" style={rowStyle(1, demoLocked)}
              aria-disabled={demoLocked || undefined} tabIndex={demoLocked ? -1 : undefined}
              onClick={demoLocked ? (e) => e.preventDefault() : undefined}
              onMouseEnter={() => !demoLocked && setHovered(1)} onMouseLeave={() => setHovered(null)}>Add to Google Calendar</a>
            <button type="button" style={rowStyle(2, demoLocked)} disabled={demoLocked}
              onMouseEnter={() => !demoLocked && setHovered(2)} onMouseLeave={() => setHovered(null)}
              onClick={() => {
                navigator.clipboard.writeText(info.feedUrl); setCopied(true); setTimeout(() => setCopied(false), 1500)
              }}>{copied ? 'Copied!' : 'Copy feed URL'}</button>
          </div>
        </PopPanel>
      )}
    </>
  )
}
