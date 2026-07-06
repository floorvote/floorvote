import { useEffect, useState } from 'react'
import { apiFetch, ApiError } from '../../lib/api'
import { parseInvitees } from '../../lib/parseInvitees'
import { useAuth } from '../../hooks/useAuth'
import { SettingsNav } from '../../components/SettingsNav'
import { InfoTooltip } from '../../components/InfoTooltip'
import { HintText } from '../../components/HintText'
import { CARD } from '../../lib/cardStyle'
import { CARD_TITLE, FORM_LABEL, HELPER_TEXT } from '../../lib/textStyles'
import { relativeTime, absoluteTime, feedTsToEpoch } from '../../lib/time'
import { displayName, ADMIN_BADGE, ROLE_CHIP, ROLE_CHIP_X, sortRoles } from '../../lib/chipStyles'
import { usePageTitle } from '../../hooks/usePageTitle'
import { useDemo } from '../../context/DemoContext'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { titleCase } from '../../lib/orgNoun'

type Role = { id: string; name: string }

type Member = {
  id: string
  email: string
  name: string
  role: 'admin' | 'member' | 'owner'
  subtitle: string | null
  createdAt: string
  lastActive: string
  deactivatedAt: string | null
  hasLoggedIn: boolean
  invitedBy: { id: string; name: string | null; email: string } | null
  roles: Role[]
  canVote: boolean
  voteCount: number
  loginTrouble?: boolean
}

interface AuthEvent {
  id: string
  event: string
  reason: string | null
  linkType: string | null
  provider: string | null
  ipCountry: string | null
  createdAt: string
  messageId?: string | null
}

interface DeliveryEntry {
  status: string
  isSpam: boolean
  errorCause?: string
  datetime?: string
}

interface AuthEventsResponse {
  events: AuthEvent[]
  suppression: { suppressed: boolean | null; reason?: string; createdAt?: string }
  delivery: Record<string, DeliveryEntry>
}

type UnknownAttempt = { id: string; email: string; ipCountry: string | null; userAgent: string | null; createdAt: string }

function authEventLabel(event: AuthEvent): string {
  switch (event.event) {
    case 'link_requested':
      return event.linkType === 'invite' ? 'Invite sent' : 'Login link requested'
    case 'email_sent':
      return 'Email sent'
    case 'email_bounced':
      return 'Email bounced'
    case 'email_send_failed':
      return event.reason ? `Email send failed (${event.reason})` : 'Email send failed'
    case 'verify_success':
      return 'Signed in'
    case 'verify_failed':
      return event.reason ? `Link failed (${event.reason})` : 'Link failed'
    case 'logout':
      return 'Logged out'
    case 'rate_limited':
      return 'Rate-limited (too many active links)'
    case 'email_delivered':
      return 'Email delivered'
    case 'email_complained':
      return 'Spam complaint'
    default:
      return event.event
  }
}

function deliveryPillStyle(variant: 'spam' | 'bounced' | 'delivered' | 'neutral'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    padding: '1px 6px',
    borderRadius: radius.sm,
    marginLeft: 6,
    display: 'inline-block',
    whiteSpace: 'nowrap',
  }
  if (variant === 'spam') return { ...base, background: color.bgWarnSoft, color: color.textAmberDark }
  if (variant === 'bounced') return { ...base, background: color.bgDangerSoft, color: color.textDanger }
  if (variant === 'delivered') return { ...base, background: color.bgSuccess, color: color.textSuccess }
  return { ...base, background: color.surfaceMuted, color: color.textSlate500 }
}

function DeliveryPill({ entry }: { entry: DeliveryEntry }): React.ReactElement<any> | null {
  if (entry.isSpam) {
    return <span style={deliveryPillStyle('spam')}>spam folder</span>
  }
  const statusLower = entry.status.toLowerCase()
  if (statusLower.includes('fail') || statusLower.includes('bounce') || entry.errorCause) {
    const label = 'bounced' + (entry.errorCause ? ` (${entry.errorCause})` : '')
    return <span style={deliveryPillStyle('bounced')}>{label}</span>
  }
  if (entry.status === 'delivered') {
    return <span style={deliveryPillStyle('delivered')}>delivered</span>
  }
  return <span style={deliveryPillStyle('neutral')}>{entry.status}</span>
}

function relativeTimeFromEpoch(ts: string): string {
  const ms = Date.now() - feedTsToEpoch(ts)
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return minutes <= 1 ? 'Just now' : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'Yesterday' : `${days}d ago`
}

