import { describe, it, expect } from 'vitest'
import { renderDigestEmail, digestSubject, digestCadence, type NewMatchDigestItem } from '../../src/lib/digestEmail'
import { color, radius } from '../../../shared/tokens'
import { billUrl } from '../../../shared/sessionSlug'

// #586: the digest previews both kinds of news (a subject line naming each kind
// and its count, a contents box when both are present) and lays new matches out
// as the same full cards updated bills get. Seams: the subject builder and the
// digest renderer.

const ev = (over: any = {}) => ({
  type: 'bill_updated',
  metadata: JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] }),
  createdAt: '2026-06-02T10:00:00Z', billId: 'b1', billNumber: 'H 5174', billTitle: 'Mail ballot processing',
  billState: 'RI', billSession: '2026', priority: 'high', userName: 'Will', summary: null, ...over,
})
// n distinct updated bills.
const updates = (n: number) => Array.from({ length: n }, (_, i) => ev({ billId: `u${i + 1}`, billNumber: `H ${6000 + i + 1}`, billTitle: `Updated bill ${i + 1}` }))

const match = (n: number, over: Partial<NewMatchDigestItem> = {}): NewMatchDigestItem => ({
  billId: `m${n}`, billNumber: `HB ${1000 + n}`, billTitle: `Matched bill ${n}`,
  billState: 'RI', billSession: '2026', relevanceScore: n, summary: null, ...over,
})
// n matches, relevance ascending with n.
const matches = (n: number) => Array.from({ length: n }, (_, i) => match(i + 1))

const DAY = { periodStart: '2026-06-09T11:00:00Z', periodEnd: '2026-06-10T11:00:00Z' }
const WEEK = { periodStart: '2026-06-03T11:00:00Z', periodEnd: '2026-06-10T11:00:00Z' }

const render = (input: { events?: any[]; newMatches?: NewMatchDigestItem[]; forMember?: boolean; periodStart?: string; periodEnd?: string }) =>
  renderDigestEmail({ events: [], assocName: 'X', appUrl: 'https://x', ...DAY, ...input })

