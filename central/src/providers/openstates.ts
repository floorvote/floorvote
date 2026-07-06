import type {
  BillProvider, NormalizedSession, NormalizedBillStub, NormalizedBill,
  NormalizedStatus, NormalizedSponsor, NormalizedAction, NormalizedVersion,
  NormalizedDocument, NormalizedVote, NormalizedVoteCount, NormalizedRelatedBill,
  NormalizedVersionLink,
} from './types'

const BASE_URL = 'https://v3.openstates.org'

function jurisdictionId(state: string): string {
  return `ocd-jurisdiction/country:us/state:${state.toLowerCase()}/government`
}

export function deriveStatus(
  actions: { classification: string[]; organization: { classification: string }; order: number }[],
): NormalizedStatus {
  const sorted = [...actions].sort((a, b) => b.order - a.order)
  const passedChambers = new Set<string>()

  for (const action of sorted) {
    const cls = action.classification
    if (cls.some(c => c === 'became-law' || c === 'executive-signature')) return 'enacted'
    if (cls.some(c => c.startsWith('executive-veto'))) return 'vetoed'
    if (cls.includes('failure')) return 'failed'
    if (cls.includes('passage')) {
      passedChambers.add(action.organization.classification)
    }
  }

  if (passedChambers.size >= 2) return 'passed'
  if (passedChambers.has('upper')) return 'passed_upper'
  if (passedChambers.has('lower')) return 'passed_lower'

  for (const action of sorted) {
    const cls = action.classification
    if (cls.includes('committee-passage') || cls.includes('committee-referral')) return 'in_committee'
  }

  if (sorted.some(a => a.classification.includes('introduction') || a.classification.includes('filing'))) {
    return 'introduced'
  }

  return 'unknown'
}

function normalizeSponsors(sponsorships: any[]): NormalizedSponsor[] {
  return (sponsorships ?? []).map(s => ({
    name: s.name,
    party: s.person?.party ?? null,
    role: s.person?.current_role?.title ?? null,
    primary: s.primary,
    personId: s.person?.id ?? null,
  }))
}

function normalizeActions(actions: any[]): NormalizedAction[] {
  return (actions ?? []).map(a => ({
    description: a.description,
    date: a.date,
    chamber: a.organization?.classification ?? null,
    classification: a.classification ?? [],
    order: a.order,
  }))
}

function normalizeVersionLinks(links: any[]): NormalizedVersionLink[] {
  return (links ?? []).map(l => ({ url: l.url, mediaType: l.media_type }))
}

function normalizeVersions(versions: any[]): NormalizedVersion[] {
  return (versions ?? []).map(v => ({
    id: v.id,
    note: v.note,
    date: v.date,
    links: normalizeVersionLinks(v.links),
  }))
}

function normalizeDocuments(documents: any[]): NormalizedDocument[] {
  return (documents ?? []).map(d => ({
    id: d.id,
    note: d.note,
    date: d.date,
    classification: d.classification ?? '',
    links: normalizeVersionLinks(d.links),
  }))
}

function normalizeVotes(votes: any[]): NormalizedVote[] {
  return (votes ?? []).map(v => ({
    id: v.id,
    motionText: v.motion_text,
    date: v.start_date,
    result: v.result,
    chamber: v.organization?.classification ?? null,
    counts: (v.counts ?? []).map((c: any) => ({ option: c.option, value: c.value })),
  }))
}

function normalizeRelatedBills(related: any[]): NormalizedRelatedBill[] {
  return (related ?? []).map(r => ({
    identifier: r.identifier,
    session: r.legislative_session,
    relationType: r.relation_type,
  }))
}

function stateAbbrevFromJurisdiction(jurisdictionIdStr: string): string {
  const match = jurisdictionIdStr.match(/state:([a-z]{2})/)
  return match ? match[1].toUpperCase() : ''
}

