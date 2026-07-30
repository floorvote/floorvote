import { sortRoles } from '../../lib/chipStyles'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import type { Member } from './types'

export function MembersPopup({ members, currentUserId, onClose }: { members: Member[]; currentUserId?: string; onClose: () => void }) {
  const ROLE_ORDER: Record<string, number> = { owner: 0, admin: 1, member: 2 }
  const sorted = [...members].sort((a, b) => {
    if (a.id === currentUserId) return -1
    if (b.id === currentUserId) return 1
    const roleA = ROLE_ORDER[a.role] ?? 3
    const roleB = ROLE_ORDER[b.role] ?? 3
    if (roleA !== roleB) return roleA - roleB
    return (a.name || a.email).localeCompare(b.name || b.email)
  })

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 200 }}
      />
      <div style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 4,
        background: color.white,
        border: `1px solid ${color.borderDefault}`,
        borderRadius: radius.lg,
        boxShadow: shadow.md,
        zIndex: 201,
        maxHeight: 420,
        overflowY: 'auto',
      }}>
        {sorted.length === 0 && (
          <div style={{ padding: '12px 14px', fontSize: fontSize.sm, color: color.textMuted }}>No members found.</div>
        )}
        {sorted.map(m => (
          <div key={m.id} style={{ padding: '10px 14px', borderBottom: `1px solid ${color.surfaceMuted}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: color.billBadgeNavy }}>{m.name}</span>
              <span style={{
                fontSize: fontSize.xs, fontWeight: fontWeight.semibold,
                color: m.role === 'admin' || m.role === 'owner' ? color.brandViolet : color.textSlate500,
                background: m.role === 'admin' || m.role === 'owner' ? color.bgVioletChip : color.surfaceMuted,
                border: m.role === 'owner' ? `1px solid ${color.brandViolet}` : '1px solid transparent',
                borderRadius: radius.pill, padding: '2px 8px',
                whiteSpace: 'nowrap', lineHeight: 1.4,
              }}>
                {m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member'}
              </span>
            </div>
            <a href={`mailto:${m.email}`} className="blue-link" style={{ fontSize: fontSize.sm, display: 'block', marginBottom: m.subtitle ? 2 : 0 }}>{m.email}</a>
            {m.subtitle && <div style={{ fontSize: fontSize.xs, color: color.textMuted }}>{m.subtitle}</div>}
            {m.roles.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
                {sortRoles(m.roles).map(r => (
                  <span key={r.id} style={{ fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: color.roleMentionText, background: color.roleMentionBg, borderRadius: radius.pill, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
