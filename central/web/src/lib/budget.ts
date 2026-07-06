export function utcDayOfMonth(dateStr: string): number {
  return parseInt(dateStr.slice(8, 10), 10)
}

export function cumulativeFromDaily(daily: { date: string; value: number }[]): { day: number; value: number }[] {
  let sum = 0
  return daily.map(({ date, value }) => {
    sum += value
    return { day: utcDayOfMonth(date), value: sum }
  })
}

export interface PaceResult {
  monthPct: number
  expectedByNow: number
  pacePct: number
  projected: number
}

export function computePace({ used, limit, monthElapsed }: { used: number; limit: number; monthElapsed: number }): PaceResult {
  const monthPct = Math.round(monthElapsed * 100)
  const expectedByNow = Math.round(limit * monthElapsed)
  const pacePct = expectedByNow > 0 ? Math.round(used / expectedByNow * 100) : 0
  const projected = monthElapsed > 0 ? Math.round(used / monthElapsed) : 0
  return { monthPct, expectedByNow, pacePct, projected }
}

export function build90DayPoints(
  daily: { date: string; value: number }[],
  limit: number,
  mode: 'increments' | 'snapshots',
): { date: string; actual: number | null; budget: number }[] {
  const byDate = new Map(daily.map(d => [d.date, d.value]))
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const startDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 89))

  const result: { date: string; actual: number | null; budget: number }[] = []
  let monthCumulative = 0
  let currentMonth = -1

  for (const cur = new Date(startDate); cur.toISOString().slice(0, 10) <= todayStr; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const dateStr = cur.toISOString().slice(0, 10)
    const month = cur.getUTCMonth()
    const dayOfMonth = cur.getUTCDate()
    const daysInMonth = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate()

    if (month !== currentMonth) {
      monthCumulative = 0
      currentMonth = month
    }

    const rawValue = byDate.get(dateStr)
    let actual: number | null
    if (mode === 'increments') {
      monthCumulative += rawValue ?? 0
      actual = monthCumulative
    } else {
      actual = rawValue !== undefined ? rawValue : null
    }

    result.push({ date: dateStr, actual, budget: Math.round(limit * dayOfMonth / daysInMonth) })
  }

  return result
}
