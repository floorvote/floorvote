import type { CalendarKind } from '../sdk'
import type { CongressBillType } from './map'

// Stub: the red tests run against this empty body (#619).

export const LIST_PAGE_SIZE = 250
export const DETAILS_PER_PASS = 60

export type MeetingChamber = 'house' | 'senate' | 'nochamber'

export interface ListedMeeting { eventId: string; chamber: MeetingChamber; updateDate: string }

export interface Meeting {
  eventId: string
  chamber: MeetingChamber
  congress: number
  updateDate: string
  date: string
  time: string | null
  type: string
  status: string
  title: string
  location: string | null
  committees: { systemCode: string; name: string | null }[]
  bills: { type: CongressBillType; number: string }[]
}

export function parseMeetingList(_text: string, _congress: number): { entries: ListedMeeting[]; count: number } {
  return { entries: [], count: 0 }
}

export function parseMeeting(_text: string, _listed: ListedMeeting, _congress: number): Meeting {
  return { eventId: '', chamber: 'house', congress: 0, updateDate: '', date: '', time: null, type: '', status: '', title: '', location: null, committees: [], bills: [] }
}

export function easternTime(_utc: string): { date: string; time: string | null } {
  return { date: '', time: null }
}

export function isCancelled(_status: string): boolean {
  return false
}

export function meetingType(_type: string): { typeId: number; kind: CalendarKind } {
  return { typeId: 0, kind: 'hearing' }
}

export function clearMeetingCaches(): void {}
