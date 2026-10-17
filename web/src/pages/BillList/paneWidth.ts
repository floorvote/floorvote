// The split pane's width: its bounds, which columns a given width shows, the
// keyboard steps, and the browser-local copy of the reader's choice. Pure
// functions and a pair of storage helpers, so the pane's behavior at any width
// can be tested without drawing it.

export type PaneColumnKey = 'status' | 'year' | 'lastAction' | 'relevance'

/** One column the pane can show: it appears once the pane is `at` px wide. */
export interface PaneColumn { key: PaneColumnKey; label: string; at: number }

/**
 * The pane's columns, in the order they appear as it widens, and their headers
 * (the Bills page's words). Priority and position stay out: they are controls,
 * and the pane only reads. The status chip is capped to that track's width (#404).
 */
export const PANE_COLUMNS: PaneColumn[] = [
  { key: 'status', label: 'Status', at: 400 },
  { key: 'year', label: 'Year', at: 480 },
  { key: 'lastAction', label: 'Last action', at: 560 },
  { key: 'relevance', label: 'Relevance', at: 640 },
]

export const PANE_DEFAULT_WIDTH = 300
export const PANE_MIN_WIDTH = 300
export const PANE_KEY_STEP = 16
export const PANE_WIDTH_STORAGE_KEY = 'billListPaneWidth'

// The room the pane always leaves the bill page beside it. At a 1600px window
// with the default 230px sidebar that makes the pane's maximum 670px.
const MIN_DETAIL_WIDTH = 700

// The sidebar keeps its own width in localStorage under this key, within these
// bounds (Sidebar.tsx). The pane reads it so a wider sidebar costs the pane
// room, not the bill page.
const SIDEBAR_STORAGE_KEY = 'sidebarWidth'
const SIDEBAR_DEFAULT_WIDTH = 230
const SIDEBAR_MAX_WIDTH = 400

export function paneMaxWidth(viewportWidth: number, sidebarWidth: number = SIDEBAR_DEFAULT_WIDTH): number {
  return Math.max(PANE_MIN_WIDTH, Math.round(viewportWidth - sidebarWidth - MIN_DETAIL_WIDTH))
}

export function clampPaneWidth(width: number, max: number): number {
  if (!Number.isFinite(width)) return PANE_DEFAULT_WIDTH
  return Math.max(PANE_MIN_WIDTH, Math.min(Math.max(PANE_MIN_WIDTH, max), Math.round(width)))
}

// One array per count of columns showing, so the same width always yields the
// same array and the pane's memoized rows keep their props while it is dragged.
const COLUMN_SETS: PaneColumn[][] = PANE_COLUMNS.map((_, i) => PANE_COLUMNS.slice(0, i + 1))
const NO_COLUMNS: PaneColumn[] = []

export function visiblePaneColumns(width: number): PaneColumn[] {
  const count = PANE_COLUMNS.filter(c => width >= c.at).length
  return count === 0 ? NO_COLUMNS : COLUMN_SETS[count - 1]
}

// Grid tracks, the Bills page's own (constants.ts CHIP_GRID): the bill number,
// then each column that shows. Header and rows share this template so every
// cell sits under its header. `status` is as wide as the status chip's cap
// (STATUS_CHIP_MAX_WIDTH), so a capped chip fits its track (#404).
const BILL_TRACK = '70px'
const BILL_TRACK_MULTISTATE = '105px'
const COLUMN_TRACKS: Record<PaneColumnKey, string> = {
  status: '100px',
  year: '90px',
  lastAction: '130px',
  relevance: 'auto',
}

export function paneGridTemplate(columns: PaneColumn[], multiState: boolean): string {
  return [multiState ? BILL_TRACK_MULTISTATE : BILL_TRACK, ...columns.map(c => COLUMN_TRACKS[c.key])].join(' ')
}

/** The width a key press asks for, or null for a key the separator ignores. */
export function keyboardPaneWidth(width: number, key: string, max: number): number | null {
  switch (key) {
    case 'ArrowLeft': return clampPaneWidth(width - PANE_KEY_STEP, max)
    case 'ArrowRight': return clampPaneWidth(width + PANE_KEY_STEP, max)
    case 'Home': return PANE_MIN_WIDTH
    case 'End': return clampPaneWidth(max, max)
    default: return null
  }
}

// localStorage can throw (a blocked or full store, a sandboxed frame), so every
// access is guarded and the pane falls back to its default width.
export function readStoredPaneWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(PANE_WIDTH_STORAGE_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Stores the width, or forgets it for `null` (the pane is back at its default). */
export function writeStoredPaneWidth(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(PANE_WIDTH_STORAGE_KEY)
    else localStorage.setItem(PANE_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // The width still applies for this visit; it just isn't remembered.
  }
}

export function readSidebarWidth(): number {
  try {
    const n = parseInt(localStorage.getItem(SIDEBAR_STORAGE_KEY) ?? '', 10)
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH
    return Math.max(SIDEBAR_DEFAULT_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, n))
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}
