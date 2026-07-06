export type SyncPreset = { id: string; label: string; full: number[]; raw: number[] }

export const SYNC_PRESETS: SyncPreset[] = [
  { id: 'default',  label: 'Default',  full: [5, 13, 23],          raw: [7, 9, 11, 15, 17, 19, 21] },
  { id: 'frequent', label: 'Frequent', full: [1, 5, 9, 13, 17, 21], raw: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] },
  { id: 'minimal',  label: 'Minimal',  full: [5, 17],               raw: [] },
]

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

// Returns the matching preset id, or 'custom' when no preset matches both arrays.
export function matchPreset(full: number[], raw: number[]): string {
  const p = SYNC_PRESETS.find(p => sameSet(p.full, full) && sameSet(p.raw, raw))
  return p ? p.id : 'custom'
}
