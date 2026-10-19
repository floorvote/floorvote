// The table's outer columns: the title column, Position, Priority. Priority is
// 140px so the amber "New · Set priority" control (135px) fits its track. The
// padding the header and every row share sits outside the tracks: 8px left, and
// 28px right so the Priority control isn't against the table's edge.
export const POSITION_COL_WIDTH = 170
export const PRIORITY_COL_WIDTH = 140
export const ROW_PADDING_LEFT = 8
export const ROW_PADDING_RIGHT = 28
export const OUTER_GRID = `minmax(0,1fr) ${POSITION_COL_WIDTH}px ${PRIORITY_COL_WIDTH}px`
// auto for relevance so "TOPIC RELEVANCE" header fits; status/lastAction narrow, session wider
export const CHIP_GRID = '70px 100px 90px 130px auto'
export const CHIP_GRID_MULTISTATE = '105px 100px 90px 130px auto'
export const CHIP_GAP = 16
export const PAGE_SIZE = 100

// Semantic order for status filter dropdown (most-advanced first, matching sort direction).
// Module-scoped so the useMemo that consumes it doesn't need it in its deps array.
// LegiScan's progress codes 7 to 12 sit beside the words central now sends for
// them (shared/legacyStatusOrder.ts), so either form keeps its place.
export const STATUS_SEMANTIC_ORDER = [
  '8', 'Chaptered', '7', 'Override', 'Passed', 'Vetoed', 'Failed',
  'Enrolled', 'Engrossed', '10', 'Report Pass', '11', 'Report DNP', '9', 'Referred',
  'Introduced', 'Pre-filed', '12', 'Draft',
]
