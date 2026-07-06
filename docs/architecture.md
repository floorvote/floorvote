# Sync Architecture (LegiScan path)

Canonical, code-grounded description of how legislative data flows from LegiScan into tenant DBs. Update this file whenever the pipeline changes. The visual companion is [`architecture.html`](/architecture.html) — keep both in sync, but treat this file as the source of truth.

> **Scope:** the LegiScan central env (`floorvote-central-legiscan`). The OpenStates env is structurally similar but lighter; this doc describes the LegiScan path.

---

## Pipeline at a glance

```
LegiScan API  →  central cron  →  central ingestor queue  →  per-tenant queue  →  tenant D1
                  (Phase 1)        (Phase 2)                  (Phase 3a)         (Phase 3b)
```

Three queue boundaries. LegiScan API quota is **30,000 calls/month total**. Calls happen only in Phases 1 and 2 — the cron polls masterlist endpoints, the ingestor calls `getBill` once per queued bill. Phase 3 is internal data movement, zero API cost.

---

## Phase 1 — Cron (`central/src/cron/sync-legiscan.ts`)

Triggered hourly (`0 * * * *`). Per session, picks a mode via `decideMode(session, etHour)`:

- **skip** — session sine die or sync disabled.
- **full** — at default ET hours `[5, 13, 23]`. Calls `getMasterList?id=<sessionId>` (one quota tick per session per full hour, returns ~400 KB with title + description + status + last_action).
- **raw** — at default ET hours `[7, 9, 11, 15, 17, 19, 21]`. Calls `getMasterListRaw?id=<sessionId>` (one quota tick, returns ~100 KB with just `bill_id` + `change_hash`).

Default cadence ⇒ **10 masterlist calls per session per day**.

### Full pass

For each masterlist entry:

1. **Bills row maintenance.** If new: `INSERT … ON CONFLICT DO NOTHING` with new `change_hash` and masterlist metadata. If existing-and-changed: `UPDATE bills SET change_hash, title, status, …`. (These writes commit *before* any queue send — see "ordering" below.)
2. **Keyword matching.** Build `haystack = title + description + number`, test against per-tenant keyword union, compute `newMatchType ∈ { 'keyword', 'manual', null }`. `'manual'` is never demoted by this loop. Upsert `bill_tenants` rows.
3. **Dispatch:**
   - **→ ingestor queue** (will trigger `getBill`): bill IDs that are `justMatched` (newMatchType ≠ prev and ≠ null) OR `alreadyMatchedAndChanged` (existing match + hash changed).
   - **→ tenant queue directly** (no API call): `stubOnly` messages for `match_type=null` link changes, so the tenant refreshes denormalized fields from central's `/bills/:id`.
   - **Nothing**: unchanged or never-matched bills.

### Raw pass

For each masterlist-raw entry:

1. **Bills row maintenance.** New bills inserted with `change_hash = ''` sentinel and `title = bill_number` (raw has no title); *not* queued. Existing changed bills get `change_hash` + `updatedAt` updated **only if matched** (`match_type ∈ {'keyword','manual'}` for some covering tenant). Unmatched (`match_type=null`) changed bills are deliberately **left with their stale `change_hash`** — see "Why the raw pass leaves unmatched hashes stale" below.
2. **Dispatch:**
   - **→ ingestor queue**: already-matched bills with changed hash (the ingestor re-pulls via `getBill` and re-writes the hash itself, so advancing it here is harmless).
   - **Nothing else**: no `stubOnly` notifications (raw has no fresh metadata to send), no new-match discovery (no titles to match against), and unmatched changed bills are left untouched.

#### Why the raw pass leaves unmatched hashes stale

