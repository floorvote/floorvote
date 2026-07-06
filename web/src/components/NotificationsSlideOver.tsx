import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { Ref, RefObject } from 'react'
import DOMPurify from 'dompurify'
import { apiFetch } from '../lib/api'
import { useNotifications } from '../context/NotificationsContext'
import { billUrl } from '../lib/sessionSlug'
import { TOOLTIP_STYLE, tooltipPositionBelow } from '../lib/chipStyles'
import { BillBadge } from './BillBadge'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { PopPanel, type PopPanelHandle } from './ui/PopPanel'

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'strong', 'em', 'a', 'blockquote', 'ul', 'ol', 'li', 'span', 'br', 's'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'data-type', 'data-id', 'data-label', 'class'],
}

type Mention = {
  id: string
  commentId: string
  billId: string
  billNumber: string
  billTitle: string
  billState: string | null
  sessionSlug: string | null
  authorName: string
  authorSubtitle: string | null
  commentPreview: string
  commentHtml: string
  sourceType: 'user' | 'role' | 'everyone'
  sourceLabel: string | null
  createdAt: string
  isUnread: boolean
}

type RoleData = {
  id: string
  name: string
  members: Array<{ id: string; name: string; subtitle: string | null }>
}

type RoleTooltip = {
  anchorRect: DOMRect
  members: Array<{ name: string; subtitle: string | null }>
} | null

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

interface Props {
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
}

