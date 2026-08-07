// Sample email payloads + a targeted sender, for QA of the email templates.
// Renders each email type from representative fixed data and sends to ONE
// address via the real send path (sendEmail / sendMagicLink) — used by the
// admin-gated POST /api/internal/send-sample-email endpoint and by the
// scripts/render-*-sample.ts preview generators (so the committed samples and
// the emails QA receives stay identical).

import type { AppDb, Env } from '../types'
import { sendEmail, renderMagicLinkEmail } from './email'
import { renderWeekAheadEmail, type WeekAheadDay } from './weekAheadEmail'
import { renderDigestEmail, type DigestEvent, type NewMatchDigestItem } from './digestEmail'
import { renderMentionEmail } from './mentions'

export const SAMPLE_ASSOC_NAME = 'Rhode Island Association of Local Election Officials'

export const SAMPLE_WEEK_AHEAD_DAYS: WeekAheadDay[] = [
  {
    date: '2026-06-15', label: 'Monday, June 15',
    events: [
      { id: 'ev1', source: 'hearing', description: 'House Committee on State Government and Elections', location: 'State House, Room 101', time: '09:00', status: 'confirmed',
        bills: [
          { id: 'b1', billNumber: 'HB 1234', state: 'RI', priority: 'high', billTitle: 'Voter ID Act' },
          { id: 'b2', billNumber: 'HB 1240', state: 'RI', priority: 'medium', billTitle: 'Mail Ballot Drop Boxes' },
        ] },
      { id: 'ev2', source: 'hearing', description: 'Senate Judiciary Committee', location: 'State House, Room 313', time: '14:00', status: 'confirmed',
        bills: [{ id: 'b3', billNumber: 'S 0456', state: 'RI', priority: 'low', billTitle: 'Recount Procedures' }] },
    ],
  },
  {
    date: '2026-06-17', label: 'Wednesday, June 17',
    events: [
      { id: 'ev3', source: 'custom', description: 'Association board meeting', location: 'Zoom', time: '12:00', status: 'confirmed', bills: [] },
      { id: 'ev4', source: 'hearing', description: 'House Finance Committee', location: 'State House, Room 35', time: null, status: 'confirmed',
        bills: [{ id: 'b4', billNumber: 'HB 1502', state: 'RI', priority: 'high', billTitle: 'Election Administration Funding' }] },
    ],
  },
  {
    date: '2026-06-19', label: 'Friday, June 19',
    events: [{ id: 'ev5', source: 'custom', description: 'Quarterly staff training', location: null, time: null, status: 'confirmed', bills: [] }],
  },
]

const j = (o: unknown) => JSON.stringify(o)
export const SAMPLE_DIGEST_EVENTS: DigestEvent[] = [
  { type: 'priority_set', metadata: j({ priority: 'high' }), createdAt: '2026-06-09 14:02:00', billId: 'b1', billNumber: 'HB 1234', billTitle: 'Voter ID Act', billState: 'RI', billSession: '2026', priority: 'high', summary: 'Requires photo identification to vote in person and by mail, with free IDs issued by the state.', userName: 'Dana Reed' },
  { type: 'bill_updated', metadata: j({ changes: [{ changeType: 'action_added', newValue: 'Passed House committee' }] }), createdAt: '2026-06-10 09:30:00', billId: 'b1', billNumber: 'HB 1234', billTitle: 'Voter ID Act', billState: 'RI', billSession: '2026', priority: 'high', summary: null, userName: null },
  { type: 'comment_added', metadata: j({ preview: 'We should testify against this at the hearing.' }), createdAt: '2026-06-10 16:45:00', billId: 'b1', billNumber: 'HB 1234', billTitle: 'Voter ID Act', billState: 'RI', billSession: '2026', priority: 'high', summary: null, userName: 'Sam Ortiz' },
  // Long comment, stored cut at COMMENT_PREVIEW_MAX with no trailing marker —
  // the legacy shape written before the ellipsis fix. Kept in the sample so the
  // digest QA email and the snapshot both cover a truncated comment row.
  { type: 'comment_added', metadata: j({ preview: 'Free IDs sound simple, but our office would need a second workstation and staff coverage to issue them during peak weeks' }), createdAt: '2026-06-10 17:20:00', billId: 'b1', billNumber: 'HB 1234', billTitle: 'Voter ID Act', billState: 'RI', billSession: '2026', priority: 'high', summary: null, userName: 'Marguerite Okonkwo' },
  { type: 'position_set', metadata: j({ position: 'Oppose' }), createdAt: '2026-06-10 11:15:00', billId: 'b2', billNumber: 'S 0456', billTitle: 'Mail Ballot Drop Boxes', billState: 'RI', billSession: '2026', priority: 'medium', summary: 'Authorizes secure 24-hour drop boxes in every municipality and sets chain-of-custody rules.', userName: 'Dana Reed' },
]

