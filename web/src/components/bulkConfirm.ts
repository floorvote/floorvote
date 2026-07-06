export function promotableCount(args: {
  mode: 'ids' | 'filter' | 'none'
  selectedBills: Array<{ matchType?: string | null }>
  nullMatchCount: number | null
  stagedPriority: string | null | undefined
}): number {
  // Promotion only happens when a non-null priority is being set.
  if (typeof args.stagedPriority !== 'string' || args.stagedPriority === '') return 0
  if (args.mode === 'ids') return args.selectedBills.filter(b => b.matchType == null).length
  if (args.mode === 'filter') return args.nullMatchCount ?? 0
  return 0
}

export function bulkConfirmMessage(args: { count: number; lines: string; promotableCount: number }): string {
  const { count, lines, promotableCount } = args
  const base = `Apply changes to ${count.toLocaleString()} bill${count !== 1 ? 's' : ''}?\n\n${lines}`
  if (promotableCount <= 0) return base
  const n = promotableCount.toLocaleString()
  return `${base}\n\n${n} of these bill${promotableCount !== 1 ? 's' : ''} will be promoted to full tracking and queued for AI analysis.`
}