export function NotificationsSlideOver(
  { onClose, triggerRef, ref }: Props & { ref?: Ref<PopPanelHandle> },
) {
  const { refresh } = useNotifications()
  const [mentions, setMentions] = useState<Mention[]>([])
  const [roles, setRoles] = useState<RoleData[]>([])
  const [loading, setLoading] = useState(true)
  const [roleTooltip, setRoleTooltip] = useState<RoleTooltip>(null)

  // Internal ref so the × button can call close() with animation
  const innerRef = useRef<PopPanelHandle>(null)
  useImperativeHandle(ref, () => innerRef.current as PopPanelHandle, [])

  // The panel is portaled to <body> and positioned against the viewport.
  // On phones (≤768px, where the sidebar is a drawer) a fixed 400px panel
  // runs off the right edge, so span the viewport width with small insets.
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
  const positionStyle = isMobile
    ? { position: 'fixed' as const, top: 46, left: 8, right: 8, maxHeight: 'min(70vh, 560px)', display: 'flex' as const, flexDirection: 'column' as const, overflow: 'hidden' as const }
    : { position: 'fixed' as const, top: 46, left: 162, width: 400, maxHeight: 560, display: 'flex' as const, flexDirection: 'column' as const, overflow: 'hidden' as const }

  // Fetch notifications + roles + bulk mark-read on open
  useEffect(() => {
    async function load() {
      try {
        const [data, rolesData] = await Promise.all([
          apiFetch<{ unreadCount: number; mentions: Mention[] }>('/notifications'),
          apiFetch<RoleData[]>('/roles').catch(() => [] as RoleData[]),
        ])
        setMentions(data.mentions)
        setRoles(rolesData)
      } catch {}
      setLoading(false)
    }
    async function markAllRead() {
      try {
        await apiFetch('/notifications/mark-read', { method: 'POST' })
        await refresh()
      } catch {}
    }
    void load()
    void markAllRead()
  }, [refresh])

  function handleCommentMouseOver(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (target.dataset.type !== 'mention') return
    const dataId = target.dataset.id || ''
    const [type, id] = dataId.split(':')
    if (type !== 'role') return
    const role = roles.find(r => r.id === id)
    if (!role) return
    setRoleTooltip({
      anchorRect: target.getBoundingClientRect(),
      members: role.members.map(m => ({ name: m.name, subtitle: m.subtitle })),
    })
  }

  function handleCommentMouseOut(e: React.MouseEvent) {
    if ((e.target as HTMLElement).dataset.type === 'mention') setRoleTooltip(null)
  }

  return (
    <>
      <PopPanel
        ref={innerRef}
        onClose={onClose}
        triggerRef={triggerRef}
        ariaLabel="Mentions"
        transformOrigin="top left"
        enterOffsetY={-6}
        positionStyle={positionStyle}
      >
        <style>{`
          .notif-comment p { margin: 0; }
          .notif-comment p + p { margin-top: 3px; }
          .notif-comment blockquote {
            margin: 3px 0;
            padding-left: 10px;
            border-left: 2px solid #cbd5e1;
            color: #6b7280;
          }
          .notif-comment ul, .notif-comment ol { margin: 3px 0 3px 16px; padding: 0; }
          .notif-comment li { margin: 1px 0; }
          .notif-comment a { color: #2563eb; }
          .notif-comment span[data-type="mention"] { font-weight: 500; cursor: default; }
          .notif-comment span[data-type="mention"][data-id^="role:"] {
            background: #e0f2fe;
            color: #0369a1;
            border-radius: 99px;
            padding: 1px 7px;
          }
          .notif-comment span[data-type="mention"][data-id^="user:"] {
            background: #f1f5f9;
            color: #475569;
            border-radius: 4px;
            padding: 1px 5px;
          }
        `}</style>

        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '13px 16px 11px',
          borderBottom: `1px solid ${color.borderDefault}`,
          flexShrink: 0,
        }}>
          <span style={{ fontSize: fontSize.base, fontWeight: fontWeight.bold, color: color.textPrimary, letterSpacing: '-0.01em' }}>Mentions</span>
          <button
            onClick={() => innerRef.current?.close()}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: color.textMuted, fontSize: fontSize.xxl, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </div>

        {/* List */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {loading && (
            <div style={{ padding: 24, fontSize: fontSize.sm, color: color.textMuted, textAlign: 'center' }}>Loading…</div>
          )}

          {!loading && mentions.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: fontSize.sm, color: color.textMuted, lineHeight: 1.6 }}>
              No mentions yet — when someone @-tags you in a comment, it'll appear here.
            </div>
          )}

          {!loading && mentions.map(m => {
            const url = billUrl({ state: m.billState, sessionSlug: m.sessionSlug, billNumber: m.billNumber }) + `#comment-${m.commentId}`
            const safeHtml = DOMPurify.sanitize(m.commentHtml, PURIFY_CONFIG)
            // Role members for the attribution chip tooltip
            const attributionRole = m.sourceType === 'role' && m.sourceLabel
              ? roles.find(r => r.name === m.sourceLabel)
              : null

            const mentionedVia = m.sourceType === 'everyone'
              ? 'notified everyone'
              : m.sourceType === 'role' && m.sourceLabel
              ? (
                <>
                  mentioned{' '}
                  <span
                    style={{
                      display: 'inline-block',
                      background: color.bgBlueChip,
                      color: color.roleChipBlue,
                      borderRadius: radius.pill,
                      padding: '0 7px',
                      fontSize: fontSize.sm,
                      fontWeight: fontWeight.semibold,
                      cursor: 'default',
                    }}
                    onMouseEnter={e => {
                      if (!attributionRole) return
                      setRoleTooltip({
                        anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
                        members: attributionRole.members.map(mb => ({ name: mb.name, subtitle: mb.subtitle })),
                      })
                    }}
                    onMouseLeave={() => setRoleTooltip(null)}
                  >
                    @{m.sourceLabel}
                  </span>
                </>
              )
              : 'mentioned you'

            return (
              <Link
                key={m.id}
                to={url}
                onClick={() => onClose()}
                style={{
                  display: 'block',
                  padding: '12px 16px',
                  borderBottom: `1px solid ${color.surfaceMuted}`,
                  borderLeft: m.isUnread ? '3px solid #3b82f6' : '3px solid transparent',
                  background: m.isUnread ? color.bgInfo : color.white,
                  textDecoration: 'none',
                }}
              >
                {/* Author name · subtitle and time on same line */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textPrimary, minWidth: 0 }}>
                    {m.authorName}
                    {m.authorSubtitle && (
                      <span style={{ fontWeight: fontWeight.normal, color: color.textMuted, fontSize: fontSize.sm }}> · {m.authorSubtitle}</span>
                    )}
                  </div>
                  <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 0 }}>{relativeTime(m.createdAt)}</span>
                </div>

                {/* Navy bill chip + bill title inline */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, marginBottom: 5 }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}>
                    <BillBadge
                      billNumber={m.billNumber}
                      state={m.billState ?? undefined}
                      mini
                    />
                  </span>
                  <span style={{
                    fontFamily: '"Source Serif 4", "Source Serif", Georgia, serif',
                    fontSize: fontSize.sm,
                    fontWeight: fontWeight.bold,
                    color: color.billBadgeNavy,
                    lineHeight: 1.35,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    minWidth: 0,
                  }}>
                    {m.billTitle}
                  </span>
                </div>

                {/* Attribution line */}
                <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 8 }}>
                  {mentionedVia}
                </div>

                {/* Comment quote */}
                <div style={{
                  borderLeft: `3px solid ${color.borderStrong}`,
                  background: color.white,
                  padding: '6px 10px',
                  borderRadius: '0 6px 6px 0',
                  overflow: 'hidden',
                }}>
                  <div
                    className="notif-comment"
                    style={{
                      fontSize: fontSize.sm,
                      color: color.textSlate500,
                      lineHeight: 1.5,
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                    onMouseOver={handleCommentMouseOver}
                    onMouseOut={handleCommentMouseOut}
                    dangerouslySetInnerHTML={{ __html: safeHtml }}
                  />
                </div>
              </Link>
            )
          })}
        </div>
      </PopPanel>

      {/* Role tooltip portal — sibling to PopPanel so it's outside the panel's overflow:hidden */}
      {roleTooltip && createPortal(
        <div style={{
          ...TOOLTIP_STYLE,
          ...tooltipPositionBelow(roleTooltip.anchorRect),
          whiteSpace: 'normal',
          maxWidth: 260,
          padding: '6px 12px',
          zIndex: 9000,
        }}>
          <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginBottom: 4 }}>
            Users with this role
          </div>
          {roleTooltip.members.map((mb, i) => (
            <div key={i}>
              <span style={{ fontWeight: fontWeight.semibold, color: color.tooltipBg }}>{mb.name}</span>
              {mb.subtitle && <span style={{ color: color.textMuted, marginLeft: 4 }}>{mb.subtitle}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
