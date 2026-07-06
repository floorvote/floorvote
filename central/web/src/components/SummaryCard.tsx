import { ReactNode } from 'react'

export function SummaryCard({ label, value, footnote, accent, onClick }: {
  label: string
  value: ReactNode
  footnote?: ReactNode
  accent?: 'normal' | 'warning' | 'danger'
  onClick?: () => void
}) {
  const bar = accent === 'danger' ? 'var(--danger)' : accent === 'warning' ? 'var(--warning)' : 'var(--accent)'
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderTop: `3px solid ${bar}`,
        borderRadius: 6,
        padding: '16px 18px',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {footnote && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{footnote}</div>}
    </div>
  )
}
