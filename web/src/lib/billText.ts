// Shared helpers for bill-text version labels.

export function normalizeVersionNote(note: string | null | undefined): string {
  if (!note) return 'Introduced'
  const stripped = note.trim().replace(/^\d+[\s ]+/, '').trim()
  if (!stripped) return 'Introduced'
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}