The full pass is the **only** pass that refreshes `last_action`/`status` for monitoring-only bills and sends them `stubOnly` notifications, and it gates that work on `billChanged = stored.change_hash !== masterlist.change_hash`. The raw masterlist carries no `last_action`/`status` and the raw pass never notifies stub tenants — so if the raw pass advanced an unmatched bill's `change_hash`, the *next full pass would see no delta and silently swallow the change forever* (until some later change happened to land in a full-pass window first). Because ~7 of every 10 passes are raw, that swallow was the common case. Leaving the unmatched hash stale lets the full pass reliably detect and propagate the change (≤8h latency). Fixed in `runRawPass` ([sync-legiscan.ts](../central/src/cron/sync-legiscan.ts)); the one-off `POST /admin/backfill-stub-actions/:tenantId` route heals stubs that were already swallowed before the fix.

### Cron design consequences

- `getBill` is **only** called for matched bills (`match_type ∈ {'keyword', 'manual'}`). The cron is the API gate; unmatched changes never touch the ingestor.
- New keyword matches surface in full passes only ⇒ ≤8h latency.
- Monitoring-only bill metadata updates surface in full passes only ⇒ ≤8h latency. The raw pass leaves unmatched bills' `change_hash` stale precisely so the full pass keeps detecting them (see "Why the raw pass leaves unmatched hashes stale"); advancing it there used to swallow the change.
- **Ordering note**: the cron writes the new `change_hash` and masterlist fields to central D1 *before* sending the queue message. By the time the ingestor's snapshot reads `bills.change_hash`, it already matches what `getBill` will return. This means `bill_change_log` rows for `title_changed` / `status_change` / `description_changed` are not emitted for cron-triggered messages — the snapshot reads the post-change value. Child-collection diffs (history, sponsors, votes, supplements, amendments) are still captured correctly. This is a known caveat.

---

## Phase 2 — Central ingestor (`central/src/queue/processor-legiscan.ts`)

Consumes from `central-legiscan-ingestor` queue. Message shape: `{ billId: number; skipFetch?: boolean; forceMetadata?: boolean; forceAI?: boolean }`.

### skipFetch branch

Used by the bulk-seed script and the `redownload-texts` admin route. Skips `getBill` entirely. Downloads any `bill_texts` row with null `r2_key` from `state_link`, then calls `notifyLsTenants` and returns. Zero LegiScan API cost.

### Normal branch (the common path)

Always calls `getBill(billId)` — **one LegiScan quota tick per message**. The cron is the only gate preventing that tick.

After `getBill`, the ingestor unconditionally:

1. Reads existing `bills` row (if any) and snapshots its child rows.
2. Runs `detectChanges` to compute a list of `ChangeRecord`s.
3. Writes `bill_change_log` rows (one per detected change).
4. Upserts the `bills` row (status, title, last_action, etc.).
5. **Delete + reinsert** these child tables: `bill_history`, `bill_sponsors`, `bill_sasts`, `bill_subjects`, `bill_calendar`, `bill_referrals`.
6. **Upsert** these child tables: `bill_texts`, `bill_supplements`, `bill_amendments`, `roll_calls`.
7. Downloads any text without an R2 key to `bills/legiscan-{billId}/texts/{docId}.{ext}`.
8. Stamps `bills.texts_fetched_at` → derives `text_status` for the response.
9. Calls `notifyLsTenants` for each covering tenant.

**Note:** per-legislator vote rows (`roll_call_votes`) are **not** populated by this path — `getBill` returns vote summaries (`LegiscanVoteSummary`) only. Bulk-seeded bills have per-legislator rows; live-ingested bills don't. Architecture-review §B4.

### notifyLsTenants

Reads `bill_tenants` rows for this bill (joined to `tenants` for `queue_id`), then sends one message per covering tenant to that tenant's queue: `{ tenantId, billId: 'legiscan:<id>', forceMetadata, forceAI, matchType, changes }`. Sets `bill_tenants.notified_at`.

