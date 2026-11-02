/**
 * The summary row of the shared email bill card (#992): digest, mention, and
 * reply emails all render their summary through renderBillCardOpen, abridged.
 * Fixture text is invented.
 */
import { describe, it, expect } from 'vitest'
import { renderBillCardOpen } from '../../src/lib/emailBillCard'
import { renderMentionEmail, type MentionEmailInput } from '../../src/lib/mentions'
import { renderReplyEmail } from '../../src/lib/replies'
import { renderDigestEmail } from '../../src/lib/digestEmail'
import { buildBillCardModel, type BillCardModel } from '../../../shared/billCardModel'

const filler = (n: number) => Array(n).fill('word').join(' ')
const LONG = `Revises the permit renewal process.\n- **Fees**: ${filler(30)}\n- **Forms**: ${filler(30)}\n- **Dates**: ${filler(30)}`
const SHORT = 'Revises the permit renewal process.\n- **Fees**: Lowers a fee.\n- **Forms**: Adds a form.'
const LINK = 'Full summary on FloorVote →'
const tagNames = (html: string) => [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map(m => m[1].toLowerCase())
const BILL_HREF = 'https://x.test/RI/2026/HB%201234'

const model = (summary: string | null): BillCardModel => ({
  billNumber: 'HB 1234', state: 'RI', sessionSlug: null, title: 'Permit Renewal Act', summary, priority: 'high', rows: [],
})
const open = (summary: string | null) => renderBillCardOpen({ model: model(summary), billHref: BILL_HREF, appUrl: 'https://x.test' })

describe('renderBillCardOpen: the abridged summary', () => {
  it('shows a short summary as a list, whole, with no ellipsis and no summary link', () => {
    const html = open(SHORT)
    expect(html).toContain('<ul style=')
    expect(html.match(/<li style=/g)).toHaveLength(2)
    expect(html).toContain('<strong style=')
    expect(html).not.toContain('…')
    expect(html).not.toContain(LINK)
  })

  it('cuts a long summary, ends the last item in an ellipsis, and links to the bill', () => {
    const html = open(LONG)
    expect(html).toContain('<ul style=')
    expect(html).toContain('…</li>')
    expect(html).not.toContain('Dates')
    expect(html).toContain(`<a href="${BILL_HREF}" style="`)
    expect(html).toContain(LINK)
  })

  it('keeps the card chrome and the summary typography', () => {
    const html = open(LONG)
    expect(html).toContain('Permit Renewal Act')
    expect(html).toContain('Source Serif')
    expect(html).toContain('RI HB 1234')
  })

  it('renders no summary row for a null or empty summary, and tightens the title spacing', () => {
    for (const s of [null, '', '   ']) {
      const html = open(s)
      expect(html).not.toContain('<ul')
      expect(html).not.toContain('<p style=')
      expect(html).not.toContain(LINK)
      expect(html).not.toContain('padding:0 14px 10px 14px')
      expect(html).toContain('padding:2px 14px 10px 14px')
    }
  })

  it('escapes script tags, anchors, ampersands, and quotes in the summary', () => {
    const html = open('Run <script>alert(1)</script> or <a href="https://evil.test">click</a> & "quote"\n- <img src=x onerror=1> item')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.test">')
    expect(html).toContain('&amp; &quot;quote&quot;')
  })

  it('adds no tag to a hostile summary beyond the card chrome and the allowed set', () => {
    const baseline = new Set(tagNames(open(null)))
    const names = tagNames(open(`<script>x</script>\n- <b>y</b>\n  - **<i>z</i>**\n${filler(80)}`))
    const allowed = new Set([...baseline, 'p', 'ul', 'ol', 'li', 'strong', 'em', 'a'])
    for (const n of names) expect(allowed.has(n)).toBe(true)
  })

  it('normalizes an HTML-form summary into a list rather than printing tags', () => {
    const html = open('<p>Lead.</p><ul><li>One</li><li>Two</li></ul>')
    expect(html.match(/<li style=/g)).toHaveLength(2)
    expect(html).not.toContain('&lt;ul')
  })
})

describe('the card model carries the summary raw', () => {
  const group = (billSummary: string | null) => buildBillCardModel({
    key: 'b1', billId: 'b1', billNumber: 'H 5217', billTitle: 'Test bill',
    billSessionSlug: null, billState: 'RI', billSummary,
    billPriority: null, billMatchType: null, date: '', events: [],
  })
  it('keeps the markdown', () => {
    expect(group('Lead.\n- **A**: one.\n- two.').summary).toBe('Lead.\n- **A**: one.\n- two.')
  })
  it('is null with no summary', () => {
    expect(group(null).summary).toBeNull()
  })
})

describe('mention, reply, and digest emails render through the abridged path', () => {
  const mention: MentionEmailInput = {
    appUrl: 'https://x.test', instanceName: 'Example Association',
    author: { name: 'Sam Ortiz', title: null },
    bill: { id: 'b1', billNumber: 'HB 1234', title: 'Permit Renewal Act', state: 'RI', session: '2026 Regular Session', priority: 'high', tenantSummary: LONG },
    comment: { id: 'c9', createdAt: '2026-06-10 16:45:00', html: '<p>Hello</p>' },
    via: 'user',
  }

  it('the mention email shows a cut list and the full-summary link to the bill', () => {
    const html = renderMentionEmail(mention)
    expect(html).toContain('<ul style=')
    expect(html).toContain('…</li>')
    expect(html).toContain(LINK)
    expect(html).not.toContain('Dates')
  })

  it('the mention email shows a short summary whole with no link', () => {
    const html = renderMentionEmail({ ...mention, bill: { ...mention.bill, tenantSummary: SHORT } })
    expect(html.match(/<li style=/g)!.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain(LINK)
  })

  it('the reply email shows a cut list and the link', () => {
    const html = renderReplyEmail({
      appUrl: 'https://x.test', author: { name: 'Sam Ortiz', title: null }, bill: mention.bill,
      comment: mention.comment, instanceName: 'Example Association', muteUrl: 'https://x.test/mute',
    })
    expect(html).toContain('<ul style=')
    expect(html).toContain(LINK)
  })

  it('a digest updated-bill card shows a cut list and the link', () => {
    const html = renderDigestEmail({
      events: [{
        type: 'bill_updated',
        metadata: JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] }),
        createdAt: '2026-06-02T10:00:00Z', billId: 'b1', billNumber: 'H 5174', billTitle: 'Mail ballot processing',
        billState: 'RI', billSession: '2026', priority: 'high', userName: 'Will', summary: LONG,
      }] as any,
      assocName: 'Example', appUrl: 'https://x.test',
    })
    expect(html).toContain('<ul style=')
    expect(html).toContain('…</li>')
    expect(html).toContain(LINK)
  })

  it('a digest new-match card shows a short summary as a list with no link', () => {
    const html = renderDigestEmail({
      events: [], assocName: 'Example', appUrl: 'https://x.test',
      newMatches: [{ billId: 'm1', billNumber: 'HB 1001', billTitle: 'Matched bill', billState: 'RI', billSession: '2026', billSessionSlug: '2026', relevanceScore: 1, summary: SHORT }],
    })
    expect(html.match(/<li style=/g)).toHaveLength(2)
    expect(html).not.toContain(LINK)
  })

  it('a digest new-match card with a long summary links to that bill', () => {
    const html = renderDigestEmail({
      events: [], assocName: 'Example', appUrl: 'https://x.test',
      newMatches: [{ billId: 'm1', billNumber: 'HB 1001', billTitle: 'Matched bill', billState: 'RI', billSession: '2026', billSessionSlug: '2026', relevanceScore: 1, summary: LONG }],
    })
    expect(html).toContain(LINK)
    const href = html.match(/<a href="([^"]*)"[^>]*>Full summary on FloorVote →/)?.[1]
    expect(href).toMatch(/^https:\/\/x\.test\//)
  })
})
