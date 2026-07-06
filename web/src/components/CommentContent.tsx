import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import DOMPurify from 'dompurify'
import { MarkdownSummary } from './MarkdownSummary'
import { TOOLTIP_STYLE, ROLE_CHIP, tooltipPositionBelow, displayName, sortRoles } from '../lib/chipStyles'
import { color, fontSize, fontWeight } from '../styles/tokens'

const ALLOWED_TAGS = ['p', 'strong', 'em', 'a', 'blockquote', 'ul', 'ol', 'li', 'span', 'br', 's']
const ALLOWED_ATTR = ['href', 'target', 'rel', 'data-type', 'data-id', 'data-label']

// Explicit URI allowlist: restrict link schemes to http(s)/mailto/tel.
// DOMPurify already blocks `javascript:`/`data:` by default; pinning the regexp is
// defense-in-depth so a config/version change can't silently widen it. The shape
// mirrors DOMPurify's default (scheme branch + a non-scheme branch for plain /
// relative values) so non-URI attribute values like target="_blank" still pass —
// a naive `/^https?:/` regexp makes DOMPurify reject those and strips target/rel.
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i

// Force rel="noopener noreferrer" on any anchor that opens a new context
// (target=...), closing reverse-tabnabbing on user-authored comment links.
function forceLinkRel(node: Element) {
  if (node.tagName === 'A' && node.hasAttribute('target')) {
    node.setAttribute('rel', 'noopener noreferrer')
  }
}

