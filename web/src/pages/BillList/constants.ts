export const OUTER_GRID = 'minmax(0,1fr) 170px 120px'
// auto for relevance so "TOPIC RELEVANCE" header fits; status/lastAction narrow, session wider
export const CHIP_GRID = '70px 100px 90px 130px auto'
export const CHIP_GRID_MULTISTATE = '105px 100px 90px 130px auto'
export const CHIP_GAP = 16
export const PAGE_SIZE = 100

// Semantic order for status filter dropdown (most-advanced first, matching sort direction).
// Module-scoped so the useMemo that consumes it doesn't need it in its deps array.
export const STATUS_SEMANTIC_ORDER = [
  '8', '7', 'Passed', 'Vetoed', 'Failed',
  'Enrolled', 'Engrossed', '10', '11', '9',
  'Introduced', 'Pre-filed', '12',
]
