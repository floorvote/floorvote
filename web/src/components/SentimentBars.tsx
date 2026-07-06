import { useState, useRef, useEffect } from 'react'
import { CARD } from '../lib/cardStyle'
import { InfoTooltip } from './InfoTooltip'
import { COUNT_BADGE, ROLE_CHIP, sortRoles } from '../lib/chipStyles'
import { relativeTime, absoluteTime } from '../lib/time'
import { SECTION_LABEL, CHROME_TEXT } from '../lib/textStyles'
import { color, radius, fontSize, fontWeight, shadow } from '../styles/tokens'
import { voteButtonStyle } from '../lib/voteButtonStyle'

interface MemberVote {
  userName: string | null
  userEmail: string
  position: string
  votedAt: string
  roles?: { id: string; name: string }[]
}

interface SentimentBarsProps {
  voteCounts: { support: number; oppose: number; neutral: number; total: number }
  memberVotes?: MemberVote[]
  isAdmin: boolean
  myVote?: 'support' | 'oppose' | 'neutral' | null
  onVote?: (pos: 'support' | 'oppose' | 'neutral') => void
  canVote?: boolean
}

type VoteKey = 'support' | 'neutral' | 'oppose'

function Bar({
  count, total, color: barColor, label, voteKey, myVote, onVote,
}: {
  count: number; total: number; color: string; label: string
  voteKey: VoteKey
  myVote?: 'support' | 'oppose' | 'neutral' | null
  onVote?: (pos: VoteKey) => void
}) {
  const [hovered, setHovered] = useState(false)
  const pct = total > 0 ? (count / total) * 100 : 0
  const isActive = !!onVote && myVote === voteKey
  const tooltip = isActive
    ? `You voted ${label.toLowerCase()} — click to remove your vote`
    : `Vote ${label.toLowerCase()} on this bill`

  const labelEl = onVote ? (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => onVote(voteKey)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: 60, fontSize: fontSize.sm, padding: '3px 6px',
          ...voteButtonStyle(voteKey, isActive, hovered),
        }}
      >
        {label}
      </button>
      {hovered && (
        <span style={{
          position: 'absolute', bottom: 'calc(100% + 5px)', left: '50%', transform: 'translateX(-50%)',
          background: color.white, border: `1px solid ${color.borderDefault}`, boxShadow: shadow.md,
          color: color.textSlate500, padding: '4px 8px', borderRadius: radius.sm, fontSize: fontSize.xs,
          whiteSpace: 'nowrap', zIndex: 200, pointerEvents: 'none',
        }}>
          {tooltip}
        </span>
      )}
    </div>
  ) : (
    <span style={{ width: 60, fontSize: fontSize.sm, color: color.textSlate500 }}>{label}</span>
  )

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      {labelEl}
      <div style={{ flex: 1, height: 8, background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.sm, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: radius.sm, transition: 'width 0.3s' }} />
      </div>
      <span style={{ width: 24, textAlign: 'right', fontSize: fontSize.sm, color: color.textSecondary }}>{count}</span>
    </div>
  )
}

const ROLE_FILTER_KEY = 'bill-vote-role-filter'

function getStoredRoleFilter(): string[] {
  try {
    const stored = sessionStorage.getItem(ROLE_FILTER_KEY)
    return stored ? JSON.parse(stored) : []
  } catch { return [] }
}

