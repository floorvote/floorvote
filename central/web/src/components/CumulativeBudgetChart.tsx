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

  const yMax = points.length > 0 ? Math.max(...points.map(p => p.budget)) : undefined

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
      {
        label: 'Budget',
        data: budgetData,
        borderColor: 'rgba(100, 116, 139, 0.4)',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
      },
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
