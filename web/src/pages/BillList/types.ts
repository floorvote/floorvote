/**
 * A bill in a companion group, as the list row names it: enough to show its
 * number and status and link to its own page. `matched` says whether this bill
 * itself met the list's filters, and is absent when nothing is filtered.
 */
export type GroupMember = {
  id: string
  billNumber: string
  state: string
  status: string
  sessionSlug: string
  matched?: boolean
}

export type Bill = {
  /** The first bill of the row's group (the furthest along), or the bill itself. */
  id: string
  billNumber: string
  title: string
  state: string
  status: string
  session: string
  sessionSlug: string
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
  triagedAt: string | null
  voteCounts: { support: number; oppose: number; neutral: number }
  myVote: 'support' | 'neutral' | 'oppose' | null
  commentCount: number
  hasNote: boolean
  hasComment: boolean
  updatedAt: string
  customFieldValues?: Record<string, string>
  /**
   * Every bill in the row's companion group, the furthest along first, when the
   * row is a group of two or more. The row's own fields are those of the first
   * bill, and its team values, votes, and comments are the group's. Absent for
   * a bill with no companions.
   */
  group?: GroupMember[]
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

import type { CommitteeInfo } from '../../lib/committeeGroups'

export type FacetCounts = {
  status:   Record<string, number>
  /** By common stage key (shared/statusStages.ts). */
  stage:    Record<string, number>
  /**
   * For each status label with bills, the stage its bills sit in (or null) and the rank they sort by. Absent from an
   * API that predates grouping Status by stage, which leaves the page on its two separate controls.
   */
  statusGroups?: Record<string, { stage: string | null; rank: number }>
  priority: Record<string, number>
  sessionName: Record<string, number>
  year:     Record<string, number>
  state:    Record<string, number>
  position: Record<string, number>
  tag:      Record<string, number>
  subject:  Record<string, number>
  /** By central's committee id (#471). Absent from an API older than the Committee filter. */
  committee?: Record<string, number>
  /** Each committee counted, by id: its name, state, and chamber. */
  committeeInfo?: CommitteeInfo
  /**
   * Every state that has subjects (suppressed ones excluded), whatever filters
   * are active, unlike `subject`. Absent = not known yet.
   */
  subjectStates?: string[]
  /** Every state the instance has bills in, whatever filters are active. Absent = not known yet. */
  billStates?: string[]
  /** By custom field id, then by value. */
  field: Record<string, Record<string, number>>
  myBillsCount: number
  newMatchesCount: number
  unvotedCount: number
  draftCount: number
  hasDrafts: boolean
}
