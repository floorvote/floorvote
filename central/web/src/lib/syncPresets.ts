export type SyncPreset = { id: string; label: string; full: number[]; raw: number[] }

const OTHER_PRESETS: SyncPreset[] = [
  { id: 'frequent', label: 'Frequent', full: [1, 5, 9, 13, 17, 21], raw: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22] },
  { id: 'minimal',  label: 'Minimal',  full: [5, 17],               raw: [] },
]

/** The presets for a session: "Default" is its provider's own hours, as the sessions route reports them. */
export function presetsFor(s: { defaultFullHours: number[]; defaultRawHours: number[] }): SyncPreset[] {
  return [{ id: 'default', label: 'Default', full: s.defaultFullHours, raw: s.defaultRawHours }, ...OTHER_PRESETS]
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

// Returns the matching preset id, or 'custom' when no preset matches. A snapshot session has no raw hours, so only its full hours count.
export function matchPreset(presets: SyncPreset[], full: number[], raw: number[], snapshot = false): string {
  const p = presets.find(p => sameSet(p.full, full) && (snapshot || sameSet(p.raw, raw)))
  return p ? p.id : 'custom'
}
