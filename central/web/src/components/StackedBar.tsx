export function StackedBar({ segments }: { segments: { label: string; value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  if (total === 0) return <div style={{ fontSize: 12, color: 'var(--muted)' }}>No data</div>
  return (
    <div>
      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', background: 'var(--border)' }}>
        {segments.map((s, i) => (
          <div key={i} title={`${s.label}: ${s.value}`} style={{ background: s.color, width: `${(s.value / total) * 100}%` }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
        {segments.map((s, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, background: s.color, borderRadius: 2 }} /> {s.label}: {s.value}
          </span>
        ))}
      </div>
    </div>
  )
}