function RoleFilterDropdown({
  roles,
  activeRoleIds,
  onToggle,
  onClear,
  roleCounts,
}: {
  roles: [string, string][]
  activeRoleIds: string[]
  onToggle: (id: string) => void
  onClear: () => void
  roleCounts: Record<string, number>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const hasSelection = activeRoleIds.length > 0
  const label = hasSelection
    ? `Roles (${activeRoleIds.length})`
    : 'Roles'

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={CHROME_TEXT}>Filter by role:</span>
        <div ref={ref} style={{ position: 'relative' }}>
          <button
            onClick={() => setOpen((o) => !o)}
            style={{
              fontSize: fontSize.sm, padding: '4px 10px', borderRadius: radius.md, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
              background: hasSelection ? color.bgInfo : color.white,
              color: hasSelection ? color.partyDemBlue : color.textSlate,
              border: `1px solid ${hasSelection ? color.tagBorderBlue : color.borderDefault}`,
              fontWeight: hasSelection ? fontWeight.medium : fontWeight.normal,
            }}
          >
            {label}
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path d={open ? 'M1 5l4-4 4 4' : 'M1 1l4 4 4-4'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {open && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 300,
              background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.lg,
              padding: '4px 0', minWidth: 180, maxHeight: 300, overflowY: 'auto',
              boxShadow: shadow.md,
            }}>
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                cursor: 'pointer', fontSize: fontSize.sm,
                color: !hasSelection ? color.partyDemBlue : color.textSlate,
                background: !hasSelection ? color.bgDropdownActive : 'transparent',
              }}>
                <input
                  type="checkbox"
                  checked={!hasSelection}
                  onChange={onClear}
                  style={{ margin: 0, accentColor: color.accentBlue }}
                />
                All
                <span style={{ ...COUNT_BADGE, marginLeft: 'auto' }}>{Object.values(roleCounts).reduce((a, b) => a + b, 0)}</span>
              </label>
              {roles.map(([id, name]) => {
                const checked = activeRoleIds.includes(id)
                return (
                  <label key={id} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
                    cursor: 'pointer', fontSize: fontSize.sm,
                    color: checked ? color.partyDemBlue : color.textSlate,
                    background: checked ? color.bgDropdownActive : 'transparent',
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(id)}
                      style={{ margin: 0, accentColor: color.accentBlue }}
                    />
                    {name}
                    <span style={{ ...COUNT_BADGE, marginLeft: 'auto' }}>{roleCounts[id] ?? 0}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SentimentBars({ voteCounts, memberVotes, isAdmin, myVote, onVote, canVote }: SentimentBarsProps) {
  const [showBreakdown, setShowBreakdown] = useState(false)

  const [activeRoleIds, setActiveRoleIds] = useState<string[]>(getStoredRoleFilter)

  const hasFilter = isAdmin && memberVotes && memberVotes.length > 0 && activeRoleIds.length > 0
  const VOTE_ORDER: Record<string, number> = { support: 0, neutral: 1, oppose: 2 }
  const filteredVotes = (hasFilter
    ? memberVotes!.filter((v) => v.roles?.some((r) => activeRoleIds.includes(r.id)))
    : memberVotes ?? []
  ).slice().sort((a, b) => (VOTE_ORDER[a.position] ?? 3) - (VOTE_ORDER[b.position] ?? 3) || new Date(a.votedAt).getTime() - new Date(b.votedAt).getTime())

  const displayCounts = hasFilter
    ? {
        support: filteredVotes.filter(v => v.position === 'support').length,
        oppose: filteredVotes.filter(v => v.position === 'oppose').length,
        neutral: filteredVotes.filter(v => v.position === 'neutral').length,
        total: filteredVotes.length,
      }
    : voteCounts
  const { support, oppose, neutral, total } = displayCounts

  return (
    <div style={{ ...CARD, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={SECTION_LABEL}>
          Member votes{total > 0 && <span style={{ ...COUNT_BADGE, textTransform: 'none', letterSpacing: 0, marginLeft: 6 }}>{total}</span>}
          {hasFilter && <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.normal, letterSpacing: 0, textTransform: 'none', marginLeft: 4, fontStyle: 'italic' }}>filtered</span>}
        </div>
        <InfoTooltip text={canVote === false
          ? "All members see aggregate counts; admins see individual votes. Your account is set to non-voting."
          : "All members see aggregate counts; admins see individual votes."
        } />
      </div>
      <Bar count={support} total={total} color={color.voteSupport} label="Support" voteKey="support" myVote={myVote} onVote={onVote} />
      <Bar count={neutral} total={total} color={color.textMuted} label="Neutral" voteKey="neutral" myVote={myVote} onVote={onVote} />
      <Bar count={oppose} total={total} color={color.textDeleteRed} label="Oppose" voteKey="oppose" myVote={myVote} onVote={onVote} />
      {isAdmin && memberVotes && memberVotes.length > 0 && (() => {
        const allRoles = new Map<string, string>()
        for (const v of memberVotes) {
          for (const r of v.roles ?? []) allRoles.set(r.id, r.name)
        }
        const sortedRoles = [...allRoles.entries()].sort((a, b) => a[1].localeCompare(b[1]))

        const toggleRole = (roleId: string) => {
          setActiveRoleIds((prev) => {
            const next = prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]
            sessionStorage.setItem(ROLE_FILTER_KEY, JSON.stringify(next))
            return next
          })
        }

        return (
          <>
            <div style={{ marginTop: 8, paddingTop: 4 }}>
              <button
                onClick={() => setShowBreakdown((s) => !s)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', fontFamily: 'inherit', textAlign: 'left' }}
              >
                <span style={SECTION_LABEL}>Individual votes</span>
                <span style={CHROME_TEXT}>{showBreakdown ? '▲' : '▼'}</span>
              </button>
            </div>
            {showBreakdown && (
              <div style={{ marginTop: 6, borderLeft: '2px solid #e2e8f0', paddingLeft: 10, marginLeft: 1 }}>
                {sortedRoles.length > 0 && (() => {
                  const roleCounts: Record<string, number> = {}
                  for (const v of memberVotes) {
                    for (const r of v.roles ?? []) roleCounts[r.id] = (roleCounts[r.id] ?? 0) + 1
                  }
                  return (
                  <RoleFilterDropdown
                    roles={sortedRoles}
                    activeRoleIds={activeRoleIds}
                    onToggle={toggleRole}
                    onClear={() => { setActiveRoleIds([]); sessionStorage.removeItem(ROLE_FILTER_KEY) }}
                    roleCounts={roleCounts}
                  />)
                })()}
                {filteredVotes.length === 0 && activeRoleIds.length > 0 ? (
                  <div style={{ fontSize: fontSize.sm, color: color.textMuted, padding: '8px 0', textAlign: 'center' }}>
                    No votes from members with selected role{activeRoleIds.length > 1 ? 's' : ''}
                  </div>
                ) : (
                  <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  {filteredVotes.map((v, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: fontSize.sm, padding: '6px 0', borderTop: i > 0 ? `1px solid ${color.surfaceMuted}` : 'none' }}>
                      <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6, color: color.textSlate, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                        <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{v.userName || v.userEmail}</span>
                        {sortRoles(v.roles ?? []).map((r) => (
                          <span key={r.id} style={ROLE_CHIP}>{r.name}</span>
                        ))}
                      </span>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, marginLeft: 8 }}>
                        <span title={absoluteTime(v.votedAt)} style={CHROME_TEXT}>{relativeTime(v.votedAt)}</span>
                        <span style={{ color: v.position === 'support' ? color.textVoteSupport : v.position === 'oppose' ? color.textDanger : color.textSecondary, fontWeight: fontWeight.medium, textTransform: 'capitalize' }}>{v.position}</span>
                      </span>
                    </div>
                  ))}
                  </div>
                )}
              </div>
            )}
          </>
        )
      })()}
    </div>
  )
}
