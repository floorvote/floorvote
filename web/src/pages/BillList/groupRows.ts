import type { CSSProperties } from 'react'

// Where each piece of a companion group row sits, shared by the Bills table and
// the split pane (both draw a group the way groupDisplay collapses it).
//
// A group's bill numbers and statuses are cells of different columns, and a
// status pill is shorter than a bill chip, so two independent stacks drift: a
// lone status centers on the whole stack, and two statuses fall out of line with
// their chips. Instead both are drawn on rows of one grid: a row per shown bill,
// plus one under them for "+N". The number and status cells are subgrids of that
// grid, so a bill and its status are given the same row and centered on it.
// A status the group shares spans every bill row, so it reads as belonging to
// all of them. "+N" has a row of its own, outside the alignment.

/** The gap between a group's chip rows, as it was between the stacked chips. */
export const GROUP_ROW_GAP = 4

export interface GroupPlacement {
  /** Grid rows the group needs: one per shown bill, plus one for "+N". */
  rows: number
  /** Rows holding bills (the rows a shared status spans). */
  chipRows: number
  /** The row of each shown bill's number, in order. */
  numberRows: number[]
  /** The row of "+N", or null when no bill is hidden. */
  moreRow: number | null
  /** The `grid-row` of each status, in the order groupDisplay lists them. */
  statusRows: string[]
}

export function groupPlacement({ shown, hidden, statuses }: {
  shown: unknown[]; hidden: unknown[]; statuses: string[]
}): GroupPlacement {
  const chipRows = shown.length
  const hasMore = hidden.length > 0
  // groupDisplay collapses identical statuses, so fewer statuses than bills
  // means every shown bill has the one.
  const shared = statuses.length === 1 && chipRows > 1
  return {
    rows: chipRows + (hasMore ? 1 : 0),
    chipRows,
    numberRows: shown.map((_, i) => i + 1),
    moreRow: hasMore ? chipRows + 1 : null,
    statusRows: statuses.map((_, i) => (shared ? `1 / span ${chipRows}` : String(i + 1))),
  }
}

/** The grid a group's cells sit on: one auto-sized row per placement row. */
export const groupGridStyle = (rows: number): CSSProperties => ({
  gridTemplateRows: `repeat(${rows}, auto)`,
  rowGap: GROUP_ROW_GAP,
})

/**
 * A cell (the bill numbers, or the statuses) that takes the group grid's rows as
 * its own. Its one column is the width of the cell's track, never wider.
 */
export const subgridCellStyle: CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'subgrid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gridRow: '1 / -1',
  alignSelf: 'stretch',
  minWidth: 0,
}

/**
 * One chip (or "+N") placed on its row, or across the rows it spans, centered
 * there and held to the cell's left edge. `column` is for the two-column grids
 * of the phone row and the narrow pane, where a cell has no track of its own.
 */
export const groupItemStyle = (row: string | number, column?: number): CSSProperties => ({
  gridRow: String(row),
  ...(column !== undefined ? { gridColumn: String(column) } : {}),
  alignSelf: 'center',
  justifySelf: 'start',
  display: 'flex',
  minWidth: 0,
  maxWidth: '100%',
})
