# Email system

All tenant emails share **one shell** so they look consistent and can't drift. This
doc is the contract; follow it when adding a new email type.

## Architecture

```
shared/tokens.ts            colors / sizes / radius (single source of style values)
api/src/lib/emailShell.ts   renderEmailShell()  — the gray shell every email uses
                            emailButton()       — the one CTA button (blue, no arrow)
                            emailFooterLink()   — the one footer link style
                            formatDateRange()   — the one date-range formatter (spaced en-dash)
api/src/lib/emailBillCard.ts  renderBillCardOpen / renderCommentRow / BILL_CARD_CLOSE
api/src/lib/digestEmail.ts    renderDigestEmail()
                              A companion group is one card (`digestCardKey`), its events in time order, each row labeled with
                              its bill's number (`billCardRowText`) and linked to that bill, counted once in the headline,
                              contents box, and subject (`countUpdatedBills`)
api/src/lib/weekAheadEmail.ts renderWeekAheadEmail()
api/src/lib/mentions.ts       renderMentionEmail()
api/src/lib/emailChangeEmail.ts
                              renderEmailChangeConfirmEmail() (to the new address) +
                              renderEmailChangeNoticeEmail() (account-security notices to the old address) +
                              renderEmailChangeReportedEmail() (alert to owners and admins after "This wasn't me")
api/src/lib/emailChangeReport.ts
                              issues each notice's "This wasn't me" token, and reportNotMe() sends the alert
api/src/lib/replies.ts        renderReplyEmail() (sets In-Reply-To and References, never Message-ID, plus a one-click
                              List-Unsubscribe that mutes the bill, only when APP_URL is https)
api/src/lib/inviteBounceEmail.ts
                              renderInviteBounceEmail() + notifyInviteBounces() (hourly, after the bounce check)
api/src/lib/email.ts          renderMagicLinkEmail() + buildSignInMessage() (login/invite) + sendMagicLink, and the
                              sendFeedback (renders the feedback email and sends it as operator mail), and the older
                              sendEmail/sendBatch, which have no caller left (#711 deletes them)
api/src/lib/sampleEmails.ts   renderSampleEmail() registry + sendSampleEmail()  ← single source for QA + previews + tests
shared/emailSender.ts         createSender(): send a message by purpose (see "Sending" below)
shared/emailProviders.ts      the Resend and Cloudflare send_email adapters
api/src/lib/emailHealthRecorder.ts
                              the API's health recorder: email_send_stats and Resend usage
```

## Sending

