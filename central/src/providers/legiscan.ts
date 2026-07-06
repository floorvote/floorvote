import type {
  BillProvider, NormalizedSession, NormalizedBillStub, NormalizedBill,
  NormalizedStatus,
} from './types'
import {
  getMasterList, getBill, getSessionList,
  type LegiscanBill, type MasterListEntry,
} from '../lib/legiscan'
import { nowDb } from '../lib/dbTime'

const LEGISCAN_STATUS: Record<number, NormalizedStatus> = {
  0: 'introduced',
  1: 'introduced',
  2: 'passed_lower',
  3: 'passed',
  4: 'enacted',
  5: 'vetoed',
  6: 'failed',
}

function normalizeLegiscanBill(bill: LegiscanBill): NormalizedBill {
  const sortedHistory = [...(bill.history ?? [])].sort((a, b) => a.date.localeCompare(b.date))
  const lastEntry = sortedHistory[sortedHistory.length - 1]
  return {
    id: `legiscan:${bill.bill_id}`,
    state: bill.state,
    session: String(bill.session_id),
    number: bill.bill_number,
    title: bill.title,
    abstract: bill.description || null,
    status: LEGISCAN_STATUS[bill.status] ?? 'unknown',
    statusDate: bill.status_date || null,
    lastAction: lastEntry?.action ?? null,
    lastActionDate: lastEntry?.date ?? null,
    url: bill.url,
    stateUrl: bill.state_link || null,
    sponsors: (bill.sponsors ?? []).map(s => ({
      name: s.name,
      party: s.party || null,
      role: s.role || null,
      primary: s.sponsor_type_id === 1,
      personId: s.people_id ? String(s.people_id) : null,
    })),
    actions: sortedHistory.map((h, i) => ({
      description: h.action,
      date: h.date,
      chamber: h.chamber || null,
      classification: [],
      order: i,
    })),
    versions: (bill.texts ?? []).map(t => ({
      id: String(t.doc_id),
      note: t.type,
      date: t.date,
      links: [{ url: t.state_link, mediaType: t.mime }],
    })),
    documents: (bill.supplements ?? []).map(s => ({
      id: String(s.supplement_id),
      note: s.title || s.type,
      date: s.date,
      classification: s.type,
      links: [{ url: s.state_link, mediaType: s.mime }],
    })),
    votes: (bill.votes ?? []).map(v => ({
      id: String(v.roll_call_id),
      motionText: v.desc,
      date: v.date,
      result: v.passed ? 'pass' : 'fail',
      chamber: v.chamber || null,
      counts: [
        { option: 'yes', value: v.yea },
        { option: 'no', value: v.nay },
        { option: 'not voting', value: v.nv },
        { option: 'absent', value: v.absent },
      ],
    })),
    relatedBills: (bill.sasts ?? []).map(s => ({
      identifier: s.sast_bill_number,
      session: String(bill.session_id),
      relationType: s.type.toLowerCase().replace(/\s+/g, '-'),
    })),
    updatedAt: nowDb(),
  }
}

export function createLegiscanProvider(apiKey: string): BillProvider {
  return {
    async fetchSessions(state) {
      const sessions = await getSessionList(state, apiKey)
      return sessions.map(s => ({
        identifier: String(s.session_id),
        name: s.session_name,
        classification: s.special ? 'special' : 'primary',
        startDate: `${s.year_start}-01-01`,
        endDate: `${s.year_end}-12-31`,
      }))
    },

    async *fetchUpdatedBills(state, _session, _since) {
      const entries = await getMasterList(state, apiKey)
      for (const entry of entries) {
        yield {
          id: `legiscan:${entry.bill_id}`,
          state,
          session: _session,
          number: entry.number,
          title: entry.title,
          abstract: entry.description || null,
          status: 'unknown' as NormalizedStatus,
          statusDate: null,
          lastAction: null,
          lastActionDate: null,
          url: '',
          stateUrl: null,
          sponsors: [],
          versions: [],
          updatedAt: nowDb(),
        }
      }
    },

    async fetchBillDetail(id) {
      const billId = parseInt(id.replace('legiscan:', ''), 10)
      const bill = await getBill(billId, apiKey)
      return normalizeLegiscanBill(bill)
    },

    async *fetchKeywordMatches() {
      // LegiScan doesn't support keyword search via this interface.
    },
  }
}