// The headline sentence the shell renders under the wordmark.
const headline = (html: string) => html.match(/line-height:1\.35;">([^<]*)</)![1]
const cardCount = (html: string) => (html.match(/box-shadow:/g) || []).length

describe('digestCadence: the cadence the digest already words its period by', () => {
  it('a one-day window is daily', () => {
    expect(digestCadence('2026-06-09T11:00:00Z', '2026-06-10T11:00:00Z')).toBe('daily')
  })
  it('a seven-day window is weekly', () => {
    expect(digestCadence('2026-06-03T11:00:00Z', '2026-06-10T11:00:00Z')).toBe('weekly')
  })
  it('reads the database timestamp format as UTC', () => {
    expect(digestCadence('2026-06-09 11:00:00', '2026-06-10 11:00:00')).toBe('daily')
    expect(digestCadence('2026-06-03 11:00:00', '2026-06-10 11:00:00')).toBe('weekly')
  })
  it('a window that is neither (a digest that skipped runs) has no cadence', () => {
    expect(digestCadence('2026-06-07T11:00:00Z', '2026-06-10T11:00:00Z')).toBeNull()
    expect(digestCadence('2026-05-27T11:00:00Z', '2026-06-10T11:00:00Z')).toBeNull()
  })
})

describe('digestSubject', () => {
  it('daily, both kinds, plural', () => {
    expect(digestSubject({ updatedBills: 2, newMatches: 3, cadence: 'daily' })).toBe('Your daily digest: 2 updated bills, 3 new matches')
  })
  it('weekly, both kinds, plural', () => {
    expect(digestSubject({ updatedBills: 2, newMatches: 3, cadence: 'weekly' })).toBe('Your weekly digest: 2 updated bills, 3 new matches')
  })
  it('singular for each kind, daily and weekly', () => {
    expect(digestSubject({ updatedBills: 1, newMatches: 1, cadence: 'daily' })).toBe('Your daily digest: 1 updated bill, 1 new match')
    expect(digestSubject({ updatedBills: 1, newMatches: 1, cadence: 'weekly' })).toBe('Your weekly digest: 1 updated bill, 1 new match')
  })
  it('pluralizes each count on its own', () => {
    expect(digestSubject({ updatedBills: 1, newMatches: 4, cadence: 'daily' })).toBe('Your daily digest: 1 updated bill, 4 new matches')
    expect(digestSubject({ updatedBills: 5, newMatches: 1, cadence: 'daily' })).toBe('Your daily digest: 5 updated bills, 1 new match')
  })
  it('updates only names only updates, daily and weekly, singular and plural', () => {
    expect(digestSubject({ updatedBills: 2, newMatches: 0, cadence: 'daily' })).toBe('Your daily digest: 2 updated bills')
    expect(digestSubject({ updatedBills: 1, newMatches: 0, cadence: 'daily' })).toBe('Your daily digest: 1 updated bill')
    expect(digestSubject({ updatedBills: 2, newMatches: 0, cadence: 'weekly' })).toBe('Your weekly digest: 2 updated bills')
    expect(digestSubject({ updatedBills: 1, newMatches: 0, cadence: 'weekly' })).toBe('Your weekly digest: 1 updated bill')
  })
  it('matches only names only matches, daily and weekly, singular and plural', () => {
    expect(digestSubject({ updatedBills: 0, newMatches: 3, cadence: 'weekly' })).toBe('Your weekly digest: 3 new matches')
    expect(digestSubject({ updatedBills: 0, newMatches: 1, cadence: 'weekly' })).toBe('Your weekly digest: 1 new match')
    expect(digestSubject({ updatedBills: 0, newMatches: 3, cadence: 'daily' })).toBe('Your daily digest: 3 new matches')
    expect(digestSubject({ updatedBills: 0, newMatches: 1, cadence: 'daily' })).toBe('Your daily digest: 1 new match')
  })
  it('with no cadence (a window that is neither a day nor a week), drops the cadence word', () => {
    expect(digestSubject({ updatedBills: 2, newMatches: 3, cadence: null })).toBe('Your digest: 2 updated bills, 3 new matches')
  })
  it('never says "keyword"', () => {
    for (const [u, m] of [[2, 3], [0, 3], [2, 0]]) {
      expect(digestSubject({ updatedBills: u, newMatches: m, cadence: 'daily' })).not.toMatch(/keyword/i)
    }
  })
})

describe('renderDigestEmail: the top of the email', () => {
  describe('both kinds present', () => {
    it('daily: headline "Your digest for the last day", with the date range under it', () => {
      const html = render({ events: updates(2), newMatches: matches(3) })
      expect(headline(html)).toBe('Your digest for the last day')
      expect(html).toContain('class="email-date"')
      expect(html).toContain('Jun 9 – Jun 10')
    })
    it('weekly: headline "Your digest for the last week"', () => {
      const html = render({ events: updates(2), newMatches: matches(3), ...WEEK })
      expect(headline(html)).toBe('Your digest for the last week')
      expect(html).toContain('Jun 3 – Jun 10')
    })
    it('a digest that skipped runs says how many days it really spans', () => {
      const html = render({ events: updates(2), newMatches: matches(3), periodStart: '2026-06-07T11:00:00Z', periodEnd: '2026-06-10T11:00:00Z' })
      expect(headline(html)).toBe('Your digest for the last 3 days')
    })
    it('shows an "In this digest" box with one row per kind and its count', () => {
      const html = render({ events: updates(2), newMatches: matches(3) })
      expect(html).toContain('In this digest')
      expect(html).toContain('2 priority bills updated')
      expect(html).toContain('3 new matches')
    })
    it('singular counts in the contents box', () => {
      const html = render({ events: updates(1), newMatches: matches(1) })
      expect(html).toContain('1 priority bill updated')
      expect(html).toContain('1 new match<')
    })
    it('counts bills, not events, for the updates row', () => {
      const html = render({ events: [ev(), ev({ type: 'position_set', metadata: JSON.stringify({ position: 'Support' }) }), ...updates(2).slice(1)], newMatches: matches(3) })
      expect(html).toContain('2 priority bills updated')
    })
    it('counts every new match in the box, not just the ten the section lists', () => {
      const html = render({ events: updates(2), newMatches: matches(37) })
      expect(html).toContain('37 new matches')
    })
    it('each box row links to its section by anchor', () => {
      const html = render({ events: updates(2), newMatches: matches(3) })
      expect(html).toMatch(/<a href="#digest-updates"[^>]*>[^<]*2 priority bills updated/)
      expect(html).toMatch(/<a href="#digest-new-matches"[^>]*>[^<]*3 new matches/)
    })
    it('every anchor in the email matches a section id, and each id is unique', () => {
      const html = render({ events: updates(2), newMatches: matches(3) })
      const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map(m => m[1])
      expect(hrefs.sort()).toEqual(['digest-new-matches', 'digest-updates'])
      for (const h of hrefs) expect(html.match(new RegExp(`id="${h}"`, 'g'))).toHaveLength(1)
    })
    it('the box reads as a plain summary: its text stands without the links', () => {
      const html = render({ events: updates(2), newMatches: matches(3) })
      const box = html.slice(html.indexOf('In this digest'), html.lastIndexOf('<table', html.indexOf('id="digest-updates"')))
      const text = box.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      expect(text).toBe('In this digest 2 priority bills updated 3 new matches')
    })
    it('puts the contents box above both sections, updates before new matches', () => {
      const html = render({ events: updates(2), newMatches: matches(3) })
      const box = html.indexOf('In this digest')
      const upd = html.indexOf('id="digest-updates"')
      const nm = html.indexOf('id="digest-new-matches"')
      expect(box).toBeGreaterThan(-1)
      expect(box).toBeLessThan(upd)
      expect(upd).toBeLessThan(nm)
    })
  })

  describe('only updates', () => {
    it('keeps the headline as before, with no contents box and no anchors', () => {
      const html = render({ events: updates(2) })
      expect(headline(html)).toBe('2 priority bills were updated in the last day')
      expect(html).not.toContain('In this digest')
      expect(html).not.toContain('href="#')
    })
    it('weekly and singular wording', () => {
      expect(headline(render({ events: updates(1), ...WEEK }))).toBe('1 priority bill was updated in the last week')
    })
    it('an empty matches list is the same as none', () => {
      const html = render({ events: updates(2), newMatches: [] })
      expect(html).not.toContain('In this digest')
      expect(html).not.toContain('digest-new-matches')
    })
  })

  describe('only new matches', () => {
    it('headline "3 new matches in the last day", no contents box', () => {
      const html = render({ newMatches: matches(3) })
      expect(headline(html)).toBe('3 new matches in the last day')
      expect(html).not.toContain('In this digest')
      expect(html).not.toContain('href="#')
    })
    it('weekly: "in the last week"', () => {
      expect(headline(render({ newMatches: matches(3), ...WEEK }))).toBe('3 new matches in the last week')
    })
    it('singular: "1 new match in the last day"', () => {
      expect(headline(render({ newMatches: matches(1) }))).toBe('1 new match in the last day')
    })
    it('counts every match, not just the ten listed', () => {
      expect(headline(render({ newMatches: matches(37) }))).toBe('37 new matches in the last day')
    })
  })
})

describe('renderDigestEmail: section headers', () => {
  it('updates: "2 priority bills were updated" under a 2px navy top rule', () => {
    const html = render({ events: updates(2), newMatches: matches(3) })
    expect(html).toMatch(new RegExp(`id="digest-updates"[^>]*border-top:2px solid ${color.billBadgeNavy}`))
    const section = html.slice(html.indexOf('id="digest-updates"'), html.indexOf('id="digest-new-matches"'))
    expect(section).toContain('2 priority bills were updated')
  })
  it('new matches: "3 new matches" under a 2px Honey top rule', () => {
    const html = render({ events: updates(2), newMatches: matches(3) })
    expect(html).toMatch(new RegExp(`id="digest-new-matches"[^>]*border-top:2px solid ${color.accentAmber}`))
    const section = html.slice(html.indexOf('id="digest-new-matches"'))
    expect(section).toMatch(/>\s*3 new matches\s*</)
  })
  it('the rules are the brand colors, navy #1e3a5f and Honey #e8a33d', () => {
    expect(color.billBadgeNavy).toBe('#1e3a5f')
    expect(color.accentAmber).toBe('#e8a33d')
    const html = render({ events: updates(2), newMatches: matches(3) })
    expect(html).toContain('border-top:2px solid #1e3a5f')
    expect(html).toContain('border-top:2px solid #e8a33d')
  })
  it('never uses the legacy amber #f59e0b', () => {
    expect(render({ events: updates(2), newMatches: matches(3) }).toLowerCase()).not.toContain('#f59e0b')
  })
  it('singular headers', () => {
    const html = render({ events: updates(1), newMatches: matches(1) })
    expect(html).toContain('1 priority bill was updated')
    expect(html).toMatch(/>\s*1 new match\s*</)
  })
  it('a one-kind email still opens its section with the header and rule', () => {
    const upd = render({ events: updates(2) })
    expect(upd).toMatch(/id="digest-updates"[^>]*border-top:2px solid #1e3a5f/)
    const nm = render({ newMatches: matches(3) })
    expect(nm).toMatch(/id="digest-new-matches"[^>]*border-top:2px solid #e8a33d/)
    expect(nm).not.toContain('id="digest-updates"')
    expect(upd).not.toContain('id="digest-new-matches"')
  })
  it('has no eyebrow labels', () => {
    const html = render({ events: updates(2), newMatches: matches(3) })
    expect(html).not.toMatch(/>\s*UPDATED\s*</)
    expect(html).not.toMatch(/>\s*NEW MATCHES\s*</)
    expect(html).not.toMatch(/>\s*(Updated|New matches)\s*</i)
    expect(html).not.toContain('text-transform')
  })
  it('drops the old "New matches (N)" header and the "…and N more" line', () => {
    const html = render({ events: updates(2), newMatches: matches(12) })
    expect(html).not.toContain('New matches (')
    expect(html).not.toContain('…and')
  })
})

describe('renderDigestEmail: new matches as full cards', () => {
  it('renders each new match as a shared bill card: badge, serif title, shadow', () => {
    const html = render({ newMatches: [match(1)] })
    expect(cardCount(html)).toBe(1)
    expect(html).toContain('RI HB 1001')
    expect(html).toContain('Matched bill 1')
    expect(html).toContain('Source Serif 4')
  })
  it('links the badge and title to the canonical bill URL', () => {
    const html = render({ newMatches: [match(1)] })
    const href = `https://x${billUrl({ id: 'm1', state: 'RI', session: '2026', sessionSlug: null, billNumber: 'HB 1001' })}`
    expect(html.split(`href="${href}"`).length - 1).toBeGreaterThanOrEqual(2)  // badge and title
  })
  it('shows the summary preview on a match that has one', () => {
    const html = render({ newMatches: [match(1, { summary: 'Lets counties start mail ballot processing a week early.' })] })
    expect(html).toContain('Lets counties start mail ballot processing a week early.')
  })
  it('strips markdown from the summary like an updated bill card does', () => {
    const html = render({ newMatches: [match(1, { summary: '**Early processing** of mail ballots.' })] })
    expect(html).toContain('Early processing of mail ballots.')
    expect(html).not.toContain('**')
  })
  it('escapes the summary and the title', () => {
    const html = render({ newMatches: [match(1, { summary: 'Fees & "rules" for drop boxes', billTitle: 'Rules <script>x</script>' })] })
    expect(html).toContain('Fees &amp; &quot;rules&quot; for drop boxes')
    expect(html).toContain('Rules &lt;script&gt;x&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })
  it('a match with no summary yet gets no preview row', () => {
    const none = render({ newMatches: [match(1, { summary: null })] })
    const missing = render({ newMatches: [match(1, { summary: undefined })] })
    const empty = render({ newMatches: [match(1, { summary: '' })] })
    for (const html of [none, missing, empty]) expect(html).not.toContain('padding:0 14px 10px 14px')
    expect(render({ newMatches: [match(1, { summary: 'Has one.' })] })).toContain('padding:0 14px 10px 14px')
  })
  it('with two matches, only the one with a summary gets a preview', () => {
    const html = render({ newMatches: [match(1, { summary: 'First summary.' }), match(2)] })
    expect(html.match(/padding:0 14px 10px 14px/g) ?? []).toHaveLength(1)
    expect(html).toContain('First summary.')
  })
  it('puts the amber pill in the top-right, where an updated bill shows its priority chip: "New · Set priority" for an admin, "New match" for a member', () => {
    for (const [forMember, label] of [[false, 'New · Set priority'], [true, 'New match']] as const) {
      const html = render({ newMatches: [match(1)], forMember })
      expect(html.indexOf(`>${label}<`)).toBeGreaterThan(html.indexOf('RI HB 1001'))
    }
    const html = render({ newMatches: [match(1)] })
    const chipAt = html.indexOf('>New · Set priority<')
    expect(chipAt).toBeGreaterThan(-1)
    // The chip sits in the right-aligned cell, after the badge cell.
    const rightCell = html.lastIndexOf('<td align="right"', chipAt)
    expect(rightCell).toBeGreaterThan(html.indexOf('RI HB 1001') - 400)
    expect(rightCell).toBeGreaterThan(-1)
    expect(html.indexOf('RI HB 1001')).toBeLessThan(chipAt)
  })
  it('styles the pill like the app: #fef3c7 fill, #92400e text, #fde68a border, with the priority chip\'s padding and radius', () => {
    expect(color.bgAmberPriority).toBe('#fef3c7')
    expect(color.textAmberDark).toBe('#92400e')
    expect(color.borderAmber).toBe('#fde68a')
    const html = render({ newMatches: [match(1)] })
    expect(html).toMatch(new RegExp(`<span style="[^"]*background:#fef3c7;color:#92400e;border:1px solid #fde68a;[^"]*padding:3px 10px;border-radius:${radius.sm}px;[^"]*">New · Set priority</span>`))
    // Same padding/radius as the priority chip on an updated bill.
    const priority = render({ events: [ev({ priority: 'high' })] })
    const chipStyle = (h: string, label: string) => h.match(new RegExp(`<span style="([^"]*)">${label}</span>`))![1]
    const pad = (s: string) => s.match(/padding:[^;]+;border-radius:[^;]+;/)![0]
    expect(pad(chipStyle(html, 'New · Set priority'))).toBe(pad(chipStyle(priority, 'High priority')))
  })
  it('every card carries one chip; an updated bill\'s card has none', () => {
    const html = render({ events: updates(2), newMatches: matches(3) })
    expect(html.match(/>New · Set priority</g) ?? []).toHaveLength(3)
    expect(render({ events: updates(2) })).not.toContain('New · Set priority<')
    expect(render({ events: updates(2) })).not.toContain('New match<')
  })
  it('a new match shows no priority chip', () => {
    const html = render({ newMatches: matches(2) })
    for (const label of ['High priority', 'Medium priority', 'Low priority']) expect(html).not.toContain(label)
  })
  it('a new match card has no activity rows', () => {
    const html = render({ newMatches: [match(1)] })
    expect(html).not.toMatch(/email-icons\/(?!wordmark)/)
  })
  it('lists matches most relevant first, unscored last', () => {
    const html = render({ newMatches: [match(1, { relevanceScore: null }), match(2, { relevanceScore: 3 }), match(3, { relevanceScore: 8 })] })
    const order = [...html.matchAll(/RI HB (\d{4})</g)].map(m => Number(m[1]) - 1000)
    expect(order).toEqual([3, 2, 1])
  })
  it('updated bills are untouched: still one card per bill, priority chip, change rows', () => {
    const html = render({ events: [ev(), ev({ type: 'position_set', metadata: JSON.stringify({ position: 'Support' }) })] })
    expect(cardCount(html)).toBe(1)
    expect(html).toContain('High priority')
    expect(html).toContain('Status:')
  })
})

describe('renderDigestEmail: the ten-card cap', () => {
  const see = (n: number) => `See all ${n} new matches`
  it('exactly 10: all ten cards, no "See all" link', () => {
    const html = render({ newMatches: matches(10) })
    expect(cardCount(html)).toBe(10)
    expect(html).not.toContain('See all')
    expect(html).toMatch(/>\s*10 new matches\s*</)
  })
  it('exactly 11: ten cards, the least relevant cut, and a "See all 11 new matches" link', () => {
    const html = render({ newMatches: matches(11) })
    expect(cardCount(html)).toBe(10)
    expect(html).toContain('Matched bill 11')
    expect(html).toContain('Matched bill 2')
    expect(html).not.toContain('Matched bill 1<')
    expect(html).toMatch(/>\s*11 new matches\s*</)
    expect(html).toContain(see(11))
    expect(html).toMatch(new RegExp(`href="https://x/bills\\?newMatches=1"[^>]*>[^<]*${see(11)}`))
  })
  it('the link follows the last card', () => {
    const html = render({ newMatches: matches(11) })
    expect(html.indexOf(see(11))).toBeGreaterThan(html.lastIndexOf('RI HB 1002'))
  })
  it('37: the count is every match, the link names it too', () => {
    const html = render({ events: updates(2), newMatches: matches(37) })
    expect(cardCount(html)).toBe(10 + 2)
    expect(html).toContain(see(37))
    expect(html).toMatch(/>\s*37 new matches\s*</)
  })
  it('under ten: no link', () => {
    expect(render({ newMatches: matches(9) })).not.toContain('See all')
  })
})

describe('renderDigestEmail: new-matches subtitle, admin and member', () => {
  it('an admin or owner keeps "Set a priority or dismiss each from the bill list."', () => {
    const html = render({ events: updates(2), newMatches: matches(3) })
    expect(html).toContain('Set a priority or dismiss each from the bill list.')
    const nm = html.indexOf('id="digest-new-matches"')
    expect(html.indexOf('Set a priority or dismiss')).toBeGreaterThan(nm)
    expect(html.indexOf('Set a priority or dismiss')).toBeLessThan(html.indexOf('Matched bill 3'))
  })
  it('a member, who can\'t triage, is not told to set a priority or dismiss', () => {
    const html = render({ events: updates(2), newMatches: matches(3), forMember: true })
    expect(html).not.toContain('Set a priority')
    expect(html).not.toMatch(/dismiss/i)
    expect(html).toMatch(/>\s*3 new matches\s*</)
  })
  it('the admin and member digests differ only by that subtitle and the cards\' pill, a link for an admin and a label for a member', () => {
    const strip = (h: string) => h
      .replace(/<tr><td[^>]*>Set a priority or dismiss each from the bill list\.<\/td><\/tr>/, '')
      .replace(/<a [^>]*>(<span [^>]*>)New · Set priority(<\/span>)<\/a>/g, '$1New match$2')
    const admin = render({ newMatches: matches(3) })
    const member = render({ newMatches: matches(3), forMember: true })
    expect(admin).not.toEqual(member)
    expect(strip(admin).replace(/\s+/g, '')).toEqual(member.replace(/\s+/g, ''))
  })
})

describe('renderDigestEmail: never mentions keywords', () => {
  const cases: Record<string, Parameters<typeof render>[0]> = {
    'both kinds, admin': { events: updates(2), newMatches: matches(3) },
    'both kinds, member': { events: updates(2), newMatches: matches(3), forMember: true },
    'both kinds, weekly': { events: updates(2), newMatches: matches(3), ...WEEK },
    'new matches only, admin': { newMatches: matches(3) },
    'new matches only, member': { newMatches: matches(3), forMember: true },
    'one new match only': { newMatches: matches(1) },
    'over the cap': { newMatches: matches(11) },
    'updates only': { events: updates(2) },
  }
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => {
      expect(render(input)).not.toMatch(/keyword/i)
    })
  }
})