Delivery goes through `deliverToTenant` ([central/src/lib/tenantDelivery.ts](../central/src/lib/tenantDelivery.ts)): **binding-first** — if a static `TENANT_QUEUE_<ID>` producer binding exists it uses `queue.send`/`sendBatch` (unchanged) — else it **HTTP-publishes by `queue_id`** via the Queues REST API (`CF_QUEUES_TOKEN`), so a tenant onboarded without a static binding still receives bills. Only when neither exists is the message dropped (logged).

---

## Phase 3a — Per-tenant queue boundary

Each tenant has its own queue (`floorvote-{id}-queue`). Messages come from three places:

1. **Ingestor `notifyLsTenants`** — bills that just went through `getBill`. Normal flow.
2. **Cron's full pass directly** — `stubOnly` messages for monitoring-only bills whose masterlist row changed.
3. **Admin endpoints** — `reprocess`, `refresh-stubs`, `refresh-metadata`. Bypass the ingestor.

---

## Phase 3b — Tenant consumer (`api/src/queue/processor.ts`)

For every message: `centralFetch('/bills/<billId>')` — a pure D1 read on central, **zero LegiScan calls**. The response includes the normalized bill + child data, plus a server-derived `text_status`.

### Canonical bill-state fields

Every tenant `bills` row carries three independent fields that together describe its state, plus a paired qualifier on the AI field:

