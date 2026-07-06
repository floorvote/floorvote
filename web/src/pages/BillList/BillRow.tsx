import { memo, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { decodeStatus } from '../../lib/legislativeStatus'
import { stripMarkdown } from '../../components/MarkdownSummary'
import { billUrl } from '../../lib/sessionSlug'
import { BillBadge } from '../../components/BillBadge'
import { PositionBadge } from '../../components/PositionBadge'
import { PriorityBadge } from '../../components/PriorityBadge'
import { StatusChip } from '../../components/StatusChip'
import { RelevanceChip } from '../../components/RelevanceChip'
import { SessionChip } from '../../components/SessionChip'
import { CompactPositionSelect } from '../../components/CompactPositionSelect'
import { CompactPrioritySelect } from '../../components/CompactPrioritySelect'
import { NewMatchTriageControl } from '../../components/NewMatchTriageControl'
import { HoverTooltip } from '../../components/HoverTooltip'
import { TAG_CHIP, TAG_CHIP_HOVERED, TAG_CHIP_ACTIVE } from '../../lib/tagChipStyle'
import { TOOLTIP_STYLE } from '../../lib/chipStyles'
import { SECTION_LABEL, CHROME_TEXT } from '../../lib/textStyles'
import { color, radius, fontSize, fontWeight, shadow } from '../../styles/tokens'
import { voteButtonStyle, type VoteKey } from '../../lib/voteButtonStyle'
import { useConfig } from '../../context/ConfigContext'
import { DEFAULT_ORG_NOUN } from '../../lib/orgNoun'
import { CHIP_GRID, CHIP_GRID_MULTISTATE, CHIP_GAP, OUTER_GRID } from './constants'
import type { Bill } from './types'

export function formatYearChip(yearStart: number | null, yearEnd: number | null): string | null {
  if (!yearStart) return null
  if (yearStart === yearEnd) return String(yearStart)
  return `${yearStart}–${String(yearEnd ?? yearStart).slice(2)}`
}

function MiniBar({ count, total, barColor, label, isActive, onVote }: {
  count: number; total: number; barColor: string; label: string
  isActive?: boolean; onVote?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => { setReady(true) }, [])
  const pct = total > 0 ? (count / total) * 100 : 0
  const tooltip = isActive
    ? `You voted ${label.toLowerCase()} — click to remove your vote`
    : `Vote ${label.toLowerCase()} on this bill`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      {onVote ? (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onVote() }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
              width: 60, fontSize: fontSize.sm, padding: '3px 6px',
              ...voteButtonStyle(label.toLowerCase() as VoteKey, !!isActive, hovered),
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
        <span style={{ width: 60, fontSize: fontSize.sm, color: color.textSlate500, flexShrink: 0 }}>{label}</span>
      )}
      <div style={{ flex: 1, height: 8, background: color.white, border: `1px solid ${color.borderDefault}`, borderRadius: radius.sm, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: ready ? 'width 0.3s' : 'none' }} />
      </div>
      <span style={{ width: 28, textAlign: 'right', fontSize: fontSize.sm, color: color.textSecondary, flexShrink: 0 }}>{count}</span>
    </div>
  )
}

