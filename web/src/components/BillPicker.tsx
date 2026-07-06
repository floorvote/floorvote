import { useEffect, useMemo, useState } from 'react'
import { color, radius, fontSize, fontWeight } from '../styles/tokens'
import { BillBadge } from './BillBadge'

export interface BillOption {
  id: string
  billNumber: string
  title: string
  state: string | null
}

const MAX_RESULTS = 8

export function BillPicker({ options, value, onChange, multiState, single }: {
  options: BillOption[]
  value: string[]
  onChange: (ids: string[]) => void
  multiState: boolean
  single?: boolean
}) {
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const selected = useMemo(() => value.map(id => options.find(o => o.id === id)).filter(Boolean) as BillOption[], [value, options])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as BillOption[]
    return options
      .filter(o => !value.includes(o.id))
      .filter(o =>
        o.billNumber.toLowerCase().includes(q) ||
        o.title.toLowerCase().includes(q) ||
        (o.state ?? '').toLowerCase().includes(q))
      .slice(0, MAX_RESULTS)
  }, [query, options, value])

  useEffect(() => { setHighlight(0) }, [query])

  const add = (id: string) => { onChange(single ? [id] : [...value, id]); setQuery('') }
  const remove = (id: string) => onChange(value.filter(v => v !== id))

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(h => Math.min(h + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(h => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      add(matches[Math.min(highlight, matches.length - 1)].id)
    } else if (e.key === 'Escape') {
      setQuery('')
    }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '7px 9px', fontSize: fontSize.sm,
    borderRadius: radius.md, border: `1px solid ${color.borderDefault}`,
    marginTop: 4, boxSizing: 'border-box',
  }

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {selected.map(b => (
            <span key={b.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <BillBadge billNumber={b.billNumber} state={b.state ?? undefined} mini />
              <button type="button" aria-label={`Remove ${b.billNumber}`} onClick={() => remove(b.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: color.textMuted, fontSize: fontSize.sm, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        style={field}
        placeholder="Search bills…"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {matches.length > 0 && (
        <div style={{ border: `1px solid ${color.borderDefault}`, borderRadius: radius.md, marginTop: 4, maxHeight: 200, overflowY: 'auto' }}>
          {matches.map((o, i) => (
            <button key={o.id} type="button" onClick={() => add(o.id)}
              onMouseEnter={() => setHighlight(i)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: i === highlight ? color.surfaceMuted : color.white, border: 'none', borderBottom: `1px solid ${color.surfaceMuted}`, cursor: 'pointer', padding: '6px 9px', font: 'inherit' }}>
              <span style={{ fontSize: fontSize.sm, fontWeight: fontWeight.semibold }}>
                {multiState && o.state ? `${o.state} ${o.billNumber}` : o.billNumber}
              </span>
              <span style={{ fontSize: fontSize.xs, color: color.textMuted }}> — {o.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