function toBillStub(bill: any): NormalizedBillStub {
  const actions = normalizeActions(bill.actions ?? [])
  return {
    id: bill.id,
    state: bill.jurisdiction?.name ? stateAbbrevFromJurisdiction(bill.jurisdiction.id) : '',
    session: bill.session,
    number: bill.identifier,
    title: bill.title,
    abstract: bill.abstracts?.[0]?.abstract ?? null,
    status: actions.length > 0 ? deriveStatus(actions.map(a => ({
      classification: a.classification,
      organization: { classification: a.chamber ?? '' },
      order: a.order,
    }))) : 'unknown',
    statusDate: bill.latest_action_date || null,
    lastAction: bill.latest_action_description || null,
    lastActionDate: bill.latest_action_date || null,
    url: bill.openstates_url ?? '',
    stateUrl: bill.sources?.[0]?.url ?? null,
    sponsors: normalizeSponsors(bill.sponsorships ?? []),
    versions: normalizeVersions(bill.versions ?? []),
    updatedAt: bill.updated_at,
  }
}

function toBill(bill: any): NormalizedBill {
  const stub = toBillStub(bill)
  return {
    ...stub,
    actions: normalizeActions(bill.actions ?? []),
    documents: normalizeDocuments(bill.documents ?? []),
    votes: normalizeVotes(bill.votes ?? []),
    relatedBills: normalizeRelatedBills(bill.related_bills ?? []),
  }
}

const RETRY_DELAYS_MS = [2000, 5000, 10000]

export function createOpenStatesProvider(apiKey: string, trackCall?: () => void): BillProvider {
  async function apiFetch(path: string, params: Record<string, string | string[]> = {}): Promise<any> {
    const url = new URL(path, BASE_URL)
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const val of v) url.searchParams.append(k, val)
      } else {
        url.searchParams.set(k, v)
      }
    }

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const res = await fetch(url.toString(), {
        headers: { 'X-API-KEY': apiKey },
      })
      trackCall?.()

      if (res.status === 429) {
        const delay = RETRY_DELAYS_MS[attempt]
        if (delay === undefined) throw new Error(`OpenStates API 429: rate limit exceeded after ${attempt} retries`)
        const retryAfter = res.headers.get('Retry-After')
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : delay
        console.warn(`[openstates] rate limited, waiting ${waitMs}ms (attempt ${attempt + 1})`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }

      if (!res.ok) throw new Error(`OpenStates API ${res.status}: ${await res.text().catch(() => '')}`)
      return res.json()
    }
  }

  return {
    async fetchSessions(state: string): Promise<NormalizedSession[]> {
      const data = await apiFetch(
        `/jurisdictions/${jurisdictionId(state)}`,
        { include: ['legislative_sessions'] },
      )
      return (data.legislative_sessions ?? []).map((s: any) => ({
        identifier: s.identifier,
        name: s.name,
        classification: s.classification,
        startDate: s.start_date,
        endDate: s.end_date,
      }))
    },

    async *fetchUpdatedBills(state, session, since) {
      let page = 1
      while (true) {
        const data = await apiFetch('/bills', {
          jurisdiction: jurisdictionId(state),
          session,
          updated_since: since.toISOString().split('T')[0],
          include: ['sponsorships', 'versions', 'actions', 'sources', 'abstracts'],
          sort: 'updated_asc',
          per_page: '20',
          page: String(page),
        })
        for (const bill of data.results ?? []) {
          yield toBillStub(bill)
        }
        if (page >= (data.pagination?.max_page ?? 1)) break
        page++
      }
    },

    async fetchBillDetail(id: string): Promise<NormalizedBill> {
      const uuid = id.replace('ocd-bill/', '')
      const data = await apiFetch(
        `/bills/ocd-bill/${uuid}`,
        { include: ['sponsorships', 'actions', 'versions', 'votes', 'documents', 'sources', 'abstracts', 'related_bills'] },
      )
      return toBill(data)
    },

    async *fetchKeywordMatches(state, session, keyword, since) {
      let page = 1
      while (true) {
        const data = await apiFetch('/bills', {
          jurisdiction: jurisdictionId(state),
          session,
          q: keyword,
          created_since: since.toISOString().split('T')[0],
          include: ['versions', 'sponsorships', 'actions', 'sources', 'abstracts'],
          per_page: '20',
          page: String(page),
        })
        for (const bill of data.results ?? []) {
          yield toBillStub(bill)
        }
        if (page >= (data.pagination?.max_page ?? 1)) break
        page++
      }
    },
  }
}
