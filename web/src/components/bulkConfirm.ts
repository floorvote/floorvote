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

/** "A", "A and B", "A, B, and C". */
function joinWords(items: string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** "add A and B, remove C": what a multi-select bulk edit does to each selected bill. */
export function describeMultiDelta(d: { additions: string[]; removals: string[] }): string {
  const parts: string[] = []
  if (d.additions.length > 0) parts.push(`add ${joinWords(d.additions)}`)
  if (d.removals.length > 0) parts.push(`remove ${joinWords(d.removals)}`)
  return parts.join(', ')
}

export const MULTI_UNCHANGED_NOTE = 'Other values on each bill stay as they are.'

export function bulkConfirmMessage(args: {
  count: number
  lines: string
  promotableCount: number
  /** A multi-select field change is staged; adds the "other values stay" note under the list. */
  hasMultiChange?: boolean
}): string {
  const { count, lines, promotableCount, hasMultiChange } = args
  let msg = `Apply changes to ${count.toLocaleString()} bill${count !== 1 ? 's' : ''}?\n\n${lines}`
  if (hasMultiChange) msg += `\n\n${MULTI_UNCHANGED_NOTE}`
  if (promotableCount <= 0) return msg
  const n = promotableCount.toLocaleString()
  return `${msg}\n\n${n} of these bill${promotableCount !== 1 ? 's' : ''} will be promoted to full tracking and queued for AI analysis.`
}
