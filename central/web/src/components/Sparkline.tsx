import { useState } from 'react'

type Point = { label: string; value: number }

export function Sparkline({
  values,
  points,
  width = 200,
  height = 36,
}: {
  values?: number[]
  points?: Point[]
  width?: number
  height?: number
}) {
  const data: Point[] = points ?? (values ?? []).map((v, i) => ({ label: String(i), value: v }))
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)

  if (data.length === 0) return <div style={{ width, height }} />

  const max = Math.max(...data.map(d => d.value), 1)
  const showAxes = Boolean(points)
  const padLeft = showAxes ? 44 : 0
  const padBottom = showAxes ? 22 : 0
  const padTop = 4
  const padRight = 4
  const plotW = Math.max(width - padLeft - padRight, 10)
  const plotH = Math.max(height - padTop - padBottom, 10)
  const stepX = plotW / Math.max(data.length - 1, 1)

  const xy = (i: number, v: number) => ({
    x: padLeft + i * stepX,
    y: padTop + plotH - (v / max) * plotH,
  })

  const linePoints = data.map((d, i) => {
    const p = xy(i, d.value)
    return `${p.x},${p.y}`
  }).join(' ')

  const yTicks = [0, max]
  const xTickIdxs = data.length <= 4
    ? data.map((_, i) => i)
    : [0, Math.floor((data.length - 1) / 2), data.length - 1]

  function handleMove(e: React.MouseEvent<SVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - padLeft
    const idx = Math.round(x / stepX)
    if (idx >= 0 && idx < data.length) setHoverIdx(idx)
    else setHoverIdx(null)
  }

  const hover = hoverIdx !== null ? xy(hoverIdx, data[hoverIdx].value) : null

  return (
    <svg
      width={width}
      height={height}
      style={{ display: 'block', overflow: 'visible' }}
      onMouseMove={handleMove}
      onMouseLeave={() => setHoverIdx(null)}
    >
      {showAxes && (
        <>
          <line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + plotH} stroke="var(--border)" strokeWidth={1} />
          <line x1={padLeft} y1={padTop + plotH} x2={padLeft + plotW} y2={padTop + plotH} stroke="var(--border)" strokeWidth={1} />
          {yTicks.map(v => {
            const y = padTop + plotH - (v / max) * plotH
            return (
              <g key={v}>
                <line x1={padLeft - 3} y1={y} x2={padLeft} y2={y} stroke="var(--border)" strokeWidth={1} />
                <text x={padLeft - 6} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--muted)">
                  {v.toLocaleString()}
                </text>
              </g>
            )
          })}
          {xTickIdxs.map(i => {
            const x = padLeft + i * stepX
            return (
              <g key={i}>
                <line x1={x} y1={padTop + plotH} x2={x} y2={padTop + plotH + 3} stroke="var(--border)" strokeWidth={1} />
                <text x={x} y={padTop + plotH + 14} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {data[i].label}
                </text>
              </g>
            )
          })}
        </>
      )}
      <polyline points={linePoints} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      {/* Invisible hit area so the cursor can hover the full plot region even where the line isn't */}
      <rect
        x={padLeft}
        y={padTop}
        width={plotW}
        height={plotH}
        fill="transparent"
      />
      {hover && (
        <>
          <line x1={hover.x} y1={padTop} x2={hover.x} y2={padTop + plotH} stroke="var(--muted)" strokeWidth={1} strokeDasharray="2,2" />
          <circle cx={hover.x} cy={hover.y} r={3} fill="var(--accent)" stroke="white" strokeWidth={1} />
          {(() => {
            const text = `${data[hoverIdx!].label}: ${data[hoverIdx!].value.toLocaleString()}`
            const approxW = text.length * 6 + 12
            const tx = Math.min(Math.max(hover.x - approxW / 2, padLeft), padLeft + plotW - approxW)
            const ty = Math.max(padTop, hover.y - 26)
            return (
              <g>
                <rect x={tx} y={ty} width={approxW} height={18} rx={3} fill="#1f2937" />
                <text x={tx + approxW / 2} y={ty + 12} textAnchor="middle" fontSize={11} fill="white">
                  {text}
                </text>
              </g>
            )
          })()}
        </>
      )}
    </svg>
  )
}
