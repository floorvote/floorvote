import { describe, it, expect } from 'vitest'
import { renderDigestEmail } from '../../src/lib/digestEmail'
import { renderSampleEmail } from '../../src/lib/sampleEmails'
import { PRIORITY_COLORS } from '../../../web/src/lib/chipStyles'
import { buildBillCardModel } from '../../../web/src/lib/billCardModel'
import { COMMENT_PREVIEW_MAX } from '../../../web/src/lib/feedUtils'
import type { GroupedBillEvents, FeedEvent } from '../../../web/src/lib/feedUtils'
import { SAMPLE_DIGEST_EVENTS, SAMPLE_NEW_MATCHES, SAMPLE_ASSOC_NAME } from '../../src/lib/sampleEmails'

const ev = (over: any = {}) => ({
  type: 'bill_updated',
  metadata: JSON.stringify({ changes: [{ changeType: 'status_change', oldValue: 'Introduced', newValue: 'Engrossed', detail: null }] }),
  createdAt: '2026-06-02T10:00:00Z', billId: 'b1', billNumber: 'H 5174', billTitle: 'Mail ballot processing',
  billState: 'RI', billSession: '2026', priority: 'high', userName: 'Will', summary: null, ...over,
})

describe('renderDigestEmail', () => {
  it('renders the wordmark, bill number, and change label', () => {
    const html = renderDigestEmail({ events: [ev()], assocName: 'RI Clerks', appUrl: 'https://staging.example.com' })
    expect(html).toContain('/email-icons/wordmark.png')  // wordmark lockup image (was live-text spans)
    expect(html).toContain('alt="FloorVote"')
    expect(html).toContain('H 5174')
    expect(html).toContain('Status:')                  // formatBillUpdateDetail output
    expect(html).toContain('Manage email settings')
    expect(html).toContain('https://staging.example.com/profile')
  })
  it('uses real PRIORITY_COLORS (drift guard)', () => {
    const html = renderDigestEmail({ events: [ev({ priority: 'high' })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain(PRIORITY_COLORS.high.fill)
  })
  it('renders a position_set row as text ("Position set to Support by Will") — no chip', () => {
    const html = renderDigestEmail({ events: [ev({ type: 'position_set', metadata: JSON.stringify({ position: 'Support' }) })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Position set to Support by Will')
    // no position chip — the shared model renders plain text via userDetailLine
    // POSITION_COLORS.Support.bg is #dcfce7 (green chip background); it must not appear in rows
    expect(html).not.toContain('#dcfce7')
  })
  it('renders a hearing line for hearing events', () => {
    const html = renderDigestEmail({ events: [ev({ type: 'hearing_added', metadata: JSON.stringify({ date: '2026-06-10', time: '14:00', location: 'Room 35', description: 'Cmte on Elections' }) })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Cmte on Elections')
    expect(html).toContain('2026-06-10')
  })
  it('groups multiple events under one bill card (one card)', () => {
    const html = renderDigestEmail({ events: [ev(), ev({ type: 'position_set', metadata: JSON.stringify({ position: 'Support' }) })], assocName: 'X', appUrl: 'https://x' })
    // One card == one card-table, which carries exactly one box-shadow.
    expect((html.match(/box-shadow:/g) || []).length).toBe(1)
  })
  it('renders the association name (escaped) in the header', () => {
    const html = renderDigestEmail({ events: [ev()], assocName: 'Smith & Co <Clerks>', appUrl: 'https://x' })
    expect(html).toContain('Smith &amp; Co &lt;Clerks&gt;')
    expect(html).not.toContain('Smith & Co <Clerks>')   // raw unescaped must not appear
  })
  it('puts the state inside the bill chip, with no session label', () => {
    const html = renderDigestEmail({ events: [ev()], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('RI H 5174')   // state inside the navy chip
    expect(html).not.toContain('· 2026')  // old session label format must be gone
  })
  it('renders a leading row-icon image for change rows (mirrors Pulse feed icons)', () => {
    const html = renderDigestEmail({
      events: [ev({ type: 'bill_updated', metadata: JSON.stringify({ changes: [{ changeType: 'action_added', oldValue: null, newValue: 'Referred', detail: null }] }) })],
      assocName: 'X', appUrl: 'https://x',
    })
    expect(html).toContain('/email-icons/arrow_forward__')  // action_added → arrow_forward glyph
  })
  it('renders a priority_set row as the priority square box, not an icon image', () => {
    const html = renderDigestEmail({ events: [ev({ type: 'priority_set', metadata: JSON.stringify({ priority: 'high' }) })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Marked high priority by Will')
    expect(html).toContain('width:11px;height:11px;border-radius:')  // the priority square box
    expect(html).toContain('title="High priority"')                  // native hover tooltip
  })
  it('ends a cut comment row with an ellipsis (legacy previews, stored hard-cut at the cap)', () => {
    // Made-up comment, cut mid-word the way the old write site cut real ones.
    const cut = 'The county offices will need extra staffing before this takes effect, and the training schedule is the real constraint o'
    expect(cut.length).toBe(COMMENT_PREVIEW_MAX)   // exactly what the old write site stored
    const html = renderDigestEmail({ events: [ev({ type: 'comment_added', metadata: JSON.stringify({ preview: cut }) })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain(`Will: &quot;${cut}…&quot;`)
  })
  it('leaves a short comment row unmarked', () => {
    const html = renderDigestEmail({ events: [ev({ type: 'comment_added', metadata: JSON.stringify({ preview: 'Short note.' }) })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Will: &quot;Short note.&quot;')
    expect(html).not.toContain('…')
  })
  it('does not double up the ellipsis on previews written by the new write site', () => {
    const preview = `${'x'.repeat(COMMENT_PREVIEW_MAX)}…`
    const html = renderDigestEmail({ events: [ev({ type: 'comment_added', metadata: JSON.stringify({ preview }) })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain(`Will: &quot;${preview}&quot;`)
    expect(html).not.toContain('……')
  })
  it('points the manage-settings footer link at the email-digest setting anchor', () => {
    const html = renderDigestEmail({ events: [ev()], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('/profile#setting-email-digest')
  })
  it('drops the priority-colored left edge (matches Pulse bill card)', () => {
    const html = renderDigestEmail({ events: [ev({ priority: 'high' })], assocName: 'X', appUrl: 'https://x' })
    expect(html).not.toContain('border-left:3px')
  })
  it('renders the priority chip, a card shadow, and row dividers', () => {
    const html = renderDigestEmail({ events: [ev({ priority: 'high' })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('High priority')
    expect(html).toContain('box-shadow:')
    expect(html).toContain('border-top:1px solid')
  })
  it('emits font-size with px units (no unitless CSS)', () => {
    const html = renderDigestEmail({ events: [ev()], assocName: 'X', appUrl: 'https://x' })
    expect(html).not.toMatch(/font-size:\d+;/)
  })
  it('links the header to the canonical bill URL', () => {
    const html = renderDigestEmail({ events: [ev({ billNumber: 'HB10' })], assocName: 'X', appUrl: 'https://ri.example.vote' })
    expect(html).toContain('href="https://ri.example.vote/RI/2026/HB10"')
  })
  it('links a change row to its deep anchor', () => {
    const html = renderDigestEmail({
      events: [ev({ billNumber: 'HB10', type: 'bill_updated', metadata: JSON.stringify({ changes: [{ changeType: 'action_added', oldValue: null, newValue: 'Referred', detail: null }] }) })],
      assocName: 'X', appUrl: 'https://ri.example.vote',
    })
    expect(html).toContain('href="https://ri.example.vote/RI/2026/HB10#section-actions"')
  })
  it('shows the covered date range in the header', () => {
    const html = renderDigestEmail({
      events: [ev()], assocName: 'X', appUrl: 'https://x',
      periodStart: '2026-06-01T00:00:00Z', periodEnd: '2026-06-04T00:00:00Z',
    })
    expect(html).toContain('Jun 1 – Jun 4')
  })
  it('collapses the range to a single date when start and end land on the same day', () => {
    const html = renderDigestEmail({
      events: [ev()], assocName: 'X', appUrl: 'https://x',
      periodStart: '2026-06-04T01:00:00Z', periodEnd: '2026-06-04T09:00:00Z',
    })
    expect(html).toContain('Jun 4')
    expect(html).not.toContain('Jun 4 – Jun 4')
  })
  it('renders an absolute date on each timed row (UTC, year-less)', () => {
    // ev() createdAt is 2026-06-02T10:00:00Z → "Jun 2"
    const html = renderDigestEmail({ events: [ev()], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Jun 2')
  })
  it('drift guard: email row text matches buildBillCardModel row text', () => {
    const event = ev()
    const html = renderDigestEmail({ events: [event], assocName: 'X', appUrl: 'https://x' })

    // Build model via same toGroup-style shape
    const group: GroupedBillEvents = {
      key: event.billId, billId: event.billId, billNumber: event.billNumber, billTitle: event.billTitle,
      billSessionSlug: null, billState: event.billState, billSummary: event.summary ?? null,
      billPriority: event.priority as GroupedBillEvents['billPriority'], billMatchType: null, date: '',
      events: [{
        id: `${event.billId}-0`, type: event.type as FeedEvent['type'], billId: event.billId,
        billNumber: event.billNumber, billSessionSlug: null, billState: event.billState,
        billTitle: event.billTitle, billSummary: null,
        billPriority: event.priority as GroupedBillEvents['billPriority'], billMatchType: null,
        userName: event.userName ?? '', userTitle: null,
        metadata: JSON.parse(event.metadata), createdAt: event.createdAt,
      }] as FeedEvent[],
    }
    const model = buildBillCardModel(group)
    expect(model.rows.length).toBeGreaterThan(0)
    // The email must contain the exact row text from the shared model
    expect(html).toContain(model.rows[0].text)
  })

  it('renders the sample digest unchanged (extraction regression guard)', () => {
    // Fixed period so the date-range header is deterministic (otherwise it
    // falls back to Date.now() and the snapshot drifts daily).
    const html = renderDigestEmail({ events: SAMPLE_DIGEST_EVENTS, assocName: SAMPLE_ASSOC_NAME, appUrl: 'https://x.test', newMatches: SAMPLE_NEW_MATCHES, periodStart: '2026-06-22T00:00:00Z', periodEnd: '2026-06-23T00:00:00Z' })
    expect(html).toMatchSnapshot()
  })
})

describe('renderDigestEmail — summary line follows the window the digest covers', () => {
  const signal = (periodStart?: string, periodEnd?: string) => {
    const html = renderDigestEmail({ events: [ev()], assocName: 'X', appUrl: 'https://x', periodStart, periodEnd })
    return html.match(/line-height:1\.35;">([^<]*)</)![1]
  }

  it('daily cadence: a one-day window says "in the last day"', () => {
    expect(signal('2026-06-09T11:00:00Z', '2026-06-10T11:00:00Z')).toBe('1 priority bill was updated in the last day')
  })
  it('weekly cadence: a seven-day window says "in the last week"', () => {
    expect(signal('2026-06-03T11:00:00Z', '2026-06-10T11:00:00Z')).toBe('1 priority bill was updated in the last week')
  })
  it('a daily digest that skipped runs describes the real window', () => {
    expect(signal('2026-06-07T11:00:00Z', '2026-06-10T11:00:00Z')).toBe('1 priority bill was updated in the last 3 days')
  })
  it('a weekly digest that skipped a run describes the real window', () => {
    expect(signal('2026-05-27T11:00:00Z', '2026-06-10T11:00:00Z')).toBe('1 priority bill was updated in the last 14 days')
  })
  it('reads the database timestamp format the digest job passes, as UTC', () => {
    expect(signal('2026-06-09 11:00:00', '2026-06-10 11:00:00')).toBe('1 priority bill was updated in the last day')
  })
  it('with no window supplied, covers the default 24 hours: "in the last day"', () => {
    expect(signal()).toBe('1 priority bill was updated in the last day')
  })
})

describe('sample digest emails render the wording for their cadence', () => {
  it('the daily sample says "in the last day"', () => {
    expect(renderSampleEmail('digest', 'https://x').html).toContain('priority bills were updated in the last day')
  })
  it('the weekly sample says "in the last week"', () => {
    expect(renderSampleEmail('digest-weekly' as any, 'https://x').html).toContain('priority bills were updated in the last week')
  })
})

describe('renderDigestEmail — untitled drafts', () => {
  it('labels an untitled draft "Untitled draft" on its card', () => {
    const html = renderDigestEmail({ events: [ev({ billNumber: 'D1', billTitle: '', billIsDraft: true })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Untitled draft')
    expect(html).toContain('D1')
  })
  it('keeps a titled draft\'s own title', () => {
    const html = renderDigestEmail({ events: [ev({ billNumber: 'D1', billTitle: 'Draft bill title', billIsDraft: true })], assocName: 'X', appUrl: 'https://x' })
    expect(html).toContain('Draft bill title')
    expect(html).not.toContain('Untitled draft')
  })
  it('never labels a filed bill "Untitled draft", even with a blank title', () => {
    const html = renderDigestEmail({ events: [ev({ billTitle: '', billIsDraft: false })], assocName: 'X', appUrl: 'https://x' })
    expect(html).not.toContain('Untitled draft')
  })
})
