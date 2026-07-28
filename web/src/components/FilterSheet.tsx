import { useEffect, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'

interface FilterSheetProps {
  isOpen: boolean
  onClose: () => void
  statuses: string[]
  priorities: string[]
  positions: string[]
  tags: string[]
  sessions: string[]
  minRelevance: number
  myBills: boolean
  statusOptions: { value: string; label: string }[]
  priorityOptions: { value: string; label: string }[]
  positionOptions: { value: string; label: string }[]
  tagOptions: string[]
  sessionOptions: { value: string; label: string }[]
  totalSessionCount?: number
  onStatusChange: (v: string[]) => void
  onPriorityChange: (v: string[]) => void
  onPositionChange: (v: string[]) => void
  onTagChange: (v: string[]) => void
  onSessionChange: (v: string[]) => void
  onMinRelevanceChange: (v: number) => void
  onMyBillsChange: (v: boolean) => void
  onClearAll: () => void
  counts?: {
    status: Record<string, number>
    priority: Record<string, number>
    position: Record<string, number>
    session: Record<string, number>
    tags: Record<string, number>
  }
}

function SheetChip({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: fontSize.sm,
        padding: '7px 14px',
        borderRadius: radius.xl,
        border: '1px solid',
        cursor: 'pointer',
        background: active ? color.linkBlue : color.white,
        color: active ? color.white : color.textSlate,
        borderColor: active ? color.linkBlue : color.borderDefault,
        fontWeight: active ? fontWeight.semibold : fontWeight.normal,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {label}
      {count !== undefined && (
        <span style={{
          fontSize: fontSize.sm,
          color: active ? 'rgba(255,255,255,0.7)' : color.textMuted,
          background: active ? 'rgba(255,255,255,0.15)' : color.surfaceMuted,
          padding: '1px 6px',
          borderRadius: radius.lg,
        }}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  )
}

function SheetSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{
        fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textMuted,
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {children}
      </div>
    </div>
  )
}

export function FilterSheet({
  isOpen, onClose,
  statuses, priorities, positions, tags, sessions, minRelevance, myBills,
  statusOptions, priorityOptions, positionOptions, tagOptions, sessionOptions, totalSessionCount,
  onStatusChange, onPriorityChange, onPositionChange, onTagChange, onSessionChange,
  onMinRelevanceChange, onMyBillsChange,
  onClearAll, counts,
}: FilterSheetProps) {
  useEffect(() => {
    if (!isOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [isOpen])

  // Track the relevance thumb locally so it moves instantly while dragging, but
  // only commit (which drives the bill query) on release — one fetch per drag,
  // not one per step.
  const [relevanceDraft, setRelevanceDraft] = useState(minRelevance)
  useEffect(() => { setRelevanceDraft(minRelevance) }, [minRelevance])
  const commitRelevance = () => {
    if (relevanceDraft !== minRelevance) onMinRelevanceChange(relevanceDraft)
  }

  if (!isOpen) return null

  const totalActive = statuses.length + priorities.length + positions.length + tags.length + sessions.length + (minRelevance > 0 ? 1 : 0) + (myBills ? 1 : 0)

  function toggleItem(arr: string[], val: string, setter: (v: string[]) => void) {
    setter(arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val])
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          zIndex: 400,
        }}
      />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: color.white,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        zIndex: 401,
        maxHeight: '80vh',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{ padding: '12px 0 0', display: 'flex', justifyContent: 'center' }}>
          <div style={{ width: 36, height: 4, background: color.borderDefault, borderRadius: radius.xs }} />
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 20px 8px',
        }}>
          <span style={{ fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: color.textPrimary }}>Filter Bills</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {totalActive > 0 && (
              <button
                onClick={onClearAll}
                style={{ fontSize: fontSize.sm, color: color.linkBlue, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Clear all
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close filters"
              style={{ fontSize: fontSize.xxxl, color: color.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
            >
              ×
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 20px 32px' }}>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
              My Bills
            </div>
            <SheetChip
              label="My voted bills"
              active={myBills}
              onClick={() => onMyBillsChange(!myBills)}
            />
          </div>
          {statusOptions.length > 0 && (
            <SheetSection title="Status">
              {statusOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={statuses.includes(opt.value)}
                  onClick={() => toggleItem(statuses, opt.value, onStatusChange)}
                  count={counts?.status[opt.value] ?? 0}
                />
              ))}
            </SheetSection>
          )}
          {priorityOptions.length > 0 && (
            <SheetSection title="Priority">
              {priorityOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={priorities.includes(opt.value)}
                  onClick={() => toggleItem(priorities, opt.value, onPriorityChange)}
                  count={counts?.priority[opt.value] ?? 0}
                />
              ))}
            </SheetSection>
          )}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: color.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Min. Relevance
              </div>
              <span style={{ fontSize: fontSize.sm, fontWeight: relevanceDraft > 0 ? fontWeight.semibold : fontWeight.normal, color: relevanceDraft > 0 ? color.linkBlue : color.textMuted }}>
                {relevanceDraft === 0 ? 'Any' : relevanceDraft < 10 ? `${relevanceDraft}+` : '10'}
              </span>
            </div>
            <style>{`
              input[type=range].sheet-relevance-slider { -webkit-appearance: none; appearance: none; background: transparent; height: 20px; width: 100%; }
              input[type=range].sheet-relevance-slider::-webkit-slider-runnable-track {
                background: linear-gradient(to right, ${color.accentAmber} 0%, ${color.accentAmber} ${(relevanceDraft / 10) * 100}%, ${color.borderDefault} ${(relevanceDraft / 10) * 100}%, ${color.borderDefault} 100%);
                height: 5px; border-radius: 4px;
              }
              input[type=range].sheet-relevance-slider::-webkit-slider-thumb {
                -webkit-appearance: none; width: 20px; height: 20px; background: ${relevanceDraft > 0 ? color.accentAmber : color.borderStrong};
                border-radius: 50%; margin-top: -7.5px; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.2);
              }
              input[type=range].sheet-relevance-slider::-moz-range-track { background: ${color.borderDefault}; height: 5px; border-radius: 4px; }
              input[type=range].sheet-relevance-slider::-moz-range-progress { background: ${color.accentAmber}; height: 5px; border-radius: 4px 0 0 4px; }
              input[type=range].sheet-relevance-slider::-moz-range-thumb { background: ${relevanceDraft > 0 ? color.accentAmber : color.borderStrong}; border-radius: 50%; width: 20px; height: 20px; border: none; cursor: pointer; }
            `}</style>
            <input
              type="range"
              className="sheet-relevance-slider"
              min={0}
              max={10}
              step={1}
              value={relevanceDraft}
              onChange={e => setRelevanceDraft(Number(e.target.value))}
              onPointerUp={commitRelevance}
              onKeyUp={commitRelevance}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize.xs, color: color.borderStrong, marginTop: 2 }}>
              <span>Any</span>
              <span>10</span>
            </div>
          </div>
          {positionOptions.length > 0 && (
            <SheetSection title="Position">
              {positionOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={positions.includes(opt.value)}
                  onClick={() => toggleItem(positions, opt.value, onPositionChange)}
                  count={counts?.position[opt.value] ?? 0}
                />
              ))}
            </SheetSection>
          )}
          {(totalSessionCount ?? sessionOptions.length) > 0 && (
            <SheetSection title="Session">
              {sessionOptions.map(opt => (
                <SheetChip
                  key={opt.value}
                  label={opt.label}
                  active={sessions.includes(opt.value)}
                  onClick={() => toggleItem(sessions, opt.value, onSessionChange)}
                  count={counts?.session[opt.value] ?? 0}
                />
              ))}
            </SheetSection>
          )}
          {tagOptions.length > 0 && (
            <SheetSection title="Topics">
              {tagOptions.map(tag => (
                <SheetChip
                  key={tag}
                  label={tag}
                  active={tags.includes(tag)}
                  onClick={() => toggleItem(tags, tag, onTagChange)}
                  count={counts?.tags[tag] ?? 0}
                />
              ))}
            </SheetSection>
          )}
        </div>
      </div>
    </>
  )
}
