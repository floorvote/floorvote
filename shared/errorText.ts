/**
 * A caught error as one line of text: its message and every message down its
 * `.cause` chain, outermost first.
 *
 * Log it alongside the error, as `console.error('[x] failed:', errorText(err), err)`.
 * Workers Logs drops an Error argument's message and keeps only its stack
 * frames, and Drizzle wraps a D1 error as `Failed query: <sql>` with D1's own
 * error (the part that says why) on `.cause`, so the Error object alone
 * reaches the dashboard with no reason at all.
 */
export function errorText(err: unknown): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = err
  while (!seen.has(current)) {
    seen.add(current)
    messages.push(messageOf(current))
    if (current == null || typeof current !== 'object' || !('cause' in current) || current.cause == null) break
    current = current.cause
  }
  return messages.join(' | caused by: ')
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (e != null && typeof e === 'object' && 'message' in e && typeof e.message === 'string') return e.message
  return String(e)
}
