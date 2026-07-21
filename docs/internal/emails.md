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
api/src/lib/weekAheadEmail.ts renderWeekAheadEmail()
api/src/lib/mentions.ts       renderMentionEmail()
api/src/lib/email.ts          renderMagicLinkEmail() (login/invite) + sendEmail/sendMagicLink/sendFeedback
api/src/lib/sampleEmails.ts   renderSampleEmail() registry + sendSampleEmail()  ← single source for QA + previews + tests
```

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

Both call `renderSampleEmail`, so the committed previews, the QA send path, and the
conformance snapshots are guaranteed identical.

To send live samples to one address (staging):

```bash
curl -X POST "$CENTRAL/api/tenants/<tenant>/send-sample-email" \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"to":"you@example.com","type":"digest"}'
```