export function Members() {
  usePageTitle('Members')
  const { user } = useAuth()
  const { demoLocked } = useDemo()

  // Invite form state
  const [inviteText, setInviteText] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [inviteLoading, setInviteLoading] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  type BulkResult = { email: string; status: 'invited' | 'exists' | 'duplicate' | 'invalid'; userId?: string }
  type BulkSummary = { invited: number; exists: number; duplicate: number; invalid: number }
  const [inviteResult, setInviteResult] = useState<{ summary: BulkSummary; results: BulkResult[] } | null>(null)

  // Members list state
  const [members, setMembers] = useState<Member[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [memberSearch, setMemberSearch] = useState('')

  // Role management state
  const [orgRoles, setOrgRoles] = useState<Role[]>([])
  const [newRoleName, setNewRoleName] = useState('')
  const [addingRole, setAddingRole] = useState(false)
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null)
  const [editingRoleName, setEditingRoleName] = useState('')
  const [openRoleDropdown, setOpenRoleDropdown] = useState<string | null>(null)
  const [dropdownAnchor, setDropdownAnchor] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const [rolesLabel, setRolesLabel] = useState('Team roles')

  // Actions dropdown state
  const [openActionsMenu, setOpenActionsMenu] = useState<string | null>(null)
  const [actionsAnchor, setActionsAnchor] = useState<{ top: number; left: number; openUp: boolean } | null>(null)

  // Login activity panel state
  const [activityMember, setActivityMember] = useState<Member | null>(null)
  const [activityData, setActivityData] = useState<AuthEventsResponse | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityError, setActivityError] = useState<string | null>(null)

  // Unknown login attempts panel state
  const [unknownAttempts, setUnknownAttempts] = useState<UnknownAttempt[]>([])
  const [unknownOpen, setUnknownOpen] = useState(false)
  const [unknownLoading, setUnknownLoading] = useState(false)

  // Toast state
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      apiFetch<Member[]>('/admin/members'),
      apiFetch<Role[]>('/admin/roles'),
      apiFetch<{ org_noun?: string }>('/admin/config'),
    ])
      .then(([memberData, roleData, configData]) => {
        setMembers(memberData)
        setOrgRoles(roleData)
        const noun = configData.org_noun ?? 'team'
        setRolesLabel(`${titleCase(noun)} roles`)
      })
      .catch(() => setListError('Failed to load members.'))
      .finally(() => setListLoading(false))
  }, [])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviteLoading(true)
    setInviteError(null)
    setInviteResult(null)

    const parsed = parseInvitees(inviteText)
    if (parsed.length === 0) {
      setInviteError('Enter at least one email address.')
      setInviteLoading(false)
      return
    }

    try {
      const res = await apiFetch<{ summary: BulkSummary; results: BulkResult[] }>(
        '/admin/members/bulk-invite',
        {
          method: 'POST',
          body: JSON.stringify({
            role: inviteRole,
            invitees: parsed.map(p => ({ name: p.name, email: p.email })),
          }),
        },
      )
      setInviteResult(res)
      if (res.summary.invited > 0) {
        setInviteText('')
        setInviteRole('member')
        // Refresh the list, but don't let a refresh failure mask the success summary.
        try {
          const updated = await apiFetch<Member[]>('/admin/members')
          setMembers(updated)
        } catch {
          /* invites were created; the stale list refreshes on next load */
        }
      }
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Failed to send invites.')
    } finally {
      setInviteLoading(false)
    }
  }

  async function handleRoleChange(member: Member, newRole: 'member' | 'admin' | 'owner') {
    const isSelf = member.id === user?.id
    if (isSelf && (newRole === 'member' || (newRole === 'admin' && member.role === 'owner'))) {
      const action = newRole === 'member' ? 'Demote yourself to Member' : 'Demote yourself to Admin'
      if (!window.confirm(`${action}?\n\nYou may lose access to some features immediately.`)) return
    }
    try {
      await apiFetch(`/admin/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      })
      if (isSelf && newRole === 'member') {
        window.location.href = '/'
        return
      }
      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)),
      )
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update role.')
    }
  }

  async function handleDeactivateToggle(member: Member) {
    const isSelf = member.id === user?.id
    const deactivated = !member.deactivatedAt
    if (isSelf && deactivated) {
      if (!window.confirm('Deactivate your own account?\n\nYou will be logged out immediately. An admin can reactivate your account later.')) return
    }
    try {
      await apiFetch(`/admin/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ deactivated }),
      })
      if (isSelf && deactivated) {
        window.location.href = '/'
        return
      }
      setMembers((prev) =>
        prev.map((m) =>
          m.id === member.id
            ? { ...m, deactivatedAt: deactivated ? new Date().toISOString() : null }
            : m,
        ),
      )
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update status.')
    }
  }

  async function handleCanVoteToggle(member: Member) {
    const canVote = !member.canVote
    if (!canVote && member.voteCount > 0) {
      const plural = member.voteCount === 1 ? 'vote' : 'votes'
      const name = displayName(member)
      const confirmed = window.confirm(
        `${name} has cast ${member.voteCount} ${plural}. Their votes will be removed from tallies if you uncheck "Can vote" but will be re-added if you recheck it.\n\nUncheck "Can vote" for ${name}?`
      )
      if (!confirmed) return
    }
    try {
      await apiFetch(`/admin/members/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ canVote }),
      })
      setMembers((prev) =>
        prev.map((m) =>
          m.id === member.id ? { ...m, canVote } : m,
        ),
      )
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update voting status.')
    }
  }

  async function handleDelete(member: Member) {
    if (!window.confirm(
      `Delete ${displayName(member)}?\n\nThis permanently removes their account, votes, comments, notes, and activity. This cannot be undone.`
    )) return
    try {
      await apiFetch(`/admin/members/${member.id}`, { method: 'DELETE' })
      setMembers((prev) => prev.filter((m) => m.id !== member.id))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete member.')
    }
  }

  async function handleDeleteSelf() {
    if (!window.confirm(
      `Delete your own account?\n\nThis permanently removes your account, votes, comments, notes, and activity. You will be logged out immediately. This cannot be undone.`
    )) return
    try {
      await apiFetch('/users/me', { method: 'DELETE' })
      window.location.href = '/'
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete account.')
    }
  }

  async function handleResendInvite(member: Member) {
    try {
      await apiFetch(`/admin/members/${member.id}/resend-invite`, { method: 'POST' })
      alert(`Invite resent to ${member.email}.`)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to resend invite.')
    }
  }

  async function handleAddRole() {
    const name = newRoleName.trim()
    if (!name) return
    setAddingRole(true)
    try {
      const created = await apiFetch<Role>('/admin/roles', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      setOrgRoles(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
      setNewRoleName('')
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to create role.')
    } finally {
      setAddingRole(false)
    }
  }

  async function handleRenameRole(roleId: string, newName: string) {
    const name = newName.trim()
    const original = orgRoles.find(r => r.id === roleId)?.name
    setEditingRoleId(null)
    if (!name || name === original) return
    try {
      const updated = await apiFetch<Role>(`/admin/roles/${roleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      })
      setOrgRoles(prev =>
        prev.map(r => r.id === roleId ? updated : r).sort((a, b) => a.name.localeCompare(b.name))
      )
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to rename role.')
    }
  }

  async function handleDeleteRole(roleId: string) {
    if (!window.confirm('Delete this role? It will be removed from all members.')) return
    try {
      await apiFetch(`/admin/roles/${roleId}`, { method: 'DELETE' })
      setOrgRoles(prev => prev.filter(r => r.id !== roleId))
      setMembers(prev => prev.map(m => ({ ...m, roles: m.roles.filter(r => r.id !== roleId) })))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to delete role.')
    }
  }

  async function openActivity(member: Member) {
    setActivityMember(member)
    setActivityData(null)
    setActivityError(null)
    setActivityLoading(true)
    try {
      const data = await apiFetch<AuthEventsResponse>(`/admin/members/${member.id}/auth-events`)
      setActivityData(data)
    } catch (err) {
      setActivityError(err instanceof ApiError ? err.message : 'Failed to load login activity.')
    } finally {
      setActivityLoading(false)
    }
  }

  async function loadUnknownAttempts() {
    setUnknownLoading(true)
    try {
      const data = await apiFetch<{ attempts: UnknownAttempt[] }>('/admin/unknown-login-attempts')
      setUnknownAttempts(data.attempts)
    } catch { /* silent */ }
    setUnknownLoading(false)
  }

  async function resendLogin(email: string) {
    try {
      await apiFetch('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) })
      setToast(`Login link sent to ${email}.`)
      setTimeout(() => setToast(null), 4000)
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to send login link.')
    }
  }

  async function handleSetMemberRoles(memberId: string, roleIds: string[]) {
    try {
      await apiFetch(`/admin/members/${memberId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds }),
      })
      const roleMap = new Map(orgRoles.map(r => [r.id, r]))
      setMembers(prev => prev.map(m =>
        m.id === memberId
          ? { ...m, roles: roleIds.map(id => roleMap.get(id)!).filter(Boolean) }
          : m
      ))
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to update roles.')
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    fontSize: fontSize.sm,
    padding: '8px 10px',
    border: `1px solid ${color.borderDefault}`,
    borderRadius: radius.md,
    boxSizing: 'border-box',
    fontFamily: 'inherit',
  }
  const btnPrimary: React.CSSProperties = {
    background: color.accentBlue,
    color: color.white,
    border: 'none',
    borderRadius: radius.md,
    padding: '8px 20px',
    cursor: 'pointer',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  }
  const btnSmall: React.CSSProperties = {
    fontSize: fontSize.sm,
    padding: '4px 10px',
    borderRadius: radius.sm,
    border: `1px solid ${color.borderDefault}`,
    background: color.white,
    cursor: 'pointer',
    color: color.textSlate,
  }
  const chipAddRole: React.CSSProperties = {
    fontSize: fontSize.xs, fontWeight: fontWeight.medium, color: color.roleChipBlue,
    background: 'transparent', border: `1.5px dashed ${color.borderBlueDash}`,
    borderRadius: radius.pill, padding: '2px 9px',
    display: 'inline-flex', alignItems: 'center',
    whiteSpace: 'nowrap', cursor: 'pointer',
  }
  const chipSystem = (isAdmin: boolean): React.CSSProperties => isAdmin
    ? ADMIN_BADGE
    : { ...ADMIN_BADGE, color: color.textSlate500, background: color.surfaceMuted }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900, margin: '0 auto' }}>
      <SettingsNav />
      {demoLocked && (
        <div style={{ fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 16, padding: '8px 12px', background: color.surfaceSubtle, borderRadius: radius.md, border: `1px solid ${color.borderDefault}` }}>
          This is a demo instance — member management is read-only.
        </div>
      )}
      {/* Invite form card */}
      <div style={{ ...CARD, padding: 24, marginBottom: 24 }}>
        <div style={CARD_TITLE}>Invite new members</div>
        <form onSubmit={demoLocked ? (e) => e.preventDefault() : handleInvite}>
          <div style={{ marginBottom: 16 }}>
            <label style={FORM_LABEL}>Invitees</label>
            <textarea
              value={inviteText}
              onChange={(e) => { setInviteText(e.target.value); setInviteResult(null) }}
              placeholder={'Jane Doe, jane@example.com'}
              rows={5}
              style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', lineHeight: 1.5 }}
            />
            <div style={{ ...HELPER_TEXT, marginTop: 6 }}>
              <HintText text={'One invitee per line. Lines can be:\n`jane@example.com`\n`Jane Doe, jane@example.com`\n`Jane Doe <jane@example.com>`\nYou can also copy and paste names and emails from a two-column spreadsheet.'} />
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={FORM_LABEL}>Role</label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
              style={{ ...inputStyle, width: 200 }}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button type="submit" disabled={inviteLoading || demoLocked} style={{ ...btnPrimary, opacity: inviteLoading || demoLocked ? 0.6 : 1, cursor: demoLocked ? 'not-allowed' : 'pointer' }}>
              {inviteLoading ? 'Sending…' : 'Send invites'}
            </button>
            {inviteError && <span style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{inviteError}</span>}
          </div>
          {inviteResult && (
            <div style={{ marginTop: 16, fontSize: fontSize.sm }}>
              <div style={{ color: color.textSecondary }}>
                {[
                  `${inviteResult.summary.invited} invited`,
                  inviteResult.summary.exists ? `${inviteResult.summary.exists} already members` : null,
                  inviteResult.summary.duplicate ? `${inviteResult.summary.duplicate} duplicates` : null,
                  inviteResult.summary.invalid ? `${inviteResult.summary.invalid} invalid` : null,
                ].filter(Boolean).join(' · ')}
              </div>
              {inviteResult.results.some(r => r.status !== 'invited') && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: color.textMuted }}>
                  {inviteResult.results.filter(r => r.status !== 'invited').map((r, i) => (
                    <li key={i}>{r.email || '(no email)'} — {r.status}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </form>
      </div>
      {/* Roles management card */}
      <div style={{ ...CARD, padding: 24, marginBottom: 24 }}>
        <div style={CARD_TITLE}>{rolesLabel}</div>
        <div style={{ ...HELPER_TEXT, marginTop: 4, marginBottom: 14 }}>
          Assign roles to members (e.g., by committee, office, or region). In comments, any user can @-mention a role to notify everyone with that particular role. Role labels also appear as badges when you hover a commenter's name.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {orgRoles.map(role => (
            <span key={role.id} style={ROLE_CHIP}>
              {editingRoleId === role.id ? (
                <input
                  autoFocus
                  value={editingRoleName}
                  onChange={e => setEditingRoleName(e.target.value.replace(/@/g, ''))}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRenameRole(role.id, editingRoleName)
                    if (e.key === 'Escape') setEditingRoleId(null)
                  }}
                  style={{
                    fontSize: fontSize.sm, border: 'none', background: 'transparent', outline: 'none',
                    width: Math.max(60, editingRoleName.length * 8),
                    fontFamily: 'inherit', color: 'inherit', fontWeight: 'inherit',
                  }}
                />
              ) : (
                <span
                  onClick={demoLocked ? undefined : () => { setEditingRoleId(role.id); setEditingRoleName(role.name) }}
                  title={demoLocked ? undefined : 'Click to rename'}
                  style={{ cursor: demoLocked ? 'default' : 'text' }}
                >
                  {role.name}
                </span>
              )}
              <span
                style={demoLocked ? { ...ROLE_CHIP_X, color: color.borderBlueDash, cursor: 'not-allowed' } : ROLE_CHIP_X}
                onClick={demoLocked ? undefined : () => handleDeleteRole(role.id)}
                title={demoLocked ? undefined : `Delete role "${role.name}"`}
              >✕</span>
            </span>
          ))}
          {orgRoles.length === 0 && (
            <span style={{ fontSize: fontSize.sm, color: color.textMuted }}>No roles yet.</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={newRoleName}
            onChange={e => setNewRoleName(e.target.value.replace(/@/g, ''))}
            onKeyDown={e => e.key === 'Enter' && !demoLocked && handleAddRole()}
            placeholder="New role name…"
            style={{ fontSize: fontSize.sm, padding: '5px 10px', border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, width: 200, fontFamily: 'inherit', color: color.textSlate }}
          />
          <button
            onClick={handleAddRole}
            disabled={addingRole || !newRoleName.trim() || demoLocked}
            style={{ fontSize: fontSize.sm, padding: '5px 14px', borderRadius: radius.md, border: 'none', background: newRoleName.trim() && !demoLocked ? color.accentBlue : color.borderDefault, color: newRoleName.trim() && !demoLocked ? color.white : color.textMuted, cursor: newRoleName.trim() && !demoLocked ? 'pointer' : 'not-allowed', fontWeight: fontWeight.medium }}
          >
            {addingRole ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
      {/* Members table card */}
      <div style={{ ...CARD, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={CARD_TITLE}>All members</div>
          <button
            onClick={() => { setUnknownOpen(true); loadUnknownAttempts() }}
            style={{
              fontSize: fontSize.sm,
              color: color.accentBlue,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            Unknown login attempts
          </button>
        </div>
        <input
          type="text"
          value={memberSearch}
          onChange={(e) => setMemberSearch(e.target.value)}
          placeholder="Search members by name or email…"
          style={{ ...inputStyle, maxWidth: 320, marginTop: 12 }}
        />
        {!listLoading && !listError && (
          <div style={{ ...HELPER_TEXT, marginTop: 14, marginBottom: 8 }}>
            {(() => {
              const q = memberSearch.trim().toLowerCase()
              const shown = q
                ? members.filter(m => displayName(m).toLowerCase().includes(q) || m.email.toLowerCase().includes(q)).length
                : members.length
              return q ? `Showing ${shown} of ${members.length}` : `${members.length} ${members.length === 1 ? 'member' : 'members'}`
            })()}
          </div>
        )}
        {listLoading && <div style={{ color: color.textMuted, fontSize: fontSize.sm }}>Loading…</div>}
        {listError && <div style={{ color: color.textErrorRed, fontSize: fontSize.sm }}>{listError}</div>}
        {!listLoading && !listError && (
          <div className="members-table-wrap" style={{ overflowX: 'auto', margin: '0 -24px', padding: '0 24px' }}>
          <table className="members-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize.sm }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${color.borderDefault}`, textAlign: 'left' }}>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold, width: '30%' }}>Name</th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Role
                    <InfoTooltip
                      align="center"
                      maxWidth={320}
                      text={<>All members can comment and leave personal notes. <strong>Admins</strong> can also set bill positions, add bills manually, set priorities, manage custom fields, manage members, manage the calendar, and download all data. <strong>Owners</strong> can promote and demote other owners and delete all user interactions.</>}
                    />
                  </span>
                </th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>{rolesLabel}</th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Invited by</th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Last active</th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Status</th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Can vote</th>
                <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[...members]
                .filter((m) => {
                  const q = memberSearch.trim().toLowerCase()
                  if (!q) return true
                  return displayName(m).toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
                })
                .sort((a, b) => {
                  const rolePriority = { owner: 0, admin: 1, member: 2 } as const
                  if (a.role !== b.role) return rolePriority[a.role] - rolePriority[b.role]
                  return displayName(a).localeCompare(displayName(b))
                })
                .map((member) => {
                const isSelf = member.id === user?.id
                const isDeactivated = !!member.deactivatedAt
                const currentUserIsOwner = user?.role === 'owner'
                const ownerCount = members.filter(m => m.role === 'owner' && !m.deactivatedAt).length
                const isLastOwner = member.role === 'owner' && ownerCount <= 1
                const canManageThisMember = currentUserIsOwner || member.role !== 'owner'
                const hasAnyAction = canManageThisMember && !(isSelf && isLastOwner && !isDeactivated)
                return (
                  <tr key={member.id} style={{ borderBottom: `1px solid ${color.surfaceMuted}`, opacity: isDeactivated ? 0.6 : 1 }}>
                    <td className="members-name-cell" style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: isSelf ? fontWeight.bold : fontWeight.medium, color: color.textPrimary }}>{member.name}</span>
                        {isSelf && (
                          <span style={{
                            fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: color.textIndigoMe,
                            background: color.bgInfo, borderRadius: radius.sm, padding: '1px 5px',
                            letterSpacing: '0.05em', flexShrink: 0,
                          }}>ME</span>
                        )}
                      </div>
                      {member.subtitle && (
                        <div style={{ fontSize: fontSize.sm, color: color.textSlate500, marginTop: 1 }}>{member.subtitle}</div>
                      )}
                      <a
                        href={`mailto:${member.email}`}
                        style={{ fontSize: fontSize.sm, color: color.textMuted, textDecoration: 'none' }}
                        onMouseOver={e => (e.currentTarget.style.textDecoration = 'underline')}
                        onMouseOut={e => (e.currentTarget.style.textDecoration = 'none')}
                      >
                        {member.email}
                      </a>
                    </td>
                    <td data-label="Role" style={{ padding: '10px 12px', color: color.textSlate500 }}>
                      <span style={chipSystem(member.role === 'admin' || member.role === 'owner')}>
                        {member.role === 'owner' ? 'Owner' : member.role === 'admin' ? 'Admin' : 'Member'}
                      </span>
                    </td>
                    <td data-label={rolesLabel} style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                        {sortRoles(member.roles).map(role => (
                          <span key={role.id} style={ROLE_CHIP}>
                            {role.name}
                            <span
                              style={demoLocked ? { ...ROLE_CHIP_X, color: color.borderBlueDash, cursor: 'not-allowed' } : ROLE_CHIP_X}
                              onClick={demoLocked ? undefined : () => handleSetMemberRoles(member.id, member.roles.filter(r => r.id !== role.id).map(r => r.id))}
                              title={demoLocked ? undefined : `Remove ${role.name}`}
                            >✕</span>
                          </span>
                        ))}
                        <span
                          style={demoLocked ? { ...chipAddRole, opacity: 0.4, cursor: 'not-allowed' } : chipAddRole}
                          onClick={demoLocked ? undefined : (e) => {
                            if (openRoleDropdown === member.id) {
                              setOpenRoleDropdown(null)
                              setDropdownAnchor(null)
                            } else {
                              setOpenActionsMenu(null)
                              setActionsAnchor(null)
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                              const openUp = rect.bottom + 200 > window.innerHeight
                              setDropdownAnchor({ top: openUp ? rect.top : rect.bottom, left: rect.left, openUp })
                              setOpenRoleDropdown(member.id)
                            }
                          }}
                        >
                          Add role
                        </span>
                      </div>
                    </td>
                    <td data-label="Invited by" style={{ padding: '10px 12px', color: color.textSecondary }}>
                      {member.invitedBy
                        ? <span title={member.invitedBy.email} style={{ fontSize: fontSize.sm }}>{displayName(member.invitedBy)}</span>
                        : <span style={{ color: color.borderStrong }}>—</span>
                      }
                    </td>
                    <td data-label="Last active" style={{ padding: '10px 12px', color: color.textMuted }}>
                      {member.hasLoggedIn ? <span title={absoluteTime(member.lastActive)}>{relativeTime(member.lastActive)}</span> : '—'}
                    </td>
                    <td data-label="Status" style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                        {isDeactivated ? (
                          <span style={{
                            fontSize: fontSize.sm,
                            padding: '2px 8px',
                            borderRadius: radius.sm,
                            fontWeight: fontWeight.semibold,
                            background: color.bgDangerSoft,
                            color: color.textDanger,
                          }}>
                            Deactivated
                          </span>
                        ) : !member.hasLoggedIn && member.invitedBy !== null ? (
                          <span style={{
                            fontSize: fontSize.sm,
                            padding: '2px 8px',
                            borderRadius: radius.sm,
                            fontWeight: fontWeight.semibold,
                            background: color.bgWarnSoft,
                            color: color.textAmberDark,
                          }}>
                            Invite pending
                          </span>
                        ) : (
                          <span style={{
                            fontSize: fontSize.sm,
                            padding: '2px 8px',
                            borderRadius: radius.sm,
                            fontWeight: fontWeight.semibold,
                            background: color.bgSuccess,
                            color: color.textSuccess,
                          }}>
                            Active
                          </span>
                        )}
                        {member.loginTrouble && (
                          <span
                            title="Multiple login-link requests with no successful sign-in in the last 14 days — open Login activity to investigate."
                            style={{
                              fontSize: fontSize.sm,
                              padding: '2px 8px',
                              borderRadius: radius.sm,
                              fontWeight: fontWeight.semibold,
                              background: color.bgWarnSoft,
                              color: color.textAmberDark,
                            }}
                          >
                            ⚠️ Login trouble
                          </span>
                        )}
                      </div>
                    </td>
                    <td data-label="Can vote" style={{ padding: '10px 12px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={member.canVote}
                        onChange={demoLocked ? undefined : () => handleCanVoteToggle(member)}
                        disabled={demoLocked}
                        title={demoLocked ? 'Read-only in demo mode' : member.canVote ? 'Click to remove voting rights' : 'Click to grant voting rights'}
                        style={{ cursor: demoLocked ? 'not-allowed' : 'pointer', width: 16, height: 16 }}
                      />
                    </td>
                    <td data-label="Actions" style={{ padding: '10px 12px' }}>
                      {hasAnyAction ? (
                        <button
                          onClick={(e) => {
                            if (openActionsMenu === member.id) {
                              setOpenActionsMenu(null)
                              setActionsAnchor(null)
                            } else {
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                              const openUp = rect.bottom + 240 > window.innerHeight
                              setActionsAnchor({ top: openUp ? rect.top : rect.bottom, left: rect.right, openUp })
                              setOpenActionsMenu(member.id)
                            }
                          }}
                          style={{ ...btnSmall, fontWeight: fontWeight.semibold, letterSpacing: '0.1em', padding: '4px 8px' }}
                          title="Actions"
                        >···</button>
                      ) : (
                        <span style={{ fontWeight: fontWeight.semibold, letterSpacing: '0.1em', padding: '4px 8px', color: color.borderStrong, fontSize: fontSize.sm }}>···</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
      {/* Actions dropdown — rendered fixed so it's never clipped by table overflow */}
      {openActionsMenu && actionsAnchor && (() => {
        const member = members.find(m => m.id === openActionsMenu)
        if (!member) return null
        const isSelf = member.id === user?.id
        const isDeactivated = !!member.deactivatedAt
        const close = () => { setOpenActionsMenu(null); setActionsAnchor(null) }

        type MenuItem =
          | { kind: 'action'; label: string; danger?: boolean; disabled?: boolean; onClick: () => void }
          | { kind: 'separator' }

        const items: MenuItem[] = []

        if (!isSelf) {
          items.push({ kind: 'action', label: 'Login activity', onClick: () => { close(); openActivity(member) } })
        }

        if (!isSelf && !member.hasLoggedIn && !isDeactivated && member.invitedBy !== null) {
          items.push({ kind: 'action', label: 'Resend invite', disabled: demoLocked, onClick: () => { close(); handleResendInvite(member) } })
        }

        if (!isSelf && member.hasLoggedIn && !isDeactivated) {
          items.push({ kind: 'action', label: 'Resend login link', disabled: demoLocked, onClick: () => { close(); resendLogin(member.email) } })
        }

        const currentUserIsOwner = user?.role === 'owner'

        const ownerCount = members.filter(m => m.role === 'owner' && !m.deactivatedAt).length
        const isLastOwner = member.role === 'owner' && ownerCount <= 1
        const canManageThisMember = currentUserIsOwner || member.role !== 'owner'

        if (isDeactivated) {
          if (canManageThisMember) {
            items.push({ kind: 'action', label: 'Reactivate', disabled: demoLocked, onClick: () => { close(); handleDeactivateToggle(member) } })
          }
        } else {
          if (member.role === 'owner') {
            if (currentUserIsOwner && !isLastOwner) {
              items.push({ kind: 'action', label: 'Demote to Admin', disabled: demoLocked, onClick: () => { close(); handleRoleChange(member, 'admin') } })
            }
          } else if (member.role === 'admin') {
            items.push({ kind: 'action', label: 'Demote to Member', disabled: demoLocked, onClick: () => { close(); handleRoleChange(member, 'member') } })
            if (currentUserIsOwner) {
              items.push({ kind: 'action', label: 'Promote to Owner', disabled: demoLocked, onClick: () => { close(); handleRoleChange(member, 'owner') } })
            }
          } else {
            if (!isSelf) items.push({ kind: 'action', label: 'Promote to Admin', disabled: demoLocked, onClick: () => { close(); handleRoleChange(member, 'admin') } })
          }
          if (canManageThisMember && !(isSelf && isLastOwner)) {
            items.push({ kind: 'action', label: isSelf ? 'Deactivate my account' : 'Deactivate', disabled: demoLocked, onClick: () => { close(); handleDeactivateToggle(member) } })
          }
        }

        if (canManageThisMember && !isLastOwner) {
          items.push({ kind: 'separator' })
          items.push({
            kind: 'action',
            label: isSelf ? 'Permanently delete my account' : 'Permanently delete',
            danger: true,
            disabled: demoLocked,
            onClick: () => { close(); isSelf ? handleDeleteSelf() : handleDelete(member) },
          })
        }

        return (
          <>
            <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 100 }} />
            <div style={{
              position: 'fixed',
              top: actionsAnchor.openUp ? 'auto' : actionsAnchor.top + 4,
              bottom: actionsAnchor.openUp ? window.innerHeight - actionsAnchor.top + 4 : 'auto',
              left: actionsAnchor.left,
              transform: 'translateX(-100%)',
              background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
              boxShadow: shadow.md, zIndex: 101,
              minWidth: 200, padding: '4px 0',
            }}>
              {items.map((item, i) =>
                item.kind === 'separator'
                  ? <div key={i} style={{ height: 1, background: color.surfaceMuted, margin: '4px 0' }} />
                  : (
                    <div
                      key={i}
                      onClick={item.disabled ? undefined : item.onClick}
                      style={{
                        padding: '7px 14px', fontSize: fontSize.sm,
                        cursor: item.disabled ? 'not-allowed' : 'pointer',
                        color: item.disabled ? color.borderStrong : item.danger ? color.textErrorRed : color.textSlate,
                      }}
                      onMouseOver={item.disabled ? undefined : e => (e.currentTarget.style.background = item.danger ? color.bgDangerSoft : color.surfaceSubtle)}
                      onMouseOut={item.disabled ? undefined : e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {item.label}
                    </div>
                  )
              )}
            </div>
          </>
        )
      })()}
      {/* Login activity panel — modal overlay */}
      {activityMember && (
        <>
          <div
            onClick={() => { setActivityMember(null); setActivityData(null) }}
            style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.25)' }}
          />
          <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 201,
            background: color.white,
            border: `1px solid ${color.borderDefault}`,
            borderRadius: radius.lg,
            boxShadow: shadow.lg,
            width: 520,
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 80px)',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Panel header */}
            <div style={{
              padding: '16px 20px 12px',
              borderBottom: `1px solid ${color.borderDefault}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontWeight: fontWeight.semibold, fontSize: fontSize.base, color: color.textPrimary }}>
                  Login activity
                </div>
                <div style={{ fontSize: fontSize.sm, color: color.textMuted, marginTop: 2 }}>
                  {displayName(activityMember)} · {activityMember.email}
                </div>
              </div>
              <button
                onClick={() => { setActivityMember(null); setActivityData(null) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: color.textMuted, fontSize: fontSize.xl, lineHeight: 1 }}
                aria-label="Close"
              >✕</button>
            </div>

            {/* Panel body */}
            <div style={{ overflowY: 'auto', padding: '16px 20px', flex: 1 }}>
              {activityLoading && (
                <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>Loading…</div>
              )}
              {activityError && (
                <div style={{ fontSize: fontSize.sm, color: color.textErrorRed }}>{activityError}</div>
              )}
              {activityData && (
                <>
                  {/* Suppression banner */}
                  {activityData.suppression.suppressed === true && (
                    <div style={{
                      background: color.bgWarnSoft,
                      border: `1px solid ${color.textAmberDark}`,
                      borderRadius: radius.md,
                      padding: '10px 14px',
                      marginBottom: 16,
                      fontSize: fontSize.sm,
                      color: color.textAmberDark,
                    }}>
                      ⚠️ This address is on the mail provider's suppression list
                      {activityData.suppression.reason ? ` (reason: ${activityData.suppression.reason})` : ''}
                      {' '}— it won't receive email until removed. Remove it in the Cloudflare dashboard (Email Service → Suppressions).
                    </div>
                  )}

                  {/* Events list */}
                  {activityData.events.length === 0 ? (
                    <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>No login activity recorded.</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {activityData.events.map(event => {
                        const deliveryEntry =
                          event.event === 'email_sent' && event.messageId
                            ? activityData.delivery[event.messageId]
                            : undefined
                        return (
                          <div key={event.id} style={{
                            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                            padding: '8px 0',
                            borderBottom: `1px solid ${color.surfaceMuted}`,
                          }}>
                            <div style={{ fontSize: fontSize.sm, color: color.textSlate, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0 }}>
                              {authEventLabel(event)}
                              {deliveryEntry && <DeliveryPill entry={deliveryEntry} />}
                            </div>
                            <div
                              title={absoluteTime(event.createdAt)}
                              style={{ fontSize: fontSize.sm, color: color.textMuted, whiteSpace: 'nowrap', marginLeft: 16, flexShrink: 0 }}
                            >
                              {relativeTimeFromEpoch(event.createdAt)}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
      {unknownOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.3)' }} onClick={() => setUnknownOpen(false)} />
          <div style={{ position: 'relative', background: color.white, borderRadius: radius.lg, boxShadow: shadow.lg, width: 560, maxHeight: '80vh', overflow: 'auto', padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, margin: 0 }}>Unknown login attempts</h2>
              <button onClick={() => setUnknownOpen(false)} style={{ background: 'none', border: 'none', fontSize: fontSize.xl, cursor: 'pointer', color: color.textMuted }}>×</button>
            </div>
            <p style={{ fontSize: fontSize.sm, color: color.textMuted, marginBottom: 16 }}>
              Login attempts from email addresses not registered on this instance.
            </p>
            {unknownLoading ? (
              <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>Loading…</div>
            ) : unknownAttempts.length === 0 ? (
              <div style={{ fontSize: fontSize.sm, color: color.textMuted }}>No unknown login attempts recorded.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize.sm }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${color.borderDefault}`, textAlign: 'left' }}>
                    <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Email</th>
                    <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Country</th>
                    <th style={{ padding: '8px 12px', color: color.textSecondary, fontWeight: fontWeight.semibold }}>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {unknownAttempts.map(a => (
                    <tr key={a.id} style={{ borderBottom: `1px solid ${color.surfaceMuted}` }}>
                      <td style={{ padding: '8px 12px', color: color.textPrimary }}>{a.email}</td>
                      <td style={{ padding: '8px 12px', color: color.textMuted }}>{a.ipCountry ?? '—'}</td>
                      <td style={{ padding: '8px 12px', color: color.textMuted }} title={absoluteTime(a.createdAt)}>{relativeTime(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
      {/* Toast notification */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 300,
          background: color.textSlate,
          color: color.white,
          padding: '10px 20px',
          borderRadius: radius.md,
          fontSize: fontSize.sm,
          boxShadow: shadow.md,
          pointerEvents: 'none',
        }}>
          {toast}
        </div>
      )}
      {/* Role dropdown — rendered fixed so it's never clipped by table overflow */}
      {openRoleDropdown && dropdownAnchor && (() => {
        const member = members.find(m => m.id === openRoleDropdown)
        if (!member) return null
        const available = orgRoles.filter(r => !member.roles.some(mr => mr.id === r.id))
        return (
          <>
            <div onClick={() => { setOpenRoleDropdown(null); setDropdownAnchor(null) }} style={{ position: 'fixed', inset: 0, zIndex: 100 }} />
            <div style={{
              position: 'fixed',
              top: dropdownAnchor.openUp ? 'auto' : dropdownAnchor.top + 4,
              bottom: dropdownAnchor.openUp ? window.innerHeight - dropdownAnchor.top + 4 : 'auto',
              left: dropdownAnchor.left,
              background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.md,
              boxShadow: shadow.md, zIndex: 101,
              minWidth: 160, padding: '4px 0',
            }}>
              {available.map(role => (
                <div
                  key={role.id}
                  onClick={() => {
                    handleSetMemberRoles(member.id, [...member.roles.map(r => r.id), role.id])
                    setOpenRoleDropdown(null)
                    setDropdownAnchor(null)
                  }}
                  style={{ padding: '6px 12px', fontSize: fontSize.sm, cursor: 'pointer', color: color.textSlate }}
                  onMouseOver={e => (e.currentTarget.style.background = color.surfaceSubtle)}
                  onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {role.name}
                </div>
              ))}
              {available.length === 0 && (
                <div style={{ padding: '6px 12px', fontSize: fontSize.sm, color: color.textMuted }}>All roles assigned</div>
              )}
            </div>
          </>
        )
      })()}
    </div>
  );
}