| Field | Values | Meaning |
|---|---|---|
| `match_type` | `'keyword'` / `'manual'` / `null` | Tracking tier. `null` = monitoring-only (metadata refresh, no AI). |
| `text_status` | `'in_r2'` / `'available'` / `'no_texts'` / `'not_checked'` / `null` | Whether central confirms full text exists. Derived from `texts_fetched_at` + `bill_texts` rows on central. |
| `ai_processed_at` | timestamp / `null` | Whether AI has run successfully and when. |
| `ai_skip_reason` | `'pdf_too_large'` / `null` | Paired qualifier on `ai_processed_at`. When the AI provider rejects input non-retryably (e.g. Gemini's 1000-page PDF cap), the tenant queue processor records the reason here and leaves `ai_processed_at` null. The early-return dedup at `processor.ts` treats `ai_skip_reason != null` symmetrically with `ai_processed_at != null` — both mean "permanently decided, don't waste a text fetch + AI call." Cleared automatically when a subsequent AI run succeeds (e.g. on a new, smaller text version, or after `forceAI`). |

These four fields are the source of truth for tenant-side gating and UI rendering.

AI-state tristate:
- `ai_processed_at IS NULL AND ai_skip_reason IS NULL` — AI not yet attempted.
- `ai_processed_at` set — AI succeeded.
- `ai_skip_reason` set — AI permanently failed for the current text.

Only `ai_processed_at` is ever set successfully; `ai_skip_reason` is never set in the same row as a non-null `ai_processed_at`. The two are mutually exclusive within a single text version, though `ai_skip_reason` can later be cleared by a successful run on a new text.

### Message flag behavior

- **`stubOnly: true`** — only from cron's full pass. Upserts bill metadata from central's masterlist-derived data. Skips text fetch and AI. Refuses to overwrite a bill that already has `aiProcessedAt` set or `match_type = 'manual'` (race protection).
- **`metadataOnly: true`** — only from tenant's own `/admin/refresh-metadata` route. Upserts bill metadata. Skips text fetch and AI.
- **Normal** — proceeds to text fetch and AI:
  - Fetches text from central if `text_status ∈ {'available', 'in_r2'}`.
  - Runs AI (Gemini default; Claude fallback on 429/503) when:
    - **shouldRunAi**: `msg.forceAI || derivedMatchType !== null` (where `derivedMatchType` comes from the message, the existing row, or keyword-match for brand-new bills)
    - **AND** an `instance_preset` is configured
    - **AND** text was successfully fetched
    - **AND** `aiDedup` is false: `existing.lastAiTextHash !== centralBill.textHash`, *unless* `forceAI` or `forceMetadata` bypasses dedup
  - Writes `ai_processed_at`, `last_ai_text_hash`, `last_ai_text_doc_id` on success.

### What lives where

- **Tenant D1** — the `bills` row (with denormalized JSON for actions/sponsors), member votes, official positions, comments, notes, feed events, custom fields, AI summary + tags + relevance.
- **Central D1 (LS)** — bills + all relational children (`bill_history`, `bill_sponsors`, `bill_texts`, `bill_supplements`, `bill_amendments`, `bill_sasts`, `bill_subjects`, `bill_calendar`, `bill_referrals`, `roll_calls`, `roll_call_votes`*, people, committees, sessions, `bill_change_log`, `api_call_log`, `session_sync_log`).
- **Central R2** — bill text files at `bills/legiscan-{billId}/texts/{docId}.{ext}` and masterlist cache at `sessions/{id}/masterlist.json`.

*`roll_call_votes` are populated only by the bulk-seed script (see §B4 note).

The tenant has no per-bill relational tables — supplements, amendments, sponsors, votes, calendar, etc. are read live from central by the tenant API's bill-detail route.

---

## Operational endpoints (data-flow only)

All central machine routes are served under `/api/*` (e.g. `/api/tenants/reprocess/:id`, `/api/bills/:id/text`); bare paths fall through to the dashboard SPA. `centralFetch` prepends `/api`. Paths below omit the prefix for brevity.

| Endpoint | Hits ingestor? | API cost | Purpose |
|---|---|---|---|
| Cron (hourly) | Yes, for matched changes | 10 masterlist/session/day + `getBill` per matched change | Steady state |
| `POST /tenants/reprocess/:tenantId` | No (direct to tenant queue, `forceMetadata: true`) | 0 | Refresh tenant rows from existing central data. AI dedups on text hash. |
| `POST /admin/refresh-stubs/:tenantId` | No (direct, `stubOnly: true`) | 0 | Re-send `stubOnly` for all `match_type=null` rows. Does *not* refresh central first — only useful when central's row is already current. |
| `POST /admin/backfill-stub-actions/:tenantId` | No (direct, `stubOnly: true`) | 1 `getMasterList` per covered session | One-off heal for stubs whose `last_action` went stale (pre-fix swallow). Re-pulls masterlist, refreshes central's `bills` row for stale stubs, then notifies. Scope with `?sessionId=`. |
| `POST /admin/fetch-missing-texts/:tenantId` | Yes, `forceMetadata: true` | 1 `getBill` per bill missing R2 text | Heal text gaps. |
| `POST /admin/reingest-bill/:billId` | Yes | 1 `getBill` | Single-bill refresh through the unified path. |
| `POST /admin/reingest-tenant/:tenantId` | Yes (dry-run by default; `?confirm=true` to fire) | 1 `getBill` per matched bill | Bulk tenant backfill. |
| `POST /tenants/promote-bill/:tenantId/:billId` | Yes, `forceAI: true` | 1 `getBill` | Manually add a bill: sets `match_type='manual'` and forces AI. |
| Bulk seed (`scripts/seed-legiscan.ts --from-dir`) | Yes, `skipFetch: true` | 0 | Seed central D1 from LegiScan bulk JSON dump. |

---

## Things to grep when this gets out of date

- **Cron logic**: `central/src/cron/sync-legiscan.ts` (`runFullPass`, `runRawPass`)
- **Ingestor**: `central/src/queue/processor-legiscan.ts` (`processLsBill`)
- **Cadence**: `central/src/lib/sync-schedule.ts`
- **Change detection**: `central/src/lib/detect-changes.ts`
- **Tenant consumer**: `api/src/queue/processor.ts` (`processCentralNotification`)
- **Central bill detail API**: `central/src/routes/bills-legiscan.ts`
- **Tenant bill detail API**: `api/src/routes/billsApi.ts` (`buildBillDetail`)
- **Schemas**: `central/src/db/schema-legiscan.ts`, `api/src/db/schema.ts`
