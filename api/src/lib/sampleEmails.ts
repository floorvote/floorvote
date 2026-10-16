// Sample email payloads + a targeted sender, for QA of the email templates.
// Renders each email type from representative fixed data and sends to ONE
// address via the real send path (sendEmail / sendMagicLink) — used by the
// admin-gated POST /api/internal/send-sample-email endpoint and by the
// scripts/render-*-sample.ts preview generators (so the committed samples and
// the emails QA receives stay identical).

import type { AppDb, Env } from '../types'
import { sendEmail, renderMagicLinkEmail } from './email'
import { renderWeekAheadEmail, type WeekAheadDay } from './weekAheadEmail'
import { renderDigestEmail, digestSubject, type DigestEvent, type NewMatchDigestItem } from './digestEmail'
import { renderMentionEmail } from './mentions'
import { renderReplyEmail, muteBillPageUrl } from './replies'
import { renderInviteBounceEmail, type BouncedAddress } from './inviteBounceEmail'
import { renderEmailChangeConfirmEmail, renderEmailChangeNoticeEmail, renderEmailChangeReportedEmail } from './emailChangeEmail'

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

// New matches awaiting triage, the digest's second section. Relevance scores are
// on the real 1-10 scale. The last one has no summary yet, so its card has no preview.
export const SAMPLE_NEW_MATCHES: NewMatchDigestItem[] = [
  { billId: 'b5', billNumber: 'HB 1602', billTitle: 'Automatic voter registration at the DMV', billState: 'RI', billSession: '2026', relevanceScore: 9, summary: 'Registers eligible residents to vote automatically when they get or renew a license, unless they opt out.' },
  { billId: 'b6', billNumber: 'S 0712', billTitle: 'Ranked-choice voting for municipal elections', billState: 'RI', billSession: '2026', relevanceScore: 7, summary: 'Lets cities and towns adopt ranked-choice voting for local races, with state-funded voter education.' },
  { billId: 'b7', billNumber: 'HB 1455', billTitle: 'Poll worker compensation increase', billState: 'RI', billSession: '2026', relevanceScore: 5 },
]

// A heavy filing day: more matches than the digest lists, so the sample shows the
// cap (top 10 by relevance) and the "See all N new matches" link.
const heavyDayMatch = (n: number, billNumber: string, billTitle: string, relevanceScore: number): NewMatchDigestItem =>
  ({ billId: `b${n}`, billNumber, billTitle, billState: 'RI', billSession: '2026', relevanceScore })
export const SAMPLE_NEW_MATCHES_HEAVY_DAY: NewMatchDigestItem[] = [
  ...SAMPLE_NEW_MATCHES,
  heavyDayMatch(10, 'HB 1710', 'Early voting site requirements', 8),
  heavyDayMatch(11, 'S 0804', 'Election audit procedures', 8),
  heavyDayMatch(12, 'HB 1233', 'Provisional ballot cure period', 6),
  heavyDayMatch(13, 'HB 1890', 'Voter list maintenance standards', 6),
  heavyDayMatch(14, 'S 0911', 'Mail ballot signature verification', 4),
  heavyDayMatch(15, 'HB 1347', 'Campaign finance reporting deadlines', 3),
  heavyDayMatch(16, 'S 0377', 'Municipal election date alignment', 3),
  heavyDayMatch(17, 'HB 1521', 'Voting machine certification', 2),
  heavyDayMatch(18, 'S 0688', 'Candidate filing fee changes', 2),
  heavyDayMatch(19, 'HB 1099', 'Redistricting commission membership', 1),
  heavyDayMatch(20, 'S 0540', 'Election day holiday designation', 1),
]

// Bounced invites from one hourly check: a typo the receiving server rejected,
// and a full mailbox whose retries ran out.
export const SAMPLE_INVITE_BOUNCES: BouncedAddress[] = [
  { email: 'jordan.lee@exmaple.org', reason: '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup' },
  { email: 'casey.morgan@example.org', reason: '552 5.2.2 The email account that you tried to reach is over quota' },
]

// The new address in the email-change samples. The notices to the old address show it masked.
export const SAMPLE_NEW_EMAIL = 'dana.reed@newcounty.gov'

export type SampleEmailType = 'login' | 'invite' | 'week-ahead' | 'digest' | 'digest-weekly' | 'digest-new-only' | 'mention' | 'reply' | 'invite-bounced'
  | 'email-change-confirm' | 'email-change-requested' | 'email-change-changed' | 'email-change-reported'