export const BillRow = memo(function BillRow({
  bill, index, selectedTags, onTagClick,
  isAdmin, positionVocabulary,
  onStatusClick, onPriorityClick, onPositionClick, onYearClick, onRelevanceClick,
  onPriorityChange, onPositionChange, onTriageDismiss, onVote,
  filterStatuses, filterPriorities, filterPositions, filterYears, filterMinRelevance,
  sortedPaths, isMultiState, onNavigate,
  isSelectionMode, isSelected, onToggleSelect,
}: {
  bill: Bill; index: number; selectedTags: string[]
  onTagClick: (tag: string) => void
  isAdmin: boolean
  positionVocabulary: string[]
  onStatusClick: (s: string) => void
  onPriorityClick: (p: string) => void
  onPositionClick: (p: string) => void
  onYearClick?: (year: number) => void
  onRelevanceClick: (score: number) => void
  onPriorityChange: (billId: string, priority: 'high' | 'medium' | 'low' | null) => void
  onPositionChange: (billId: string, position: string | null) => void
  onTriageDismiss?: (billId: string) => void
  onVote: ((billId: string, pos: 'support' | 'neutral' | 'oppose') => void) | undefined
  filterStatuses: string[]
  filterPriorities: string[]
  filterPositions: string[]
  filterYears: number[]
  filterMinRelevance: number
  sortedPaths: string[]
  isMultiState: boolean
  onNavigate?: (billId: string, path: string, state: { billPaths: string[]; currentIndex: number }) => void
  isSelectionMode: boolean
  isSelected: boolean
  onToggleSelect: ((shiftKey: boolean) => void) | undefined
}) {
  const navigate = useNavigate()
  const [hovered, setHovered] = useState(false)
  const [hoveredChip, setHoveredChip] = useState<string | null>(null)
  const checkboxShiftRef = useRef(false)
  const [chipTooltipPos, setChipTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const { support, oppose, neutral } = bill.voteCounts
  const totalVotes = support + oppose + neutral

  // Un-triaged keyword match → show the segmented set-priority/dismiss control in
  // place of the plain priority select. Once resolved (priority set or dismissed),
  // this predicate flips false and the row reverts to CompactPrioritySelect.
  const isNewMatch = isAdmin && bill.matchType === 'keyword' && !!bill.newMatchAt && !bill.priority && !bill.triageDismissedAt
  const renderPriorityControl = () => isNewMatch
    ? (
      <NewMatchTriageControl
        billId={bill.id}
        current={bill.priority}
        onChange={(p) => onPriorityChange(bill.id, p)}
        onDismiss={() => onTriageDismiss?.(bill.id)}
      />
    )
    : (
      <CompactPrioritySelect
        billId={bill.id}
        current={bill.priority}
        onChange={(p) => onPriorityChange(bill.id, p)}
        isFiltered={bill.priority != null && filterPriorities.includes(bill.priority)}
      />
    )
  const billPath = billUrl({ id: bill.id, state: bill.state, session: bill.session, billNumber: bill.billNumber })
  const org = useConfig().config?.orgNoun ?? DEFAULT_ORG_NOUN
  const positionTooltip = `Your ${org}'s official position on this bill`

  // Navigate to the bill detail page (optionally to a #section-* anchor).
  // Honors ⌘/Ctrl open-in-new-tab and routes through the prefetch path when
  // available, mirroring the row-click behavior.
  const goToBill = (e: { metaKey: boolean; ctrlKey: boolean }, hash = '') => {
    const target = `${billPath}${hash}`
    if (e.metaKey || e.ctrlKey) { window.open(target, '_blank'); return }
    const main = document.querySelector('main')
    if (main) history.replaceState({ ...history.state, billsScroll: main.scrollTop }, '')
    const navState = { billPaths: sortedPaths, currentIndex: index }
    if (onNavigate) {
      onNavigate(bill.id, target, navState)
    } else {
      navigate(target, { state: navState })
    }
  }

  return (
    <div
      onClick={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('select, button, a')) return
        if (isSelectionMode) {
          onToggleSelect?.(e.shiftKey)
          return
        }
        goToBill(e)
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        const t = e.target as HTMLElement
        if (t.closest('select, button, a')) return
        window.open(billPath, '_blank')
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`bill-row bill-row-grid${isMultiState ? ' bill-list-ms' : ''}`}
      style={{
        display: 'grid',
        gridTemplateColumns: `12px ${OUTER_GRID}`,
        gap: 8,
        alignItems: 'start',
        background: isSelected ? color.bgBlueChip : hovered ? color.bgDropdownActive : index % 2 === 0 ? color.white : color.white,
        borderBottom: `1px solid ${color.borderDefault}`,
        padding: '12px 16px 12px 8px',
        cursor: 'pointer',
        color: 'inherit',
      }}
    >
      {(isSelectionMode || hovered) ? (
        <div className="bill-row-checkbox" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <input
            type="checkbox"
            checked={isSelected}
            onClick={e => e.stopPropagation()}
            onMouseDown={e => { checkboxShiftRef.current = e.shiftKey }}
            onChange={e => { e.stopPropagation(); onToggleSelect?.(checkboxShiftRef.current) }}
            style={{ width: 15, height: 15, cursor: 'pointer', accentColor: color.accentBlue }}
          />
        </div>
      ) : <div className="bill-row-checkbox" />}
      {/* Left: chip strip + title + summary + tags */}
      <div>
        <div className="bill-row-chips-cell" style={{ display: 'grid', gridTemplateColumns: isMultiState ? CHIP_GRID_MULTISTATE : CHIP_GRID, ['--bill-col-w' as string]: isMultiState ? '105px' : '70px', gap: CHIP_GAP, marginBottom: 8, alignItems: 'center', minWidth: 0, overflow: 'visible' } as React.CSSProperties}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <BillBadge billNumber={bill.billNumber} state={bill.state} />
            {bill.isDraft && (
              <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, padding: '2px 8px', borderRadius: radius.sm, background: color.surfaceSubtle, color: color.textSecondary, border: `1px solid ${color.borderDefault}` }}>
                Draft
              </span>
            )}
          </div>
          <span className="bill-col-status" style={{ display: 'flex', alignItems: 'center' }}><StatusChip
            status={decodeStatus(bill.status)}
            onClick={() => onStatusClick(bill.status)}
            isActive={filterStatuses.includes(bill.status)}
          /></span>
          <span className="bill-col-year" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            {(() => {
              const chip = formatYearChip(bill.yearStart, bill.yearEnd)
              if (!chip) return null
              return (
                <SessionChip
                  session={chip}
                  onClick={onYearClick ? () => onYearClick(bill.yearStart!) : undefined}
                  isActive={bill.yearStart != null && filterYears.includes(bill.yearStart)}
                />
              )
            })()}
          </span>
          <span className="bill-col-lastaction" style={{
            display: 'inline-flex', alignItems: 'center',
            fontSize: fontSize.sm, fontWeight: fontWeight.semibold, padding: '3px 10px', borderRadius: radius.sm,
            border: `1px solid ${color.borderDefault}`, background: color.surfaceSubtle, color: color.textSecondary,
          }}>
            {bill.lastActionDate ?? '—'}
          </span>
          <RelevanceChip
            score={bill.relevanceScore}
            onClick={bill.relevanceScore != null ? () => onRelevanceClick(bill.relevanceScore!) : undefined}
            isActive={bill.relevanceScore != null && filterMinRelevance > 0 && bill.relevanceScore >= filterMinRelevance}
          />
        </div>
        {/* Mobile-only: bill number, status, relevance — priority pinned to right edge */}
        <div className="bill-row-mobile-meta">
          <BillBadge billNumber={bill.billNumber} state={bill.state} />
          {bill.isDraft && (
            <span style={{ fontSize: fontSize.xs, fontWeight: fontWeight.semibold, padding: '2px 8px', borderRadius: radius.sm, background: color.surfaceSubtle, color: color.textSecondary, border: `1px solid ${color.borderDefault}` }}>
              Draft
            </span>
          )}
          <StatusChip status={decodeStatus(bill.status)} />
          {bill.relevanceScore != null && (
            <RelevanceChip
              score={bill.relevanceScore}
              onClick={() => onRelevanceClick(bill.relevanceScore!)}
              isActive={filterMinRelevance > 0 && bill.relevanceScore >= filterMinRelevance}
            />
          )}
          <span style={{ flex: 1 }} />
          {isAdmin
            ? renderPriorityControl()
            : bill.priority
              ? (
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPriorityClick(bill.priority!) }}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex' }}
                >
                  <PriorityBadge priority={bill.priority} />
                </button>
              )
              : null
          }
        </div>
        <div style={{ fontSize: fontSize.base, fontWeight: fontWeight.bold, color: color.textPrimary, marginBottom: 3, lineHeight: 1.35, fontFamily: "'Source Serif 4', serif", display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }}>
          {bill.title || bill.abstract}
        </div>
        {(bill.tenantSummary || (bill.title && bill.abstract && bill.abstract.trim().toLowerCase() !== bill.title.trim().toLowerCase())) && (
          <div style={{
            fontSize: fontSize.sm, color: color.textSecondary, marginBottom: 5, lineHeight: 1.4,
            display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            fontFamily: "'Source Serif 4', serif",
          }}>
            {bill.tenantSummary ? stripMarkdown(bill.tenantSummary) : bill.abstract}
          </div>
        )}
        {bill.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {bill.tags.filter(tag => tag.toLowerCase() !== bill.priority?.toLowerCase()).map((tag) => (
              <button
                key={tag}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTagClick(tag) }}
                onMouseEnter={() => setHoveredChip(`tag-${tag}`)}
                onMouseLeave={() => setHoveredChip(null)}
                style={selectedTags.includes(tag) ? TAG_CHIP_ACTIVE : hoveredChip === `tag-${tag}` ? TAG_CHIP_HOVERED : TAG_CHIP}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Assoc. Pos. column */}
      <div className="bill-col-position">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
          <span style={{ ...SECTION_LABEL, flexShrink: 0 }}>Position</span>
          {isAdmin
            ? (
              <HoverTooltip text={positionTooltip}>
                <CompactPositionSelect
                  billId={bill.id}
                  current={bill.position}
                  options={positionVocabulary}
                  onChange={(p) => onPositionChange(bill.id, p)}
                  isFiltered={bill.position != null && filterPositions.includes(bill.position)}
                  size="lg"
                />
              </HoverTooltip>
            )
            : bill.position
              ? (
                <HoverTooltip text={positionTooltip}>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPositionClick(bill.position!) }}
                    onMouseEnter={() => setHoveredChip('position')}
                    onMouseLeave={() => setHoveredChip(null)}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex',
                      outline: filterPositions.includes(bill.position!) ? `2px solid ${color.accentBlue}` : hoveredChip === 'position' ? `2px solid ${color.accentBlueMuted}` : 'none',
                      outlineOffset: 3, borderRadius: radius.sm,
                    }}
                  >
                    <PositionBadge position={bill.position} />
                  </button>
                </HoverTooltip>
              )
              : <span style={{ fontSize: fontSize.sm, color: color.borderStrong }}>— Not set</span>
          }
        </div>
        <div>
          <span style={{ ...SECTION_LABEL, display: 'block', marginBottom: 4 }}>Member votes</span>
          <MiniBar count={support} total={totalVotes} barColor={color.voteSupport} label="Support" isActive={bill.myVote === 'support'} onVote={onVote ? () => onVote(bill.id, 'support') : undefined} />
          <MiniBar count={neutral} total={totalVotes} barColor={color.textMuted} label="Neutral" isActive={bill.myVote === 'neutral'} onVote={onVote ? () => onVote(bill.id, 'neutral') : undefined} />
          <MiniBar count={oppose} total={totalVotes} barColor={color.textDeleteRed} label="Oppose" isActive={bill.myVote === 'oppose'} onVote={onVote ? () => onVote(bill.id, 'oppose') : undefined} />
        </div>
        {(bill.commentCount > 0 || bill.hasNote) && (
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
            {bill.commentCount > 0 && (
              <div
                style={{ display: 'inline-flex' }}
                onMouseEnter={(e) => {
                  setHoveredChip('comments')
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setChipTooltipPos({ x: r.left, y: r.top })
                }}
                onMouseLeave={() => { setHoveredChip(null); setChipTooltipPos(null) }}
              >
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); goToBill(e, '#section-comments') }}
                  style={{ font: 'inherit', ...CHROME_TEXT, background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: fontSize.sm }}>chat</span>
                  {bill.commentCount} {bill.commentCount === 1 ? 'comment' : 'comments'}
                </button>
                {hoveredChip === 'comments' && chipTooltipPos && (
                  <div style={{
                    position: 'fixed', left: chipTooltipPos.x, top: chipTooltipPos.y,
                    transform: 'translateY(calc(-100% - 6px))',
                    ...TOOLTIP_STYLE,
                  }}>
                    {bill.commentCount} comment{bill.commentCount !== 1 ? 's' : ''} on this bill
                  </div>
                )}
              </div>
            )}
            {bill.hasNote && (
              <div style={{ marginLeft: 'auto' }}
                onMouseEnter={(e) => {
                  setHoveredChip('note')
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setChipTooltipPos({ x: r.right, y: r.top })
                }}
                onMouseLeave={() => { setHoveredChip(null); setChipTooltipPos(null) }}
              >
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); goToBill(e, '#section-note') }}
                  style={{ font: 'inherit', ...CHROME_TEXT, background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: fontSize.sm }}>sticky_note_2</span>
                  Personal note
                </button>
                {hoveredChip === 'note' && chipTooltipPos && (
                  <div style={{
                    position: 'fixed', left: chipTooltipPos.x, top: chipTooltipPos.y,
                    transform: 'translateX(-100%) translateY(calc(-100% - 6px))',
                    ...TOOLTIP_STYLE,
                  }}>
                    You have a personal note on this bill
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Priority column — hidden on mobile (shown in mobile-meta instead) */}
      <div className="bill-col-priority">
        {isAdmin
          ? (
            <HoverTooltip text={isNewMatch ? 'New keyword match — set a priority or dismiss' : "This bill's priority level"}>
              {renderPriorityControl()}
            </HoverTooltip>
          )
          : bill.priority
            ? (
              <HoverTooltip text="This bill's priority level">
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPriorityClick(bill.priority!) }}
                  onMouseEnter={() => setHoveredChip('priority')}
                  onMouseLeave={() => setHoveredChip(null)}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex',
                    outline: filterPriorities.includes(bill.priority!) ? `2px solid ${color.accentBlue}` : hoveredChip === 'priority' ? `2px solid ${color.accentBlueMuted}` : 'none',
                    outlineOffset: 2, borderRadius: radius.sm,
                  }}
                >
                  <PriorityBadge priority={bill.priority} />
                </button>
              </HoverTooltip>
            )
            : <span style={{ fontSize: fontSize.sm, color: color.borderStrong }}>—</span>
        }
      </div>
    </div>
  )
})
