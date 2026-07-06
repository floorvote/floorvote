import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

export type EngagementSeries = {
  dates: string[]
  perTenant: { id: string; name: string; values: (number | null)[]; color: string }[]
  aggregate?: (number | null)[]
}

export function EngagementChart({ title, current, series, height = 160 }: {
  title: string
  current: number | null
  series: EngagementSeries
  height?: number
}) {
  const datasets: any[] = series.perTenant.map((_t) => ({
    label: _t.name,
    data: _t.values,
    borderColor: _t.color,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 3,
    spanGaps: false,
  }))
  if (series.aggregate) {
    datasets.push({
      label: 'Total',
      data: series.aggregate,
      borderColor: '#1e3a5f',  // bold blue
      backgroundColor: 'transparent',
      borderWidth: 2.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: false,
    })
  }

  const data = { labels: series.dates, datasets }
  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { mode: 'index' as const, intersect: false },
    },
    scales: {
      x: { display: true, ticks: { maxTicksLimit: 6, font: { size: 10 } } },
      y: { display: true, beginAtZero: true, ticks: { font: { size: 10 } } },
    },
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 6, padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--muted)' }}>{title}</div>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{current?.toLocaleString() ?? '—'}</div>
      </div>
      <div style={{ height }}>
        <Line data={data} options={options} />
      </div>
    </div>
  )
}
