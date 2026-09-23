import type { RefObject } from 'react'

export type User = { name?: string; email?: string; subtitle?: string } | null

export interface SidebarProps {
  isOpen: boolean
  onClose: () => void
  /** Forwarded to the root `<aside>` — lets AppLayout focus-trap the mobile drawer. */
  containerRef?: RefObject<HTMLElement | null>
}

export interface PriorityBill {
  id: string
  billNumber: string
  sessionSlug: string | null
  state: string | null
  title: string
  summary: string | null
  priority: 'high' | 'medium' | 'low'
  myVote: string | null
  /** Draft bills get the dashed BillBadge variant plus a screen-reader-only
   *  ", draft" on the badge (`draftSrLabel`) — the priority control shares the
   *  badge's line, so there is no room for a visible DraftChip.
   *  Required, not optional: /stats/sidebar is the only producer of this shape,
   *  so making it optional would buy nothing and would let a dropped select
   *  column read as "filed" — a silent solid badge — instead of a type error. */
  isDraft: boolean
}

export interface HearingBill {
  id: string
  billNumber: string
  title: string
  summary: string | null
  priority: 'high' | 'medium' | 'low' | null
  state: string | null
  sessionSlug: string | null
  myVote: string | null
  /** See PriorityBill.isDraft. Always false today — hearings join to tenant
   *  rows on the LegiScan externalId and drafts have none — but the chip
   *  renders whatever arrives. */
  isDraft: boolean
}

export interface HearingGroup {
  hearingKey: string
  /** Canonical hearing identity, shared with the calendar event for deep-linking. */
  eventHash: string
  type: string | null
  date: string
  time: string | null
  location: string | null
  description: string | null
  bills: HearingBill[]
}

export interface SidebarData {
  priorityBillCount: number
  unvotedPriorityCount: number
  upcomingHearings: HearingGroup[]
  /** Lookahead window (days) the hearings list covers; drives the widget's hint text. */
  upcomingHearingsDays: number
  priorityBills: PriorityBill[]
}

export interface Stats {
  billCount: number
  memberCount: number
  calendarUpcomingCount: number
  calendarUpcomingDays: number
  /** Admin/owner only — un-triaged new keyword matches; 0 for members. */
  newMatchesCount?: number
}

export interface Config {
  associationName: string
  states: string[]
  modules: Record<string, boolean>
  /** Resolved org self-noun from GET /config (e.g. 'team', 'chapter'). Drives
   *  the members popup's roles-column header via orgRolesLabel. */
  orgNoun?: string
  demoLocked?: boolean
}

export interface Member {
  id: string
  name: string
  email: string
  subtitle: string | null
  role: 'admin' | 'member' | 'owner'
  roles: { id: string; name: string }[]
}
