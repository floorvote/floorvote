import { useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { accountRoleChip, accountRoleLabel, ROLE_CHIP, sortRoles } from '../../lib/chipStyles'
import { useIsBreakpoint } from '../../hooks/use-is-breakpoint'
import { color, radius, fontSize, fontWeight } from '../../styles/tokens'
import { MemberNameCell } from '../MemberNameCell'
import { PopPanel } from '../ui/PopPanel'
import type { Member } from './types'

// Panel width. The sidebar is 230px by default (resizable to 400), so the panel
// deliberately overflows rightward over the content area — the three columns do
// not fit inside the rail, and pinning them there is what used to force
// horizontal scrolling on long email addresses.
const PANEL_WIDTH = 470
const VIEWPORT_MARGIN = 8

// Below this width the popover becomes a full-height sheet instead. The mobile
// sidebar is a 280px drawer from 768px down, and a 470px popover anchored to it
// would hang off the right edge of a 375px phone.
const SHEET_BREAKPOINT = 620

const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2 }

const TH: CSSProperties = {
  // Sticky inside the scroll container below, on an opaque white fill and above
  // the rows — otherwise scrolled rows show through the header.
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: color.white,
  textAlign: 'left',
  padding: '8px 12px',
  color: color.textSecondary,
  fontWeight: fontWeight.semibold,
  borderBottom: `2px solid ${color.borderDefault}`,
}

const TD: CSSProperties = { padding: '10px 12px', verticalAlign: 'top' }

// ROLE_CHIP is nowrap everywhere else, where a chip sits in a row that can grow.
// Here it sits in a fixed-width column inside an overflowX-hidden scroller, so a
// real role name ("Technology & Modernization") would be silently clipped at the
// column edge. Let the label wrap instead — the admin table, which scrolls
// horizontally, keeps the nowrap original.
const POPUP_ROLE_CHIP: CSSProperties = { ...ROLE_CHIP, whiteSpace: 'normal' }

export function MembersPopup({
  members,
  currentUserId,
  rolesLabel,
  triggerRef,
  onClose,
}: {
  members: Member[]
  currentUserId?: string
  /** `${titleCase(orgNoun)} roles` — see orgRolesLabel. Tenants rename the noun. */
  rolesLabel: string
  /** The "N members" button wrapper; anchors the panel and owns close-on-retap. */
  triggerRef?: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const isSheet = useIsBreakpoint('max', SHEET_BREAKPOINT)

  // Measured once, at open, exactly like CustomizeSidebar's trigger rect. The
  // panel is portaled to <body> by PopPanel, so these are viewport coordinates.
  const [anchor] = useState(() => triggerRef?.current?.getBoundingClientRect() ?? null)

  const sorted = [...members].sort((a, b) => {
    if (a.id === currentUserId) return -1
    if (b.id === currentUserId) return 1
    const roleA = ROLE_ORDER[a.role] ?? 3
    const roleB = ROLE_ORDER[b.role] ?? 3
    if (roleA !== roleB) return roleA - roleB
    return (a.name || a.email).localeCompare(b.name || b.email)
  })

  // Keyed off the data, not the label: an org that has never created a custom
  // role gets two columns rather than an always-empty third. This is popup-only
  // — the admin table's roles column carries the "Add role" button, and hiding
  // it in a fresh org would make roles unassignable.
  const showRoles = members.some(m => m.roles.length > 0)

  const positionStyle: CSSProperties = isSheet
    ? {
        position: 'fixed',
        top: 12, left: 12, right: 12, bottom: 12,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }
    : {
        position: 'fixed',
        // Clamped so the panel can never run off the right edge, however wide
        // the user has dragged the sidebar.
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(anchor?.left ?? VIEWPORT_MARGIN, window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN),
        ),
        // Bottom-anchored: the trigger sits at the foot of the sidebar, so the
        // panel grows upward from just above it.
        bottom: anchor ? window.innerHeight - anchor.top + 6 : 70,
        width: PANEL_WIDTH,
        maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }

  return (
    <PopPanel
      onClose={onClose}
      positionStyle={positionStyle}
      transformOrigin={isSheet ? 'center' : 'bottom left'}
      enterOffsetY={isSheet ? 0 : 6}
      triggerRef={triggerRef}
      ariaLabel="Members"
      cornerRadius={radius.lg}
    >
      {isSheet && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 14px', flexShrink: 0,
          borderBottom: `1px solid ${color.borderDefault}`,
        }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: color.textPrimary }}>Members</span>
          <span style={{
            fontSize: fontSize.xs, color: color.countChipText, background: color.countChipBg,
            borderRadius: radius.pill, padding: '1px 7px', fontWeight: fontWeight.normal,
          }}>{members.length}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close members"
            style={{
              marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
              color: color.textSecondary, padding: 0, lineHeight: 1,
              fontSize: fontSize.xxl, fontWeight: fontWeight.normal,
            }}
          >
            {/* Literal glyph, matching the sidebar drawer's own close control —
                no Material Symbol to register in index.html's icon_names. */}
            ×
          </button>
        </div>
      )}

      <div style={{
        // The scroll container the headers stick inside. overflowX is hidden
        // (paired with word-break on the email) so a long address wraps rather
        // than widening the table into a horizontal scrollbar.
        maxHeight: isSheet ? undefined : 420,
        flex: isSheet ? 1 : undefined,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}>
        {sorted.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: fontSize.sm, color: color.textMuted }}>No members found.</div>
        ) : (
          // `members-table` / `members-name-cell` / `data-label` are the admin
          // Members table's class contract; reusing them gets the mobile
          // stacked-card treatment in styles/mobile.css for free.
          <table className="members-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: fontSize.sm }}>
            <thead>
              <tr>
                <th style={{ ...TH, width: showRoles ? '46%' : '68%' }}>Name</th>
                <th style={{ ...TH, width: showRoles ? '20%' : '32%' }}>Role</th>
                {showRoles && <th style={{ ...TH, width: '34%' }}>{rolesLabel}</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map(m => (
                <tr key={m.id} style={{ borderBottom: `1px solid ${color.surfaceMuted}` }}>
                  <td className="members-name-cell" style={TD}>
                    <MemberNameCell
                      name={m.name}
                      email={m.email}
                      subtitle={m.subtitle}
                      isSelf={m.id === currentUserId}
                    />
                  </td>
                  <td data-label="Role" style={TD}>
                    <span style={accountRoleChip(m.role)}>{accountRoleLabel(m.role)}</span>
                  </td>
                  {showRoles && (
                    // Read-only: no remove-X and no "Add role" button. Editing
                    // roles is admin-only and lives on /admin/members.
                    <td data-label={rolesLabel} style={TD}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {m.roles.length === 0
                          // The column only exists because some member has a role;
                          // one who has none still needs a mark, or the mobile
                          // card shows a bare label with nothing beside it.
                          ? <span style={{ color: color.textMuted }}>—</span>
                          : sortRoles(m.roles).map(r => (
                            <span key={r.id} style={POPUP_ROLE_CHIP}>{r.name}</span>
                          ))}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </PopPanel>
  )
}
