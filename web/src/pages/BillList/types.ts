export type Bill = {
  id: string
  billNumber: string
  title: string
  state: string
  status: string
  session: string
  sessionId: string | null
  yearStart: number | null
  yearEnd: number | null
  abstract: string | null
  url: string | null
  stateUrl: string | null
  lastAction: string | null
  lastActionDate: string | null
  tenantSummary: string | null
  tags: string[]
  priority: 'high' | 'medium' | 'low' | null
  matchType: 'keyword' | 'manual' | null
  isDraft?: boolean
  position: string | null
  relevanceScore: number | null
  aiProcessedAt: string | null
  newMatchAt: string | null
  triageDismissedAt: string | null
  voteCounts: { support: number; oppose: number; neutral: number }
  myVote: 'support' | 'neutral' | 'oppose' | null
  commentCount: number
  hasNote: boolean
  hasComment: boolean
  updatedAt: string
  customFieldValues?: Record<string, string>
}

export type Selection =
  | { mode: 'none' }
  | { mode: 'ids'; ids: Set<string> }
  | { mode: 'filter' }

export type CustomFieldDef = {
  id: string
  name: string
  slug: string | null
  type: 'binary' | 'dropdown' | 'text' | 'date'
  options: string[] | null
  multiple?: boolean
  displayOrder: number
}

export type NormalizedSession = {
  identifier: string
  name: string
  classification: string
  startDate: string
  endDate: string
}

export type SortColumn = 'default' | 'priority' | 'status' | 'relevance' | 'position' | 'year' | 'session' | 'lastAction' | 'bill'
export type SortDir = 'asc' | 'desc'

export type FacetCounts = {
  status:   Record<string, number>
  priority: Record<string, number>
  session:  Record<string, number>
  year:     Record<string, number>
  state:    Record<string, number>
  position: Record<string, number>
  tags:     Record<string, number>
  customFields: Record<string, Record<string, number>>
  myBillsCount: number
  newMatchesCount: number
}
