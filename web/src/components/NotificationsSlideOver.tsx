import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { Ref, RefObject } from 'react'
import DOMPurify from 'dompurify'
import { apiFetch } from '../lib/api'
import { useNotifications, type NotificationItem, type ReactionNotification } from '../context/NotificationsContext'
import { useDemo } from '../context/DemoContext'
import { isUnreadForDemo, readNotificationIds, markNotificationsRead } from '../lib/demoReadState'
import { billUrl } from '../lib/sessionSlug'
import { TOOLTIP_STYLE, tooltipPositionBelow } from '../lib/chipStyles'
import { BillBadge } from './BillBadge'
import { DraftChip } from './DraftChip'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { MENTION_STYLE } from '../../../shared/mentionStyle'
import { billDisplayTitle } from '../../../shared/billTitle'
import { PopPanel, type PopPanelHandle } from './ui/PopPanel'

const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'strong', 'em', 'a', 'blockquote', 'ul', 'ol', 'li', 'span', 'br', 's'],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'data-type', 'data-id', 'data-label', 'class'],
}

// Module-level so it's the same object reference on every render — an inline
// literal here would defeat CommentBody's memo just as surely as a fresh
// dangerouslySetInnerHTML object would.
const COMMENT_BODY_STYLE: React.CSSProperties = {
  fontSize: fontSize.sm,
  color: color.textSlate,
  lineHeight: 1.5,
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

// Isolated so an unrelated re-render of the row (e.g. opening the role
// tooltip) does not re-apply dangerouslySetInnerHTML and destroy the mention
// pill the pointer is currently over. React skips re-rendering this component
// — and so never touches its DOM — as long as `html` and all three handlers are
// referentially unchanged, which is why the parent passes a raw string and
// useCallback-wrapped handlers rather than recomputing them inline.
const CommentBody = memo(function CommentBody({
  html,
  onMouseOver,
  onMouseOut,
  onMouseLeave,
}: {
  html: string
  onMouseOver: (e: React.SyntheticEvent) => void
  onMouseOut: (e: React.SyntheticEvent) => void
  onMouseLeave: () => void
}) {
  const safeHtml = DOMPurify.sanitize(html, PURIFY_CONFIG)
  return (
    <div
      className="notif-comment"
      style={COMMENT_BODY_STYLE}
      onMouseOver={onMouseOver}
      onMouseOut={onMouseOut}
      onFocus={onMouseOver}
      onBlur={onMouseOut}
      onMouseLeave={onMouseLeave}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
})

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
  const { notifications: liveNotifications, loaded, refresh } = useNotifications()
  const { demoMode, demoResetAt, settled: demoSettled } = useDemo()
  const [snapshot, setSnapshot] = useState<NotificationItem[] | null>(null)
  const [roles, setRoles] = useState<RoleData[]>([])
  const [roleTooltip, setRoleTooltip] = useState<RoleTooltip>(null)
  const loading = snapshot === null

  // Internal ref so the × button can call close() with animation
  const innerRef = useRef<PopPanelHandle>(null)
  useImperativeHandle(ref, () => innerRef.current as PopPanelHandle, [])

  // The panel is portaled to <body> and positioned against the viewport.
  // On phones (≤768px, where the sidebar is a drawer) a fixed 400px panel
  // runs off the right edge, so span the viewport width with small insets.
  // Position is measured from the bell button's rect so the panel sits below
  // whatever is above it (topbar, demo banner, etc.) rather than hardcoding
  // a chrome-height offset that breaks when the banner is present.
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
  const bellBottom = triggerRef?.current?.getBoundingClientRect().bottom ?? 48
  const positionStyle = isMobile
    ? { position: 'fixed' as const, top: bellBottom + 4, left: 8, right: 8, maxHeight: 'min(70vh, 560px)', display: 'flex' as const, flexDirection: 'column' as const, overflow: 'hidden' as const }
    : { position: 'fixed' as const, top: bellBottom + 4, left: 162, width: 400, maxHeight: 560, display: 'flex' as const, flexDirection: 'column' as const, overflow: 'hidden' as const }

  // Freeze the mentions the context held when the panel opened.
  //
  // The freeze is load-bearing, not incidental. It is what makes the unread
  // treatment (blue rail + bgInfo) deterministic: the rows rendered are pre-read
  // by construction, so the mark-read POST below cannot erase the highlight it
  // exists to point at while the panel is still on screen. This used to be a
  // race — `void load(); void markAllRead()` fired concurrently, and when the
  // POST won, the GET came back with every row already read. Sequencing
  // GET-before-POST fixed the race but paid a request's latency on every open;
  // the context already polls that GET, so now there is nothing to wait for.
  //
  // demoSettled gates the freeze rather than the mark-read below, because the
  // branch taken *here* is what decides whether read state goes to localStorage
  // or to the server. `demoMode` reads false until GET /config resolves
  // (context/DemoContext.tsx), so a bell clicked in that window would otherwise
  // take the server branch on a demo tenant.
  useEffect(() => {
    if (!loaded || !demoSettled || snapshot !== null) return
    if (demoMode) {
      // Overlay the local set onto the server's isUnread before freezing: after a
      // reset the server calls every row unread again, and this browser's own
      // reading is the only record that survives it.
      const alreadyRead = readNotificationIds(demoResetAt)
      setSnapshot(liveNotifications.map(m => ({ ...m, isUnread: isUnreadForDemo(m, alreadyRead) })))
      markNotificationsRead(liveNotifications.map(m => m.id), demoResetAt)
      return
    }
    setSnapshot(liveNotifications)
  }, [loaded, demoSettled, liveNotifications, snapshot, demoMode, demoResetAt])

  // Mark read once per open, after the snapshot above has been taken — kept as
  // its own effect for readability. `markedRef` is what makes it once, not the
  // `snapshot === null` guard: the non-demo branch below writes the snapshot
  // back when it reconciles, which would otherwise retrigger this effect.
  const markedRef = useRef(false)
  useEffect(() => {
    if (snapshot === null || markedRef.current) return
    markedRef.current = true
    if (demoMode) {
      // Read state already went to localStorage in the freeze effect above —
      // the server's read_at is not usable on a demo. Still refresh so the
      // badge count (context's effectiveUnread) picks up the newly-read ids.
      void refresh()
      return
    }
    void (async () => {
      try {
        // Reconcile before marking read. POST /notifications/mark-read takes no
        // id list — it clears *every* unread row — while the snapshot above is
        // only as fresh as the context's last 30 s poll. A mention that arrived
        // in between would be marked read, and its badge cleared, without ever
        // having rendered its unread rail. Refreshing first pulls those rows in
        // so they are shown a beat after the panel paints instead of swallowed.
        // The panel still opens instantly: this runs after the first paint.
        const fresh = await refresh()
        setSnapshot(prev => {
          if (prev === null) return prev
          const shown = new Set(prev.map(m => m.id))
          const missing = fresh.filter(m => !shown.has(m.id))
          // A reaction row keeps its id as reactions arrive, so one already
          // shown is swapped for its fresh version, new reactors and all.
          const freshById = new Map(fresh.map(m => [m.id, m]))
          const updated = prev.map(m => (m.kind === 'reaction' && freshById.get(m.id)) || m)
          // isUnread comes from this pre-POST fetch, so it is the server's
          // answer as of the moment we are about to clear it — accurate for a
          // row already read elsewhere (BillDetail's mark-read-by-bill) too.
          // Re-sorted rather than prepended: newest-first is the order
          // GET /notifications returns and the panel renders in, and a merged
          // row is not guaranteed to be newer than everything on screen.
          return [...updated, ...missing].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        })
        await apiFetch('/notifications/mark-read', { method: 'POST' })
        // Second refresh, to drop the badge the click just cleared. Both were
        // already being made before the panel started reading the context's
        // cache — one as the panel's own GET on open, one after the POST.
        await refresh()
      } catch {}
    })()
  }, [snapshot, refresh, demoMode])

  // Role member lists, for the tooltip on a role-mention pill. Deliberately not
  // awaited alongside anything: a missing role list degrades to no tooltip, which
  // must never be a reason to hold back the panel.
  useEffect(() => {
    let cancelled = false
    apiFetch<RoleData[]>('/roles')
      .then(r => { if (!cancelled) setRoles(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Shared by mouse hover (onMouseOver/onMouseOut) and keyboard focus
  // (onFocus/onBlur, added below to satisfy jsx-a11y/mouse-events-have-key-events)
  // — both only read `e.target`, so a common React.SyntheticEvent parameter
  // type-checks for either event kind. None of today's mention spans carry a
  // tabIndex, so onFocus/onBlur don't yet fire from them in practice; they're
  // wired so a real focusable descendant (e.g. a link inside the comment body)
  // doesn't silently skip this affordance, and so the row is no longer
  // mouse-only per jsx-a11y's rule.
  // useCallback so CommentBody's memo actually holds: a fresh function
  // literal on every render would defeat it just as surely as a fresh
  // dangerouslySetInnerHTML object would.
  const handleCommentMouseOver = useCallback((e: React.SyntheticEvent) => {
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
  }, [roles])

  const handleCommentMouseOut = useCallback((e: React.SyntheticEvent) => {
    if ((e.target as HTMLElement).dataset.type === 'mention') setRoleTooltip(null)
  }, [])

  // Defence in depth: the container is what survives a mid-hover re-render
  // even when the pill inside it does not (dangerouslySetInnerHTML rebuilds
  // its children), so it's the reliable place to clear the tooltip from if a
  // future change ever reintroduces churn that detaches the hovered node
  // before it can fire mouseout.
  const handleCommentMouseLeave = useCallback(() => setRoleTooltip(null), [])

  return (
    <>
      <PopPanel
        ref={innerRef}
        onClose={onClose}
        triggerRef={triggerRef}
        ariaLabel="Notifications"
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
          .notif-comment span[data-type="mention"] { font-weight: ${MENTION_STYLE.weight}; cursor: default; }
          /* Mention pills from the shared MENTION_STYLE (role = indigo, user =
             gray) — in lockstep with ROLE_CHIP, CommentContent.tsx,
             RichTextEditor.tsx, and the emails; padding stays compact here. */
          .notif-comment span[data-type="mention"][data-id^="role:"],
          .notif-comment span[data-type="mention"][data-id^="everyone:"] {
            background: ${MENTION_STYLE.role.bg};
            color: ${MENTION_STYLE.role.text};
            border-radius: 99px;
            padding: 1px 7px;
          }
          .notif-comment span[data-type="mention"][data-id^="user:"] {
            background: ${MENTION_STYLE.user.bg};
            color: ${MENTION_STYLE.user.text};
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
          <span style={{ fontSize: fontSize.base, fontWeight: fontWeight.bold, color: color.textPrimary, letterSpacing: '-0.01em' }}>Notifications</span>
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

          {!loading && snapshot.length === 0 && (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: fontSize.sm, color: color.textMuted, lineHeight: 1.6 }}>
              No notifications yet. You'll see mentions of you here, replies on bills you've commented on, and reactions to your comments.
            </div>
          )}

          {/* One renderer per notification kind. A kind this build does not
              know yet (a newer server) is skipped rather than drawn wrong. */}
          {!loading && snapshot.map(n => {
            switch (n.kind) {
              case 'reaction':
                return (
                  <ReactionRow
                    key={n.id}
                    m={n}
                    onClose={onClose}
                    onCommentMouseOver={handleCommentMouseOver}
                    onCommentMouseOut={handleCommentMouseOut}
                    onCommentMouseLeave={handleCommentMouseLeave}
                  />
                )
              case 'mention':
              case 'reply':
                return (
                  <NotificationRow
                    key={n.id}
                    m={n}
                    roles={roles}
                    onClose={onClose}
                    setRoleTooltip={setRoleTooltip}
                    onCommentMouseOver={handleCommentMouseOver}
                    onCommentMouseOut={handleCommentMouseOut}
                    onCommentMouseLeave={handleCommentMouseLeave}
                  />
                )
              default:
                return null
            }
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
            Members with this role
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

/**
 * The panel row for a `mention` or `reply` notification. The two differ only in
 * the sentence that names what the author did. Everything below it (the comment,
 * the bill footer, the unread rail) is the same.
 */
function NotificationRow({
  m,
  roles,
  onClose,
  setRoleTooltip,
  onCommentMouseOver,
  onCommentMouseOut,
  onCommentMouseLeave,
}: {
  m: Extract<NotificationItem, { kind: 'mention' | 'reply' }>
  roles: RoleData[]
  onClose: () => void
  setRoleTooltip: (t: RoleTooltip) => void
  onCommentMouseOver: (e: React.SyntheticEvent) => void
  onCommentMouseOut: (e: React.SyntheticEvent) => void
  onCommentMouseLeave: () => void
}) {
  // Role members for the attribution chip tooltip
  const attributionRole = m.kind === 'mention' && m.sourceType === 'role' && m.sourceLabel
    ? roles.find(r => r.name === m.sourceLabel)
    : null

  // Phrased as the matching email phrases it (api/src/lib/mentions.ts and
  // replies.ts).
  const action = m.kind === 'reply'
    ? "commented on a bill you've commented on"
    : m.sourceType === 'everyone'
    ? 'notified everyone'
    : m.sourceType === 'role' && m.sourceLabel
    ? (
      <>
        mentioned{' '}
        <span
          // The member list is also shown in a hover-only tooltip
          // (onMouseEnter/onMouseLeave below) — that bubble is a
          // purely mouse-triggered affordance, so `title` carries
          // the same list as a native, non-hover-dependent fallback
          // for screen-reader and keyboard/touch users.
          title={attributionRole
            ? `${attributionRole.name}: ${attributionRole.members.map(mb => mb.name).join(', ')}`
            : undefined}
          // Geometry and weight are deliberately identical to the role
          // pill inside the comment body (the CSS block above), to the
          // shared ROLE_CHIP, and to the emails — all MENTION_STYLE.weight.
          // This chip used to be semibold with different padding, which
          // read as a bug whenever a role mention printed it twice in one
          // row. The two pills differ in size only because each inherits
          // its own line's font size.
          style={{
            display: 'inline-block',
            background: MENTION_STYLE.role.bg,
            color: MENTION_STYLE.role.text,
            borderRadius: radius.pill,
            padding: '1px 7px',
            fontWeight: MENTION_STYLE.weight,
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
    <RowFrame
      m={m}
      onClose={onClose}
      headline={
        <>
          <span style={{ fontWeight: fontWeight.semibold, color: color.textPrimary }}>{m.authorName}</span>
          {' '}
          {action}
        </>
      }
      onCommentMouseOver={onCommentMouseOver}
      onCommentMouseOut={onCommentMouseOut}
      onCommentMouseLeave={onCommentMouseLeave}
    />
  )
}

/**
 * The shell every row shares: the link to the comment, the unread rail, a
 * one-line headline with the time, the comment, and the bill footer.
 */
function RowFrame({
  m,
  headline,
  onClose,
  onCommentMouseOver,
  onCommentMouseOut,
  onCommentMouseLeave,
}: {
  m: NotificationItem
  headline: React.ReactNode
  onClose: () => void
  onCommentMouseOver: (e: React.SyntheticEvent) => void
  onCommentMouseOut: (e: React.SyntheticEvent) => void
  onCommentMouseLeave: () => void
}) {
  const url = billUrl({ state: m.billState, sessionSlug: m.sessionSlug, billNumber: m.billNumber }) + `#comment-${m.commentId}`
  return (
    <Link
      to={url}
      onClick={() => onClose()}
      style={{
        display: 'block',
        padding: '11px 16px 12px',
        borderBottom: `1px solid ${color.borderDefault}`,
        borderLeft: m.isUnread ? `3px solid ${color.accentBlue}` : '3px solid transparent',
        background: m.isUnread ? color.bgInfo : color.white,
        textDecoration: 'none',
      }}
    >
      {/* One sentence, phrased exactly as the mention email phrases it
          ("{author} mentioned @{role}" — api/src/lib/mentions.ts), so the
          panel reads as the same message the recipient already has in
          their inbox. It replaces what used to be two separate lines: an
          author line and a standalone attribution line. The author's
          subtitle is deliberately dropped — in a 400px panel it cost a
          line's worth of attention for a detail the name usually carries. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, minWidth: 0 }}>
          {headline}
        </div>
        <span style={{ fontSize: fontSize.sm, color: color.textMuted, flexShrink: 0 }}>{relativeTime(m.createdAt)}</span>
      </div>

      {/* The comment is the primary content — it's what you opened the
          panel to read — but it is promoted by *colour*, not size: every
          line in the row (this, the sentence above, the footer below) is
          fontSize.sm, because a mention pill inherits its line's size and
          two sizes of the same pill in one row read as an inconsistency
          rather than a hierarchy. Rendered verbatim: a mention can sit
          anywhere in a sentence, so a role pill can't be stripped from the
          front just because the line above names the same role. One size
          and one weight is what makes that repeat read as a quote. */}
      <CommentBody
        html={m.commentHtml}
        onMouseOver={onCommentMouseOver}
        onMouseOut={onCommentMouseOut}
        onMouseLeave={onCommentMouseLeave}
      />

      {/* Bill footer — one line, single-line-ellipsized. The bill stays
          identifiable without the two-line serif title block competing
          with the comment above it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 8, minWidth: 0 }}>
        {/* Room for the visible chip: this footer is a single flex
            line whose only flexible item is the title, which already
            ellipsizes by design — the chip shortens the title rather
            than wrapping or clipping anything. Mini, to match the
            mini badge it sits beside. */}
        <BillBadge
          billNumber={m.billNumber}
          state={m.billState ?? undefined}
          mini
          isDraft={m.billIsDraft}
        />
        {m.billIsDraft && <DraftChip mini />}
        <span style={{
          fontFamily: '"Source Serif 4", "Source Serif", Georgia, serif',
          fontSize: fontSize.sm,
          color: color.textMuted,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}>
          {billDisplayTitle({ title: m.billTitle, isDraft: m.billIsDraft })}
        </span>
      </div>
    </Link>
  )
}

/**
 * The panel row for a `reaction` notification: one per comment, however many
 * members reacted. It names the newest reactor and counts the rest, and shows
 * the member's own comment.
 */
function ReactionRow({
  m,
  onClose,
  onCommentMouseOver,
  onCommentMouseOut,
  onCommentMouseLeave,
}: {
  m: ReactionNotification
  onClose: () => void
  onCommentMouseOver: (e: React.SyntheticEvent) => void
  onCommentMouseOut: (e: React.SyntheticEvent) => void
  onCommentMouseLeave: () => void
}) {
  const first = m.reactors[0]?.name ?? 'Someone'
  const others = m.reactorCount - 1
  // Two reactors are both named. From three on, the rest are counted.
  const who = others === 0
    ? first
    : others === 1
    ? `${first} and ${m.reactors[1]?.name ?? 'someone'}`
    : `${first} and ${others} others`
  return (
    <RowFrame
      m={m}
      onClose={onClose}
      headline={
        <>
          <span style={{ fontWeight: fontWeight.semibold, color: color.textPrimary }}>{who}</span>
          {' '}
          reacted to your comment
        </>
      }
      onCommentMouseOver={onCommentMouseOver}
      onCommentMouseOut={onCommentMouseOut}
      onCommentMouseLeave={onCommentMouseLeave}
    />
  )
}