export function sanitize(html: string): string {
  // Scope the hook to this call (add → sanitize → remove) so it can't leak into
  // other DOMPurify consumers in the app.
  DOMPurify.addHook('afterSanitizeAttributes', forceLinkRel)
  try {
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}

interface UserData {
  id: string
  name: string
  email: string
  subtitle: string | null
  roles?: { id: string; name: string }[]
}

interface RoleData {
  id: string
  name: string
  members: Array<{ id: string; name: string; email?: string; subtitle: string | null }>
}

interface MentionTooltipData {
  anchorRect: DOMRect
  type: 'user' | 'role'
  userName?: string
  userSubtitle?: string | null
  userRoles?: { id: string; name: string }[]
  roleFound?: boolean
  roleMembers?: Array<{ name: string; subtitle: string | null }>
}

interface Props {
  content: string
  users?: UserData[]
  roles?: RoleData[]
  fontSize?: number
}

export function CommentContent({ content, users = [], roles = [], fontSize: fontSizeValue = fontSize.base }: Props) {
  const [tooltip, setTooltip] = useState<MentionTooltipData | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const knownRoleIds = new Set(roles.map(r => r.id))
    containerRef.current.querySelectorAll<HTMLElement>('span[data-type="mention"][data-id^="role:"]').forEach(span => {
      const roleId = span.dataset.id?.slice('role:'.length)
      if (roleId && !knownRoleIds.has(roleId)) {
        span.style.background = color.surfaceMuted
        span.style.color = color.textMuted
      }
    })
  }, [content, roles])

  const isHtml = /<[a-z][\s\S]*>/i.test(content)

  if (!isHtml) {
    return <MarkdownSummary fontSize={fontSizeValue} color={color.textSlate} lineHeight={1.5} fontFamily="inherit">{content}</MarkdownSummary>
  }

  const html = sanitize(content)

  function handleMouseOver(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (target.dataset.type !== 'mention') return

    const dataId = target.dataset.id || ''
    const [type, id] = dataId.split(':')
    const anchorRect = target.getBoundingClientRect()

    if (type === 'role') {
      const role = roles.find(r => r.id === id)
      const roleMembers = role?.members.map(m => ({ name: displayName(m) || m.id, subtitle: m.subtitle })) ?? []
      setTooltip({ anchorRect, type: 'role', roleFound: role !== undefined, roleMembers })
    } else {
      const user = users.find(u => u.id === id)
      if (user) {
        setTooltip({ anchorRect, type: 'user', userName: displayName(user), userSubtitle: user.subtitle, userRoles: user.roles ?? [] })
      } else {
        setTooltip({ anchorRect, type: 'user', userName: target.dataset.label || id, userSubtitle: null, userRoles: [] })
      }
    }
  }

  function handleMouseOut(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (target.dataset.type === 'mention') {
      setTooltip(null)
    }
  }

  const containerRect = containerRef.current?.closest('[class*="CARD"], [style]')?.getBoundingClientRect()
    ?? containerRef.current?.getBoundingClientRect()

  return (
    <div
      ref={containerRef}
      onMouseOver={handleMouseOver}
      onMouseOut={handleMouseOut}
      style={{ position: 'relative' }}
    >
      <style>{`
        .comment-html p { margin: 0; }
        .comment-html p + p { margin-top: 4px; }
        .comment-html blockquote {
          margin: 4px 0;
          padding-left: 12px;
          border-left: 3px solid #cbd5e1;
          color: #6b7280;
        }
        .comment-html ul, .comment-html ol { margin: 4px 0 4px 18px; padding: 0; }
        .comment-html li { margin: 2px 0; }
        .comment-html a { color: #2563eb; text-decoration: none; }
        .comment-html a:hover { text-decoration: underline; }
        .comment-html span[data-type="mention"] {
          font-weight: 500;
          cursor: default;
        }
        .comment-html span[data-type="mention"][data-id^="role:"] {
          background: #e0f2fe;
          color: #0369a1;
          border-radius: 99px;
          padding: 2px 8px;
        }
        .comment-html span[data-type="mention"][data-id^="everyone:"] {
          background: #e0f2fe;
          color: #0369a1;
          border-radius: 99px;
          padding: 2px 8px;
        }
        .comment-html span[data-type="mention"][data-id^="user:"] {
          background: #f1f5f9;
          color: #475569;
          border-radius: 4px;
          padding: 1px 6px;
        }
      `}</style>
      <div
        className="comment-html"
        style={{ fontSize: fontSizeValue, color: color.textSlate, lineHeight: 1.5, fontFamily: 'inherit' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {tooltip && containerRect && createPortal(
        <div style={{
          ...TOOLTIP_STYLE,
          ...tooltipPositionBelow(tooltip.anchorRect, containerRect),
          whiteSpace: 'normal',
          maxWidth: Math.min(360, containerRect.right - containerRect.left),
          padding: '6px 12px',
        }}>
          {tooltip.type === 'user' ? (
            <>
              <div style={{ whiteSpace: 'nowrap' }}>
                <span style={{ fontWeight: fontWeight.semibold, color: color.tooltipBg }}>{tooltip.userName}</span>
                {tooltip.userSubtitle && (
                  <span style={{ color: color.textMuted, marginLeft: 4 }}>{tooltip.userSubtitle}</span>
                )}
              </div>
              {tooltip.userRoles && tooltip.userRoles.length > 0 && (
                <>
                  <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginTop: 6, marginBottom: 4 }}>Roles</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {sortRoles(tooltip.userRoles).map(r => (
                      <span key={r.id} style={ROLE_CHIP}>{r.name}</span>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {tooltip.roleFound === false ? (
                <div style={{ color: color.textMuted, fontStyle: 'italic' }}>This role no longer exists</div>
              ) : (
                <>
                  {tooltip.roleMembers && tooltip.roleMembers.length > 0 ? (
                    <>
                      <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginBottom: 4 }}>Users with this role</div>
                      {tooltip.roleMembers.map((m, i) => (
                        <div key={i}>
                          <span style={{ fontWeight: fontWeight.semibold, color: color.tooltipBg }}>{m.name}</span>
                          {m.subtitle && (
                            <span style={{ color: color.textMuted, marginLeft: 4 }}>{m.subtitle}</span>
                          )}
                        </div>
                      ))}
                    </>
                  ) : (
                    <div style={{ color: color.textMuted, fontStyle: 'italic' }}>No users with this role</div>
                  )}
                </>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
