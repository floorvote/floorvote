import { rateLimitedFetch } from './rateLimitedFetch'

/**
 * The Council's committees and staff, from dccouncil.gov.
 *
 * LIMS has committees and Councilmembers but no membership, chairs, or staff.
 * dccouncil.gov publishes all three as static WordPress pages (its REST API
 * does not expose them): one page per committee with the chair, members, key
 * staff, and the agencies it oversees, and a paginated directory of every
 * staffer with title, office, email, and phone. These are public work contacts.
 *
 * The parsers read the page markup as it is today (see the fixtures in
 * test/fixtures/dccouncil/). If the Council redesigns the site, a page that no
 * longer parses yields nothing and the sync keeps the previous rows.
 */
const SITE = 'https://dccouncil.gov'
const RATE_PER_SEC = 1
const USER_AGENT = 'FloorVote DC legislative tracker (+https://github.com/floorvote/floorvote)'

export interface CouncilPersonRef { name: string; url: string | null }
export interface CommitteeStaff { name: string; title: string | null; email: string | null; phone: string | null; url: string | null }
export interface CouncilCommittee {
  slug: string
  name: string
  url: string
  chair: CouncilPersonRef | null
  members: CouncilPersonRef[]
  staff: CommitteeStaff[]
  agencies: string[]
}
export interface DirectoryEntry { kind: string; name: string; title: string | null; office: string | null; email: string | null; phone: string | null }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'", '#8217': '’', '#8211': '–', '#8220': '“', '#8221': '”' }

