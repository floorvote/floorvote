import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
} from 'chart.js'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip)

export function CumulativeBudgetChart({
  points,
  label = 'Usage',
}: {
  points: { date: string; actual: number | null; budget: number }[]
  label?: string
}) {
  const labels = points.map(p => {
    const d = new Date(p.date + 'T00:00:00Z')
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
  })

  const actualData = points.map(p => p.actual)
  const budgetData = points.map(p => p.budget)

  // Scale the y-axis to whichever line is taller. When there's no budget line
  // (all-zero — e.g. AI usage, which has no fixed quota), fall back to the actual
  // series so the cumulative line isn't clipped to a flat zero axis.
  const maxBudget = points.length > 0 ? Math.max(...budgetData) : 0
  const maxActual = actualData.reduce<number>((m, v) => (v != null && v > m ? v : m), 0)
  const yMax = Math.max(maxBudget, maxActual) || undefined
  const hasBudget = maxBudget > 0

  const data = {
    labels,
    datasets: [
      {
        label,
        data: actualData,
        borderColor: '#1e3a5f',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        spanGaps: false,
      },
      // Only render the budget reference line when a limit is configured.
      ...(hasBudget ? [{
        label: 'Budget',
        data: budgetData,
        borderColor: 'rgba(100, 116, 139, 0.4)',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
      }] : []),
    ],
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { mode: 'index' as const, intersect: false },
    },
    scales: {
      x: { display: true, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
      y: {
        display: true,
        beginAtZero: true,
        max: yMax,
        ticks: { font: { size: 10 } },
      },
    },
  }

  return (
    <div style={{ height: 120, marginTop: 8 }}>
      <Line data={data} options={options} />
    </div>
  )
}
