// The server keeps a member's facets for a minute (api/src/lib/facetsCache.ts), so a reload costs the database
// nothing. That would show a member counts from before their own edit: they set a priority on the bill page, go
// back, and the list's counts are the ones it kept. So the page remembers the member's last edit, here in
// sessionStorage so it survives a reload, and each facets request the server may have kept from before it (each
// exact path not counted afresh since) asks once with Cache-Control: no-cache. A click costs no recount: only the
// next facets request of each kind does. apiFetch (./api.ts) applies it to every request.

/** How long after an edit the server may still hold counts from before it: the server's cache TTL. */
export const FACETS_FRESH_WINDOW_MS = 60_000

const WRITE_KEY = 'fv:facets:ownWriteAt'
const FRESH_KEY = 'fv:facets:freshAt'

/** A write whose success can change the bills page's counts. */
export function isOwnWritePath(path: string): boolean {
  return /^\/(bills|comments|config|admin)(\/|\?|$)/.test(path) || /^\/users\/me\/bills(\/|\?|$)/.test(path)
}

/** A facets request. */
export const isFacetsPath = (path: string): boolean => /^\/bills\/facets(\?|$)/.test(path)

function read(key: string): string | null {
  try { return sessionStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string): void {
  try { sessionStorage.setItem(key, value) } catch { /* storage off: the counts may lag up to a minute */ }
}
function freshAt(): Record<string, number> {
  try { return JSON.parse(read(FRESH_KEY) ?? '{}') as Record<string, number> } catch { return {} }
}

/** The member's edit succeeded at `now`. */
export function noteOwnWrite(now = Date.now()): void {
  write(WRITE_KEY, String(now))
}

/** Whether a facets request to `path` must ask afresh: the member edited within the window, after its last fresh count. */
export function needsFreshFacets(path: string, now = Date.now()): boolean {
  const at = Number(read(WRITE_KEY))
  if (!at || now - at > FACETS_FRESH_WINDOW_MS) return false
  return (freshAt()[path] ?? 0) < at
}

/** A fresh facets request to `path`, started at `startedAt`, landed. Entries past the window are dropped. */
export function noteFreshFacets(path: string, startedAt: number): void {
  const kept = Object.fromEntries(Object.entries(freshAt()).filter(([, t]) => startedAt - t <= FACETS_FRESH_WINDOW_MS))
  kept[path] = startedAt
  write(FRESH_KEY, JSON.stringify(kept))
}
