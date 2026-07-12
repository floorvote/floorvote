import { Bar } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip)

/**
 * Non-cumulative per-day bars — e.g. daily AI spend across the window. Unlike
 * CumulativeBudgetChart (a running-total line), each bar is that day's value on
 * its own, so expensive days stand out. `valueFormat` styles the axis + tooltip
 * (default: raw number); pass a currency formatter for spend.
 */
export function DailyCostChart({
  points,
  label = 'Daily',
  valueFormat = (n: number) => n.toLocaleString(),
}: {
  points: { date: string; value: number }[]
  label?: string
  valueFormat?: (n: number) => string
}) {
  const labels = points.map(p => {
    const d = new Date(p.date + 'T00:00:00Z')
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
  })

  const data = {
    labels,
    datasets: [
      {
        label,
        data: points.map(p => p.value),
        backgroundColor: '#1e3a5f',
        borderWidth: 0,
        borderRadius: 1,
      },
    ],
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        intersect: false,
        mode: 'index' as const,
        callbacks: {
          label: (ctx: { parsed: { y: number | null } }) =>
            `${label}: ${valueFormat(ctx.parsed.y ?? 0)}`,
        },
      },
    },
    scales: {
      x: { display: true, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
      y: {
        display: true,
        beginAtZero: true,
        ticks: {
          font: { size: 10 },
          callback: (v: string | number) => valueFormat(Number(v)),
        },
      },
    },
  }

  return (
    <div style={{ height: 120, marginTop: 8 }}>
      <Bar data={data} options={options} />
    </div>
  )
}
