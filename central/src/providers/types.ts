// central/src/providers/types.ts

export type NormalizedStatus =
  | 'introduced' | 'in_committee' | 'passed_lower' | 'passed_upper'
  | 'passed' | 'enacted' | 'vetoed' | 'failed' | 'unknown'

export interface NormalizedSponsor {
  name: string
  party: string | null
  role: string | null
  primary: boolean
  personId: string | null
}

export interface NormalizedAction {
  description: string
  date: string
  chamber: string | null
  classification: string[]
  order: number
}

export interface NormalizedVersionLink {
  url: string
  mediaType: string
}

export interface NormalizedVersion {
  id: string
  note: string
  date: string
  links: NormalizedVersionLink[]
}

export interface NormalizedDocument {
  id: string
  note: string
  date: string
  classification: string
  links: NormalizedVersionLink[]
}

export interface NormalizedVoteCount {
  option: string
  value: number
}

export interface NormalizedVote {
  id: string
  motionText: string
  date: string
  result: string
  chamber: string | null
  counts: NormalizedVoteCount[]
}

export interface NormalizedRelatedBill {
  identifier: string
  session: string
  relationType: string
}

export interface NormalizedBillStub {
  id: string
  state: string
  session: string
  number: string
  title: string
  abstract: string | null
  status: NormalizedStatus
  statusDate: string | null
  lastAction: string | null
  lastActionDate: string | null
  url: string
  stateUrl: string | null
  sponsors: NormalizedSponsor[]
  versions: NormalizedVersion[]
  updatedAt: string
}

export interface NormalizedBill extends NormalizedBillStub {
  actions: NormalizedAction[]
  documents: NormalizedDocument[]
  votes: NormalizedVote[]
  relatedBills: NormalizedRelatedBill[]
}

export interface NormalizedSession {
  identifier: string
  name: string
  classification: string
  startDate: string
  endDate: string
}

export interface BillProvider {
  fetchSessions(state: string): Promise<NormalizedSession[]>
  fetchUpdatedBills(state: string, session: string, since: Date): AsyncIterable<NormalizedBillStub>
  fetchBillDetail(id: string): Promise<NormalizedBill>
  fetchKeywordMatches(state: string, session: string, keyword: string, since: Date): AsyncIterable<NormalizedBillStub>
}