// New keyword matches awaiting triage — the admin-only digest section. Relevance
// scores are on the real 1-10 scale.
export const SAMPLE_NEW_MATCHES: NewMatchDigestItem[] = [
  { billId: 'b5', billNumber: 'HB 1602', billTitle: 'Automatic voter registration at the DMV', billState: 'RI', billSession: '2026', relevanceScore: 9 },
  { billId: 'b6', billNumber: 'S 0712', billTitle: 'Ranked-choice voting for municipal elections', billState: 'RI', billSession: '2026', relevanceScore: 7 },
  { billId: 'b7', billNumber: 'HB 1455', billTitle: 'Poll worker compensation increase', billState: 'RI', billSession: '2026', relevanceScore: 5 },
]

export type SampleEmailType = 'login' | 'invite' | 'week-ahead' | 'digest' | 'digest-new-only' | 'mention'

export function isSampleEmailType(t: string): t is SampleEmailType {
  return t === 'login' || t === 'invite' || t === 'week-ahead' || t === 'digest' || t === 'digest-new-only' || t === 'mention'
}

export interface SampleSendResult { ok: boolean; provider?: string; error?: string }

/**
 * Pure render of one sample email type → { subject, html }. THE single source for
 * QA samples, the committed preview HTML (scripts/render-*-sample.ts), and the
 * conformance/snapshot test (test/lib/emailConformance.test.ts). Add a new email
 * type to `SampleEmailType` + a case here and it is automatically covered by the
 * test and the sender — that's the anti-drift guarantee.
 */
export function renderSampleEmail(type: SampleEmailType, appUrl: string): { subject: string; html: string } {
  switch (type) {
    case 'login':
    case 'invite':
      return renderMagicLinkEmail({
        type, magicLinkUrl: `${appUrl}/login?token=sample-link-not-functional`, appUrl,
        instanceName: SAMPLE_ASSOC_NAME, orgPhrase: SAMPLE_ASSOC_NAME,
      })
    case 'week-ahead':
      return {
        subject: '[Sample] Your week ahead',
        html: renderWeekAheadEmail({
          days: SAMPLE_WEEK_AHEAD_DAYS, assocName: SAMPLE_ASSOC_NAME, appUrl,
          icsUrl: `${appUrl}/api/calendar/feed.ics?token=sample`,
        }),
      }
    case 'digest':
      // Fixed period so the date range is deterministic (committed sample + snapshot).
      return {
        subject: '[Sample] Priority bill updates',
        html: renderDigestEmail({ events: SAMPLE_DIGEST_EVENTS, assocName: SAMPLE_ASSOC_NAME, appUrl, newMatches: SAMPLE_NEW_MATCHES, periodStart: '2026-06-09', periodEnd: '2026-06-11' }),
      }
    case 'digest-new-only':
      // Admin digest when there are NO priority-bill updates — only new keyword matches.
      return {
        subject: '[Sample] New bills matching your keywords',
        html: renderDigestEmail({ events: [], assocName: SAMPLE_ASSOC_NAME, appUrl, newMatches: SAMPLE_NEW_MATCHES, periodStart: '2026-06-09', periodEnd: '2026-06-11' }),
      }
    case 'mention':
      return {
        subject: '[Sample] You were mentioned in a comment',
        html: renderMentionEmail({
          appUrl,
          instanceName: SAMPLE_ASSOC_NAME,
          author: { name: 'Sam Ortiz', subtitle: 'Town Clerk, Cranston' },
          bill: { id: 'b1', billNumber: 'HB 1234', title: 'Voter ID Act', state: 'RI', session: '2026 Regular Session', priority: 'high', tenantSummary: 'Requires photo identification to vote in person and by mail, with free IDs issued by the state.' },
          comment: { id: 'sample-comment', createdAt: '2026-06-10 16:45:00', html: '<p>Hey <span data-type="mention" data-id="user:u2" data-label="@Dana Reed">@Dana Reed</span> — we should testify against this at Thursday\'s hearing. Can you pull the talking points?</p>' },
          via: 'user',
        }),
      }
  }
}

/** Render a sample email and send it to a single address via the real send path.
 *  Never throws — returns a normalized result. */
export async function sendSampleEmail(env: Env, db: AppDb, to: string, type: SampleEmailType): Promise<SampleSendResult> {
  const { subject, html } = renderSampleEmail(type, env.APP_URL)
  return sendEmail(env, { to: [to], subject, html }, db)
}

/** Every sample email type — drives the conformance test's iteration. */
export const ALL_SAMPLE_EMAIL_TYPES: SampleEmailType[] = ['login', 'invite', 'week-ahead', 'digest', 'digest-new-only', 'mention']
