import { describe, it, expect } from 'vitest'
import { renderBillCardOpen, BILL_CARD_CLOSE, renderCommentRow, formatEmailDateTime } from '../../src/lib/emailBillCard'
import type { BillCardModel } from '../../../shared/billCardModel'
import { COMMENT_STYLE } from '../../../shared/commentStyle'

const model: BillCardModel = {
  billNumber: 'HB 1234', state: 'RI', sessionSlug: null,
  title: 'Voter ID Act', summary: 'Requires photo identification to vote.',
  priority: 'high', rows: [],
}

describe('formatEmailDateTime', () => {
  it('formats a space-format UTC timestamp as a long absolute date', () => {
    const out = formatEmailDateTime('2026-06-10 16:45:00')
    expect(out).toContain('June 10, 2026')
    expect(out).toContain('4:45')
  })
})

describe('renderBillCardOpen', () => {
  it('renders a clickable navy badge with STATE + number', () => {
    const html = renderBillCardOpen({ model, billHref: 'https://x.test/RI/2026/HB1234', appUrl: 'https://x.test' })
    expect(html).toContain('RI HB 1234')
    expect(html).toContain('href="https://x.test/RI/2026/HB1234"')
    expect(html).toContain('#1e3a5f') // billBadgeNavy
  })
  it('renders the priority chip when priority is set', () => {
    const html = renderBillCardOpen({ model, billHref: '#', appUrl: 'https://x.test' })
    expect(html).toContain('High priority')
  })
  it('omits the priority chip when priority is null', () => {
    const html = renderBillCardOpen({ model: { ...model, priority: null }, billHref: '#', appUrl: 'https://x.test' })
    expect(html).not.toContain('priority')
  })
  it('renders the serif title and summary', () => {
    const html = renderBillCardOpen({ model, billHref: '#', appUrl: 'https://x.test' })
    expect(html).toContain('Voter ID Act')
    expect(html).toContain('Requires photo identification to vote.')
    expect(html).toContain('Source Serif')
  })
})

describe('renderCommentRow', () => {
  const base = { appUrl: 'https://x.test', name: 'Sam Ortiz', subtitle: 'Town Clerk, Cranston', dateText: 'June 10, 2026, 4:45 PM', bodyHtml: '<p>hello</p>' }
  it('uses the shared purple chat icon PNG', () => {
    expect(renderCommentRow(base)).toContain('/email-icons/chat__7c3aed.png')
  })
  it('renders name, subtitle, date, and the body html', () => {
    const html = renderCommentRow(base)
    expect(html).toContain('Sam Ortiz')
    expect(html).toContain('Town Clerk, Cranston')
    expect(html).toContain('June 10, 2026, 4:45 PM')
    expect(html).toContain('<p>hello</p>')
  })
  it('omits the subtitle span when subtitle is null', () => {
    const html = renderCommentRow({ ...base, subtitle: null })
    expect(html).not.toContain('Town Clerk')
  })
  it('escapes the name but not the body html', () => {
    const html = renderCommentRow({ ...base, name: 'A & B', bodyHtml: '<p>keep <strong>me</strong></p>' })
    expect(html).toContain('A &amp; B')
    expect(html).toContain('<strong>me</strong>')
  })
  it('styles name/subtitle/date at the shared meta size and the body one tier up (no 16px inheritance)', () => {
    const html = renderCommentRow(base)
    // name + subtitle + date all carry the explicit COMMENT_STYLE meta size, and
    // the body carries bodySize — so neither the subtitle span nor the tiptap <p>
    // body inherits the email default (16px). Values come from the shared spec.
    const metaCount = (html.match(new RegExp(`font-size:${COMMENT_STYLE.nameSize}px`, 'g')) ?? []).length
    expect(metaCount).toBeGreaterThanOrEqual(3)
    expect(html).toContain(`font-size:${COMMENT_STYLE.bodySize}px`)
  })
  it('BILL_CARD_CLOSE closes the table', () => {
    expect(BILL_CARD_CLOSE).toContain('</tbody>')
    expect(BILL_CARD_CLOSE).toContain('</table>')
  })
})
