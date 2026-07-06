// G1 guard logic: find `new Date().toISOString()` uses that would land in a
// stored SQLite timestamp column. Stored columns use space format (see
// docs/date-format-convention.md); mixing ISO breaks ORDER BY / MAX. Non-stored
// uses (response meta, date-only slices, log lines, email bodies) are exempt via
// same-line markers or a `// ts-write-ok` comment.

const ALLOW_MARKERS = ['.slice(0, 10)', '.slice(0,10)', 'generatedAt', 'computedAt', 'meta:', 'ts-write-ok']

export interface Violation { file: string; line: number; text: string }

export function findViolations(file: string, src: string): Violation[] {
  const out: Violation[] = []
  src.split('\n').forEach((text, i) => {
    if (!text.includes('new Date().toISOString()')) return
    if (ALLOW_MARKERS.some((m) => text.includes(m))) return
    out.push({ file, line: i + 1, text: text.trim() })
  })
  return out
}