Email is moving onto one sender, shared by the API and central (#705). A caller
names the email's **purpose**, and `createSender(env, { recorder })` decides the
rest from it: fallback to the other provider, health counting, the From address,
and demo-mode suppression. It refuses a malformed address before calling any
provider. `send` never throws. Its result says whether the email went out, which
provider sent it, and, for a failure, whether it is **permanent** (the address
can't receive mail) or temporary.

Each provider adapter sends one message and classifies its own failures. A
Cloudflare `E_RECIPIENT_SUPPRESSED` is permanent. Every Resend failure is
temporary, because Resend reports suppression later, by webhook. A temporary
failure falls back once to the other provider, when the purpose allows it and
the other provider is configured. A permanent one never does.

| Purpose | Emails | Falls back | Counts toward email health | Demo mode |
|---|---|---|---|---|
| Sign-in | tenant login, admin-sent login and invite links, the invite queue, central's dashboard sign-in link | yes | yes, when a recorder is supplied | invites suppressed, login sends |
| Account | the email-change confirmation link, the notice to the old address, the "this wasn't me" report | yes | yes, when a recorder is supplied | suppressed |
| Notification | mentions, replies (a reply keeps its thread and one-click mute headers) | yes | yes, when a recorder is supplied | suppressed |
| Bulk | the digest, the week-ahead email | **never** | yes, when a recorder is supplied | suppressed |
| Operator | feedback, invite-bounce notices, job alerts, sample emails, central's ops alerts | yes | **never** | sends |
| Outage alert | the email-health alert | the healthy provider first, then the failing one | **never** | sends |

Bulk mail never falls back, so an outage on the first provider can't push a whole
recipient list onto the second and burn its quota. It sends from the bulk From
address (`EMAIL_FROM_BULK`, else `EMAIL_FROM`), keeps the default Reply-To, and
counts each send to the provider that sent it. The digest and the week-ahead
email send their batch with `senderFor(env, db).sendBatch`, and a batch's
`sent`, `failed`, and `skipped` count messages. Their "last sent" stamp is
written whatever the batch returned.

Operator mail and the outage alert never count, so operator mail can't hide an
outage or fake a recovery: it keeps arriving during an outage that only affects
member addresses. Feedback and invite-bounce notices used to count, and no longer
do, which matches the other operator mail. Both send in demo mode, because the
operator of a demo still needs to hear about it. The outage alert is about the
provider the sender tries first (the primary), so its rule (`order:
'alternate-first'`) swaps the first two providers: the healthy one goes first, and
the failing one is the fallback. `emailHealthJob.ts` no longer picks the order.
A sample email returns the sender's result as it is, so the operator who asked
sees which provider sent it, or why none did.

The API supplies `emailHealthRecorder(db)`, and central supplies none, so central
counts nothing. Central builds its sender with `centralSender(env)`
(`central/src/lib/sender.ts`), which tries only the providers that are configured
(a Resend key, or the `EMAIL` binding): with both, the dashboard sign-in link and
ops alerts fall back, and with neither, a send fails at once without calling a
provider. The dashboard login gate asks `hasConfiguredProvider` the same question.
A sign-in message carries its `auth_events` writer, called once
per attempt. `sendEmail` and `sendBatch` have no caller left, and #711 deletes them.

The email-change confirmation turns the sender's verdict into the member's
answer: a permanent failure is "That address can't receive email" (400), and a
temporary one, meaning both providers failed, is "try again" (502). The pending
change is deleted either way.

## The shell contract

`renderEmailShell({ instanceName, signalHtml, dateLabel?, bodyHtml, ctaHtml?, footerHtml })`:

- **Gray (`surfaceSubtle`) backdrop, 560px column, 32px outer padding.**
- Masthead: `FloorVote` wordmark → **instance name** (required) → bold signal sentence → optional small date.
- `bodyHtml`: cards on the gray (each card carries its own white border + shadow).
- Optional `ctaHtml` (use `emailButton`) → blue, no arrow glyph.
- Footer: `border-top` + centered links (use `emailFooterLink`).

**Rules that prevent drift:**
- `instanceName` is **required** — every email shows the association name. (Type error if omitted.)
- Date ranges go through **`formatDateRange`** — never inline a range string (that's how spacing drifted).
- CTAs go through **`emailButton`** (blue `accentBlue`; navy is reserved for bill chips). No `→`.
- Footer links go through **`emailFooterLink`**.
- User-supplied text is escaped before it reaches `signalHtml`/`bodyHtml` (the shell auto-escapes `instanceName`/`dateLabel`).

## Adding a new email type (3 steps)

1. **Write a pure renderer** that returns HTML by calling `renderEmailShell` (+ the bill-card / event-card helpers as needed). Keep it pure (no DB/env) so it's testable.
2. **Register a sample** in `api/src/lib/sampleEmails.ts`: add the literal to `SampleEmailType`, a `case` in `renderSampleEmail()`, and the value to `ALL_SAMPLE_EMAIL_TYPES`. (This is also what `POST /api/tenants/:id/send-sample-email` uses, so registering makes it sendable for QA.)
3. **Run the tests.** `api/test/lib/emailConformance.test.ts` iterates `ALL_SAMPLE_EMAIL_TYPES` automatically — your new type is enrolled, conformance-checked (shell, wordmark, instance name, footer, blue CTA), and snapshotted. Commit the new snapshot after eyeballing it.

## Previewing

```bash
# → docs/digest-email-sample.html
npx tsx scripts/render-digest-sample.ts

# → docs/week-ahead-email-sample.html
npx tsx scripts/render-week-ahead-sample.ts
```

Both call `renderSampleEmail`, so the generated previews, the QA send path, and the
conformance snapshots are guaranteed identical.

To send live samples to one address (staging):

```bash
curl -X POST "$CENTRAL/api/tenants/<tenant>/send-sample-email" \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"to":"you@example.com","type":"digest"}'
```
