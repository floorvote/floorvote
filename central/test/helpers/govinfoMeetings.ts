/**
 * Test helpers for GovInfo committee meetings (#619): the Congress.gov API's
 * committee-meeting list and detail answers, as a stubbed network serves them.
 *
 * Every file under test/fixtures/govinfo/meetings is a real answer, recorded
 * on October 17, 2026 (the detail of each meeting, with its long lists of
 * witnesses, documents, and videos cut to the first item). `list-page.json` is
 * the first page of the real list, as recorded. The answers are served the way
 * the API serves them: the list newest update first, a page at a time, with
 * the count and the address of the next page, and a 403 for a request that
 * doesn't carry the key in the `X-Api-Key` header.
 */

const details = import.meta.glob('../fixtures/govinfo/meetings/detail-*.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const listPage = import.meta.glob('../fixtures/govinfo/meetings/list-page.json', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** The key every request must carry. Made up for the tests: nothing here is a real key. */
export const CONGRESS_KEY = 'test-congress-key'

export const CONGRESS_API = 'https://api.congress.gov/v3'
export const CONGRESS_HOST = 'https://api.congress.gov/'

/** The first page of the real list, as recorded. */
export const recordedListPage: any = JSON.parse(Object.values(listPage)[0])

/** Every recorded meeting's detail, as the API answered (`{ committeeMeeting, request }`), by event id. */
export const recordedDetails: ReadonlyMap<string, any> = new Map(Object.entries(details).map(([path, raw]) => {
  const id = /detail-(\d+)\.json$/.exec(path)![1]
  return [id, JSON.parse(raw)]
}))

/** The path segment the API uses for a chamber: `house`, `senate`, `nochamber`. */
export const chamberPath = (chamber: string) => chamber.toLowerCase()

export interface Requested { url: string; method: string; headers: Record<string, string>; redirect: RequestInit['redirect'] | undefined }

/** A request's headers as plain lower-cased fields, from whichever form the code passed them in. */
export function plainHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const h = init?.headers
  if (!h) return out
  const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h)
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v)
  return out
}

/**
 * The stubbed API. `meetings` holds each meeting as the API's detail serves it
 * (the `committeeMeeting` object), by event id; a test adds, edits, and removes
 * them. `edit` stamps a new `updateDate`, as the API does when a meeting
 * changes, since the list is how the provider learns that it did.
 */
export class MeetingFeed {
  readonly meetings = new Map<string, any>()
  readonly requests: Requested[] = []
  /** Replace the answer to the list or to one meeting's detail. Return null to answer as usual. */
  /** Added to the count the list gives, to make it disagree with what it lists. */
  countOffset = 0
  override: { list?: (offset: number) => Response | null; detail?: (eventId: string) => Response | null } = {}
  private clock = Date.parse('2026-10-17T13:00:00Z')

  constructor(recorded: Iterable<[string, any]> = recordedDetails) {
    for (const [id, d] of recorded) this.meetings.set(id, structuredClone(d.committeeMeeting))
  }

  /** A meeting as the API serves it, with its own copy of the recorded one's fields changed. */
  edit(eventId: string, change: (m: any) => void): any {
    const m = this.meetings.get(eventId)
    if (!m) throw new Error(`no meeting ${eventId} in the feed`)
    change(m)
    this.clock += 60_000
    m.updateDate = new Date(this.clock).toISOString().replace('.000Z', 'Z')
    return m
  }

  /** A new meeting: a copy of a recorded one under another id, with changes. */
  add(eventId: string, from: string, change: (m: any) => void = () => {}): any {
    const m = structuredClone(this.meetings.get(from) ?? recordedDetails.get(from)?.committeeMeeting)
    if (!m) throw new Error(`no meeting ${from} to copy`)
    m.eventId = eventId
    change(m)
    this.clock += 60_000
    m.updateDate = new Date(this.clock).toISOString().replace('.000Z', 'Z')
    this.meetings.set(eventId, m)
    return m
  }

  remove(eventId: string): void {
    this.meetings.delete(eventId)
  }

  /** The requests made to the API, by kind. */
  get listRequests(): Requested[] { return this.requests.filter(r => /\/committee-meeting\/\d+\?/.test(r.url)) }
  get detailRequests(): Requested[] { return this.requests.filter(r => /\/committee-meeting\/\d+\/[a-z]+\/\d+\?/.test(r.url)) }

  /** The event ids whose detail was asked for, in order. */
  get detailIds(): string[] { return this.detailRequests.map(r => /\/(\d+)\?/.exec(r.url)![1]) }

  /** The address an answer lives at, which the list gives for each meeting. */
  private detailUrl(m: any): string {
    return `${CONGRESS_API}/committee-meeting/${m.congress}/${chamberPath(m.chamber)}/${m.eventId}?format=json`
  }

  private sorted(): any[] {
    return [...this.meetings.values()].sort((a, b) => b.updateDate.localeCompare(a.updateDate) || Number(b.eventId) - Number(a.eventId))
  }

  /** What the stubbed network answers: this API's, or null for any other address. */
  answer(url: string, init?: RequestInit): Response | null {
    if (!url.startsWith(CONGRESS_HOST)) return null
    const u = new URL(url)
    this.requests.push({ url, method: init?.method ?? 'GET', headers: plainHeaders(init), redirect: init?.redirect })
    if (plainHeaders(init)['x-api-key'] !== CONGRESS_KEY) {
      return json({ error: { code: 'API_KEY_MISSING', message: 'No api_key was supplied.' } }, 403)
    }
    const detail = /^\/v3\/committee-meeting\/(\d+)\/([a-z]+)\/(\d+)$/.exec(u.pathname)
    if (detail) {
      const forced = this.override.detail?.(detail[3])
      if (forced) return forced
      const m = this.meetings.get(detail[3])
      if (!m || String(m.congress) !== detail[1] || chamberPath(m.chamber) !== detail[2]) return json({ error: 'not found' }, 404)
      return json({
        committeeMeeting: m,
        request: { chamber: detail[2], congress: detail[1], contentType: 'application/json', eventId: detail[3], format: 'json' },
      })
    }
    const list = /^\/v3\/committee-meeting\/(\d+)$/.exec(u.pathname)
    if (list) {
      const offset = Number(u.searchParams.get('offset') ?? 0)
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 20), 250)
      const forced = this.override.list?.(offset)
      if (forced) return forced
      const all = this.sorted().filter(m => String(m.congress) === list[1])
      const page = all.slice(offset, offset + limit)
      const next = offset + limit < all.length
        ? `${CONGRESS_API}/committee-meeting/${list[1]}?offset=${offset + limit}&limit=${limit}&format=json`
        : undefined
      return json({
        committeeMeetings: page.map(m => ({ chamber: m.chamber, congress: m.congress, eventId: m.eventId, updateDate: m.updateDate, url: this.detailUrl(m) })),
        pagination: { count: all.length + this.countOffset, ...(next ? { next } : {}) },
        request: { congress: list[1], contentType: 'application/json', format: 'json' },
      })
    }
    return json({ error: 'not found' }, 404)
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}
