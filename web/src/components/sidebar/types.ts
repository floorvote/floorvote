export type User = { name?: string; email?: string; subtitle?: string } | null

export interface SidebarProps {
  isOpen: boolean
  onClose: () => void
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
