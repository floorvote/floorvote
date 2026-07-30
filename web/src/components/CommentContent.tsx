import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownSummary } from './MarkdownSummary'
import { sanitizeHtml } from '../lib/sanitizeHtml'
import { TOOLTIP_STYLE, ROLE_CHIP, tooltipPositionBelow, displayName, sortRoles } from '../lib/chipStyles'
import { color, fontSize, fontWeight } from '../styles/tokens'
import { MENTION_STYLE } from '../../../shared/mentionStyle'

const ALLOWED_TAGS = ['p', 'strong', 'em', 'a', 'blockquote', 'ul', 'ol', 'li', 'span', 'br', 's']
const ALLOWED_ATTR = ['href', 'target', 'rel', 'data-type', 'data-id', 'data-label']

export function sanitize(html: string): string {
  return sanitizeHtml(html, { allowedTags: ALLOWED_TAGS, allowedAttr: ALLOWED_ATTR })
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
  // The mention the pointer is currently over, so we recompute the tooltip only
  // when it changes (not on every mouseover event within the same chip).
  const hoveredMentionRef = useRef<HTMLElement | null>(null)

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

  // Dismiss the mention tooltip on scroll/resize, and whenever the pointer
  // leaves the mention in ANY direction. The tooltip is position:fixed at the
  // anchor's coords captured on hover, so a scroll would otherwise strand it in
  // place (the pointer never leaves the mention during a scroll, so no mouseout
  // fires). Capture:true catches scrolls in nested containers.
  //
  // The pointer-leave check is a document-level rect test rather than the
  // container's mouseout/mouseleave: the tooltip is a pointer-events:none portal
  // sitting just below the mention, so moving straight down onto it fires no
  // container mouseout at all (and up/down within a comment can land on
  // sibling text that never crossed the mention edge cleanly). A plain rect
  // test against the anchored mention clears reliably in every direction.
  useEffect(() => {
    if (!tooltip) return
    const dismiss = () => setTooltip(null)
    const onMove = (e: MouseEvent) => {
      const el = hoveredMentionRef.current
      if (!el) { setTooltip(null); return }
      const r = el.getBoundingClientRect()
      if (e.clientX < r.left - 2 || e.clientX > r.right + 2 || e.clientY < r.top - 2 || e.clientY > r.bottom + 2) {
        hoveredMentionRef.current = null
        setTooltip(null)
      }
    }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    document.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('mousemove', onMove)
    }
  }, [tooltip])

  const isHtml = /<[a-z][\s\S]*>/i.test(content)

  if (!isHtml) {
    return <MarkdownSummary fontSize={fontSizeValue} color={color.textSlate} lineHeight={1.5} fontFamily="inherit">{content}</MarkdownSummary>
  }

  const html = sanitize(content)

  // Drive the tooltip off mouseover + closest() rather than a per-element
  // mouseout: a tiptap mention can wrap a nested child, so mouseout fires with
  // the child as target and never matches the mention — leaving the tooltip
  // stranded. Here every move re-reads the mention under the pointer; moving off
  // a mention (onto surrounding text, or out of the container) clears it.
  function handleMouseOver(e: React.MouseEvent) {
    const mention = (e.target as HTMLElement).closest<HTMLElement>('[data-type="mention"]')
    if (mention === hoveredMentionRef.current) return
    hoveredMentionRef.current = mention
    if (!mention) {
      setTooltip(null)
      return
    }

    const dataId = mention.dataset.id || ''
    const [type, id] = dataId.split(':')
    const anchorRect = mention.getBoundingClientRect()

    if (type === 'role') {
      const role = roles.find(r => r.id === id)
      const roleMembers = role?.members.map(m => ({ name: displayName(m) || m.id, subtitle: m.subtitle })) ?? []
      setTooltip({ anchorRect, type: 'role', roleFound: role !== undefined, roleMembers })
    } else {
      const user = users.find(u => u.id === id)
      if (user) {
        setTooltip({ anchorRect, type: 'user', userName: displayName(user), userSubtitle: user.subtitle, userRoles: user.roles ?? [] })
      } else {
        setTooltip({ anchorRect, type: 'user', userName: mention.dataset.label || id, userSubtitle: null, userRoles: [] })
      }
    }
  }

  function handleMouseLeave() {
    hoveredMentionRef.current = null
    setTooltip(null)
  }

  const containerRect = containerRef.current?.closest('[class*="CARD"], [style]')?.getBoundingClientRect()
    ?? containerRef.current?.getBoundingClientRect()

  return (
    <div
      ref={containerRef}
      onMouseOver={handleMouseOver}
      onMouseLeave={handleMouseLeave}
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
        /* Mention pills come from the shared MENTION_STYLE (role = indigo,
           user = gray) so posted comments, the composer (RichTextEditor.tsx),
           the notifications panel, and the emails can't drift. */
        .comment-html span[data-type="mention"][data-id^="role:"],
        .comment-html span[data-type="mention"][data-id^="everyone:"] {
          background: ${MENTION_STYLE.role.bg};
          color: ${MENTION_STYLE.role.text};
          border-radius: 99px;
          padding: 2px 8px;
        }
        .comment-html span[data-type="mention"][data-id^="user:"] {
          background: ${MENTION_STYLE.user.bg};
          color: ${MENTION_STYLE.user.text};
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
                      <div style={{ fontSize: fontSize.sm, color: color.textMuted, fontWeight: fontWeight.semibold, textTransform: 'uppercase', marginBottom: 4 }}>Members with this role</div>
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
                    <div style={{ color: color.textMuted, fontStyle: 'italic' }}>No members with this role</div>
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