export function isSampleEmailType(t: string): t is SampleEmailType {
  return (ALL_SAMPLE_EMAIL_TYPES as string[]).includes(t)
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
        }),
      }
    case 'digest':
      // Daily cadence (the default). Fixed period so the date range is deterministic (committed sample + snapshot).
      return {
        subject: `[Sample] ${digestSubject({ updatedBills: 2, newMatches: SAMPLE_NEW_MATCHES.length, cadence: 'daily' })}`,
        html: renderDigestEmail({ events: SAMPLE_DIGEST_EVENTS, assocName: SAMPLE_ASSOC_NAME, appUrl, newMatches: SAMPLE_NEW_MATCHES, periodStart: '2026-06-10', periodEnd: '2026-06-11' }),
      }
    case 'digest-weekly':
      // Weekly cadence: the same digest over a seven-day window.
      return {
        subject: `[Sample] ${digestSubject({ updatedBills: 2, newMatches: SAMPLE_NEW_MATCHES.length, cadence: 'weekly' })}`,
        html: renderDigestEmail({ events: SAMPLE_DIGEST_EVENTS, assocName: SAMPLE_ASSOC_NAME, appUrl, newMatches: SAMPLE_NEW_MATCHES, periodStart: '2026-06-04', periodEnd: '2026-06-11' }),
      }
    case 'digest-new-only':
      // Digest when there are NO priority-bill updates — only new matches, on a heavy
      // day so it shows the cap and the "See all N new matches" link.
      return {
        subject: `[Sample] ${digestSubject({ updatedBills: 0, newMatches: SAMPLE_NEW_MATCHES_HEAVY_DAY.length, cadence: 'daily' })}`,
        html: renderDigestEmail({ events: [], assocName: SAMPLE_ASSOC_NAME, appUrl, newMatches: SAMPLE_NEW_MATCHES_HEAVY_DAY, periodStart: '2026-06-10', periodEnd: '2026-06-11' }),
      }
    case 'mention':
      return {
        subject: '[Sample] You were mentioned in a comment',
        html: renderMentionEmail({
          appUrl,
          instanceName: SAMPLE_ASSOC_NAME,
          author: { name: 'Sam Ortiz', title: 'Town Clerk, Cranston' },
          bill: { id: 'b1', billNumber: 'HB 1234', title: 'Voter ID Act', state: 'RI', session: '2026 Regular Session', priority: 'high', tenantSummary: 'Requires photo identification to vote in person and by mail, with free IDs issued by the state.' },
          comment: { id: 'sample-comment', createdAt: '2026-06-10 16:45:00', html: '<p>Hey <span data-type="mention" data-id="user:u2" data-label="@Dana Reed">@Dana Reed</span> — we should testify against this at Thursday\'s hearing. Can you pull the talking points?</p>' },
          via: 'user',
        }),
      }
    case 'reply':
      return {
        subject: '[Sample] New comment',
        html: renderReplyEmail({
          appUrl,
          instanceName: SAMPLE_ASSOC_NAME,
          author: { name: 'Sam Ortiz', title: 'Town Clerk, Cranston' },
          bill: { id: 'b1', billNumber: 'HB 1234', title: 'Voter ID Act', state: 'RI', session: '2026 Regular Session', priority: 'high', tenantSummary: 'Requires photo identification to vote in person and by mail, with free IDs issued by the state.' },
          comment: { id: 'sample-comment', createdAt: '2026-06-10 16:45:00', html: '<p>I read the amended text. Section two still lets a clerk waive the ID check, so I don\'t think we need to oppose it after all.</p>' },
          // A sample is not signed for anyone, so its mute link opens the page and goes no further.
          muteUrl: muteBillPageUrl(appUrl, 'sample'),
        }),
      }
    case 'invite-bounced': {
      const { subject, html } = renderInviteBounceEmail({ appUrl, instanceName: SAMPLE_ASSOC_NAME, bounces: SAMPLE_INVITE_BOUNCES })
      return { subject: `[Sample] ${subject}`, html }
    }
    case 'email-change-confirm': {
      const { subject, html } = renderEmailChangeConfirmEmail({
        appUrl, instanceName: SAMPLE_ASSOC_NAME, confirmUrl: `${appUrl}/auth/confirm-email?token=sample-link-not-functional`,
      })
      return { subject: `[Sample] ${subject}`, html }
    }
    case 'email-change-requested':
    case 'email-change-changed': {
      const { subject, html } = renderEmailChangeNoticeEmail({
        stage: type === 'email-change-requested' ? 'requested' : 'changed',
        appUrl, instanceName: SAMPLE_ASSOC_NAME, newEmail: SAMPLE_NEW_EMAIL, notMeUrl: `${appUrl}/auth/not-me?token=sample-link-not-functional`,
      })
      return { subject: `[Sample] ${subject}`, html }
    }
    case 'email-change-reported': {
      const { subject, html } = renderEmailChangeReportedEmail({
        appUrl, instanceName: SAMPLE_ASSOC_NAME, memberName: 'Dana Reed', memberEmail: 'dana.reed@county.gov',
        oldEmail: 'dana.reed@county.gov', newEmail: SAMPLE_NEW_EMAIL, requestedBy: 'the member',
        requestedAt: 'June 15, 2026 at 2:41 p.m. UTC', current: 'new', currentEmail: SAMPLE_NEW_EMAIL, changeCommitted: false, cancelledTo: null, stillPendingTo: null,
      })
      return { subject: `[Sample] ${subject}`, html }
    }
  }
}

/** Render a sample email and send it to a single address via the real send path.
 *  Never throws — returns a normalized result. */
export async function sendSampleEmail(env: Env, _db: AppDb, to: string, type: SampleEmailType): Promise<SampleSendResult> {
  const { subject, html } = renderSampleEmail(type, env.APP_URL)
  // No db: operator mail stays out of email_send_stats, like the health alert,
  // so a sample's success cannot make a failing provider look recovered.
  return sendEmail(env, { to: [to], subject, html })
}

/** Every sample email type — drives the conformance test's iteration. */
export const ALL_SAMPLE_EMAIL_TYPES: SampleEmailType[] = ['login', 'invite', 'week-ahead', 'digest', 'digest-weekly', 'digest-new-only', 'mention', 'reply', 'invite-bounced',
  'email-change-confirm', 'email-change-requested', 'email-change-changed', 'email-change-reported']
