import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { PopPanel, type PopPanelHandle } from '../ui/PopPanel'
import { computeEventPopoverPosition, type EventPopoverPosition } from './EventPopover'

export function SubscribeCalendar() {
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

  if (!info) return null

  const trigger: React.CSSProperties = {
    background: color.white, color: color.textSlate, fontSize: fontSize.sm, fontWeight: fontWeight.semibold,
    padding: '9px 16px', borderRadius: radius.md, border: `1px solid ${color.borderDefault}`, cursor: 'pointer',
  }
  const rowStyle = (i: number): React.CSSProperties => ({
    display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
    padding: '8px 10px', borderRadius: radius.md, fontSize: fontSize.sm, color: color.textSlate,
    // fontFamily (not `font: inherit`, which would reset font-size to 16px).
    textDecoration: 'none', fontFamily: 'inherit', background: hovered === i ? color.surfaceMuted : color.white,
  })

  function open() {
    if (pos) { panelRef.current?.close(); return }
    const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect(8, 80, 0, 0)
    setPos(computeEventPopoverPosition(rect, { width: 260, align: 'right' }))
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
            <a href={info.webcalUrl} type="text/calendar" style={rowStyle(0)}
              onMouseEnter={() => setHovered(0)} onMouseLeave={() => setHovered(null)}>Subscribe in your calendar app (like Microsoft Outlook or Apple Calendar)</a>
            <a href={info.googleUrl} target="_blank" rel="noopener noreferrer" style={rowStyle(1)}
              onMouseEnter={() => setHovered(1)} onMouseLeave={() => setHovered(null)}>Add to Google Calendar</a>
            <button type="button" style={rowStyle(2)}
              onMouseEnter={() => setHovered(2)} onMouseLeave={() => setHovered(null)}
              onClick={() => {
                navigator.clipboard.writeText(info.feedUrl); setCopied(true); setTimeout(() => setCopied(false), 1500)
              }}>{copied ? 'Copied!' : 'Copy feed URL'}</button>
          </div>
        </PopPanel>
      )}
    </>
  )
}