function decode(s: string): string {
  return s.replace(/&(#?\w+);/g, (m, e: string) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e]
    if (/^#\d+$/.test(e)) return String.fromCodePoint(parseInt(e.slice(1), 10))
    if (/^#x[0-9a-f]+$/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16))
    return m
  })
}

/** Tags stripped, entities decoded, whitespace collapsed. */
export function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function orNull(s: string | undefined | null): string | null {
  const t = (s ?? '').trim()
  return t ? t : null
}

/** Only the Council's own pages are kept as profile links. */
function councilUrl(s: string | undefined | null): string | null {
  const t = (s ?? '').trim()
  return /^https:\/\/(www\.)?dccouncil\.gov\/[^\s"'<>]*$/i.test(t) ? t : null
}

/** A plain address, so a scraped value cannot carry mailto: parameters. */
function emailOf(s: string | undefined | null): string | null {
  const t = decode((s ?? '').trim())
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(t) ? t : null
}

/** A phone number's digits and punctuation only. */
function phoneOf(s: string | undefined | null): string | null {
  const t = (s ?? '').trim()
  return /^[\d\s().+-]{7,25}$/.test(t) ? t : null
}

/** The page's content blocks keyed by their <h2> heading. */
function blocks(html: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = html.split(/<h2[^>]*>/i).slice(1)
  for (const part of parts) {
    const end = part.indexOf('</h2>')
    if (end < 0) continue
    out.set(textOf(part.slice(0, end)).toLowerCase(), part.slice(end + 5))
  }
  return out
}

function links(fragment: string): CouncilPersonRef[] {
  const out: CouncilPersonRef[] = []
  for (const m of fragment.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = textOf(m[2])
    if (name) out.push({ name, url: councilUrl(m[1]) })
  }
  return out
}

export function committeeSlug(url: string): string {
  return url.replace(/\/+$/, '').split('/').pop() ?? url
}

/** One committee page. Returns null when the page has no committee roster. */
export function parseCommitteePage(html: string, url: string): CouncilCommittee | null {
  const title = /<header class="article-header">[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)
  if (!title) return null
  const b = blocks(html)
  const roster = b.get('councilmembers')
  if (roster === undefined) return null
  const chairPart = /<h4[^>]*>\s*Chair(?:person|man|woman)?\s*<\/h4>([\s\S]*?)(?:<hr|<h4)/i.exec(roster)
  const membersPart = /<h4[^>]*>\s*Councilmembers\s*<\/h4>([\s\S]*?)<\/ul>/i.exec(roster)
  const staff: CommitteeStaff[] = []
  for (const m of (b.get('key staff') ?? '').matchAll(/<div class="tertiary-block">([\s\S]*?)<\/div>/gi)) {
    const block = m[1]
    const person = links(/<p>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? '')[0]
    if (!person) continue
    staff.push({
      name: person.name,
      url: person.url,
      title: orNull(textOf(/<p class="byline-label">([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? '')),
      email: emailOf(/href="mailto:([^"]+)"/i.exec(block)?.[1]),
      phone: phoneOf(textOf(/href="tel:[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? '')),
    })
  }
  const agencies = [...(b.get('agencies under this committee') ?? '').split(/<\/ul>/i)[0].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(m => textOf(m[1])).filter(Boolean)
  return {
    slug: committeeSlug(url),
    name: textOf(title[1]),
    url,
    chair: chairPart ? links(chairPart[1])[0] ?? null : null,
    members: membersPart ? links(membersPart[1]) : [],
    staff,
    agencies,
  }
}

/** One page of the Council directory, plus the highest page number it links to. */
export function parseDirectoryPage(html: string): { entries: DirectoryEntry[]; lastPage: number } {
  const entries: DirectoryEntry[] = []
  for (const m of html.matchAll(/<article class="listing-post[^"]*"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const card = m[1]
    const name = textOf(/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(card)?.[1] ?? '')
    if (!name) continue
    const byline = /<p class="byline">([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? ''
    const title = textOf(byline.split(/<br\s*\/?>/i)[0] ?? '')
    entries.push({
      kind: textOf(/<p class="h4 byline[^"]*">([\s\S]*?)<\/p>/i.exec(card)?.[1] ?? '').toLowerCase() || 'staff',
      name,
      title: orNull(/byline-label/.test(title) ? '' : title),
      office: orNull(textOf(/Office:<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i.exec(byline)?.[1] ?? '')),
      email: emailOf(/href="mailto:([^"]+)"/i.exec(byline)?.[1]),
      phone: phoneOf(textOf(/href="tel:[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(byline)?.[1] ?? '')),
    })
  }
  const pages = [...html.matchAll(/\/council-directory\/page\/(\d+)\//g)].map(m => parseInt(m[1], 10))
  return { entries, lastPage: Math.max(1, ...pages) }
}

export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => decode(m[1]))
}

/**
 * The current committees' page URLs, from the Council's committees index. The
 * sitemap also lists committees that no longer exist (the COVID-19 special
 * committee still has a roster page), so the index is the list of record.
 */
export function parseCommitteeIndex(html: string): string[] {
  const main = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html
  return [...new Set([...main.matchAll(/href="(https:\/\/dccouncil\.gov\/committees\/[a-z0-9-]+\/)"/gi)].map(m => m[1]))]
}

const REQUEST_TIMEOUT_MS = 20_000

async function get(url: string, onRequest?: () => void): Promise<string> {
  const res = await rateLimitedFetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xml' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, { ratePerSec: RATE_PER_SEC, onRequest })
  if (!res.ok) throw new Error(`dccouncil.gov HTTP ${res.status} for ${url}`)
  return res.text()
}

/**
 * Every current committee with a roster, and the slugs of every current
 * committee (whether or not its page loaded), so a page that fails once is
 * kept rather than dropped. Throws if the index fails.
 */
export async function fetchCommittees(onRequest?: () => void): Promise<{ committees: CouncilCommittee[]; currentSlugs: string[] }> {
  const urls = parseCommitteeIndex(await get(`${SITE}/committees/`, onRequest))
  const committees: CouncilCommittee[] = []
  for (const url of urls) {
    try {
      const c = parseCommitteePage(await get(url, onRequest), url)
      if (c && (c.chair || c.members.length > 0)) committees.push(c)
    } catch (err) {
      console.warn(`[dccouncil] committee page skipped: ${url}`, err)
    }
  }
  return { committees, currentSlugs: urls.map(committeeSlug) }
}

/** The whole Council directory. Throws if any page fails, so the sync keeps what it has. */
export async function fetchDirectory(onRequest?: () => void, maxPages = 30): Promise<DirectoryEntry[]> {
  const first = parseDirectoryPage(await get(`${SITE}/council-directory/`, onRequest))
  const out = [...first.entries]
  for (let p = 2; p <= Math.min(first.lastPage, maxPages); p++) {
    out.push(...parseDirectoryPage(await get(`${SITE}/council-directory/page/${p}/`, onRequest)).entries)
  }
  return out
}
