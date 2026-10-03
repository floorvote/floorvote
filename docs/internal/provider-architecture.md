# Provider Architecture

How FloorVote takes legislative data from more than one source.

Written while reviewing [PR #206](https://github.com/floorvote/floorvote/pull/206) (DC Council LIMS). These are decisions, not yet code. Each one says what we chose and why.

---

## The problem

LegiScan covers all 50 states. Some states publish better data themselves. DC's LIMS carries hearings, per-member votes, committee reports, deadlines, and DC's own status names. LegiScan carries none of that for DC.

We want three things:

- A state can be fed by a better local source.
- Outside contributors can add a source for their state.
- Nothing breaks for deployments that only use LegiScan.

---

## Decision 1: One shared central, not one per provider

**Choose:** all providers write to the same central worker and the same D1.

We already tried the other way. `central/src/index.ts` plus `central-bills` plus `migrations/` is a complete second central, built for OpenStates. It rotted. Two schemas and two migration trees is a tax nobody pays twice.

Separate centrals also decide ownership per *tenant*, not per state. A tenant covering two states would have to pick one provider for both, and a multi-state team needs a different source per state.

For contributors this is not close. With separate centrals, adding a source means building a worker, a D1, migrations, queues, a dashboard, and tenant registration. With a shared central it means writing one adapter directory.

---

## Decision 2: One canonical model, and it already exists

**Choose:** every provider maps into the shape the ingestor already takes. Rename it `CentralMeasure`.

Today that shape is called `LegiscanBill`. The name makes it look provider-specific. It is not. It describes a measure moving through a body, with text versions, actions, sponsors, votes, and scheduled events.

PR #206's first 11 commits prove it works: 3,400 lines, and no changes to tenant or web code for the data path.

How well DC fit:

| Mapped | Fit |
|---|---|
| hearings, mark-ups → `bill_calendar` | natural |
| committee prints → texts; reports, notices, memos → supplements | natural |
| per-member votes → `roll_call_votes` | natural, the table existed |
| DC's 16 statuses → codes 100+ | extension, not distortion |
| `body:'C'`, `chamber:'C'` | dead weight, DC is unicameral |
| reprogrammings, budget mods → `bills` rows | the one real mismatch |

**Rejected:** a wide table per provider, with the UI reading a set of shared columns. That set of shared columns *is* a canonical model. The only choice is whether it is explicit and type-checked, or implicit and discovered in production. Everything downstream is cross-provider: keyword matching, AI analysis, positions, change detection, digests, exports, and sorting.

**Also:** the canonical noun is a **measure**, not a bill. A reprogramming has a number, a status, a history, and documents. Calling it a measure fixes the mismatch with no schema change.

---

## Decision 3: Isolate at the queue, share at the database

**Choose:** a provider may have its own ingestor queue. It does not get its own tables.

PR #206 does this. `LIMS_INGESTOR_QUEUE` runs at `max_concurrency = 1` because LIMS returns 429 above about two concurrent requests. Different rate limits are a real reason to separate. A different schema is not.

---

## Decision 4: State ownership lives in a table, not an env var

**Choose:** one row per state. The primary key does the enforcing.

```sql
CREATE TABLE state_sources (
  state           TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  status          TEXT NOT NULL,   -- 'active' | 'migrating'
  migrating_from  TEXT,
  claimed_at      TEXT NOT NULL
);
```

Each sync asks which states it owns. Two providers cannot both own DC, because there is one row.

Today it is `LIMS_STATES=DC`. That fails badly. `runLsSync` drops DC for every tenant, and if any tenant still has DC LegiScan links, the LIMS guard throws. DC then syncs from neither source, silently, for everyone.

Claiming is an explicit action: `POST /api/admin/state-source { state, provider }`.

- **409** if another provider owns the state and has live tenant links. Names the owner, the bill count, and the tenants.
- **200** if unclaimed, or owned with no links.
- **`cutover: true`** is the only way past the 409. That flag is the choice, made once, by a person.

---

## Decision 5: Cut over by alias, never by rewrite

**Choose:** add a lookup row in central. Do not touch tenant databases.

Every new state-specific provider replaces LegiScan for that state. So cutover is the normal path. It has to be boring.

```sql
CREATE TABLE bill_aliases (
  external_key TEXT PRIMARY KEY,   -- 'legiscan:2119001', what tenants already hold
  bill_id      INTEGER NOT NULL    -- the new provider's row
);
```

Steps:

1. Set `status='migrating'`. Both syncs pause that state.
2. Run the new provider's first full pass.
3. Match old to new on the natural key (Decision 6).
4. Insert one alias per match. Move `bill_tenants` links.
5. Report unmatched bills on both sides. Do not auto-resolve.
6. Set `status='active'` under the new provider.

Tenant databases never change. Positions, notes, and AI analysis hang off the tenant's own row. Reversible by deleting the aliases.

The `legiscan:` token becomes an opaque handle that central resolves. The eight files that parse it stop needing to know what a provider is.

---

## Decision 6: Sessions need a unique natural key

**Choose:** `UNIQUE (state, slug)` on `sessions`.

This is a live bug in PR #206. `sessionToSlug` takes the leading year span:

- LegiScan `"2025-2026 Regular Session"` → `2025-2026`
- LIMS `"2025-2026 Council Period 26"` → `2025-2026`

The canonical resolver takes the first row that matches ([lookupRoutes.ts:19](../../api/src/routes/billsApi/lookupRoutes.ts)). If a tenant holds `B26-0400` from both providers, `/DC/2025-2026/B26-0400` resolves to whichever row D1 returns first.

Two more leaks:

- `/bills/sessions?state=DC` returns both sessions, and the list is cached in `association_config`.
- `sineDie` is never set on an ended Council Period by the scheduled sync.

A unique constraint turns this into a loud insert failure instead of a wrong bill page.

---

## Decision 7: Vocabulary travels with the data

**Choose:** each provider owns one vocabulary file. Central ships the label, sort rank, terminal flag, and explainer with each measure. The UI keeps no maps.

`bills.status` passes through four hand-kept vocabularies today:

| # | Site | Keyed on | Fixed by #206? |
|---|---|---|---|
| 1 | `central/src/routes/bills-legiscan.ts:10` | int → label | yes |
| 2 | `central/src/lib/detect-changes.ts:37` | int → label | yes |
| 3 | `api/src/routes/billsApi/query.ts:193` | SQL `CASE`, mixed | no → `ELSE 0` |
| 4 | `web/src/lib/legislativeStatus.ts:3` | OpenStates strings | no → pass-through |

PR #206's later commits add a fifth: DC explainers in `shared/dcLegislation.ts`, shown through `state === 'DC'` branches in `BillDetail`. And a sixth: `SETTLED_STATUSES` in `sync-lims.ts`, which is wrong for `Deemed Approved`.

Instead, the provider's vocabulary file holds everything:

```ts
// providers/lims/vocabulary.ts
STATUSES = {
  117: { label: 'Deemed Approved', rank: 88, terminal: false, explainer: '…' },
  …
}
TYPES = {
  'Emergency Bill': { label: 'Emergency act', explainer: '…' },
  …
}
```

Central ships it with the measure:

```jsonc
{
  "status": 117,
  "statusLabel": "Deemed Approved",
  "statusRank": 88,
  "statusTerminal": false,
  "statusExplainer": "…",
  "typeLabel": "Emergency act",
  "typeExplainer": "…"
}
```

- The web renders `statusLabel` and shows `statusExplainer` as a tooltip. No `state === 'DC'` branch.
- Sorting uses `ORDER BY status_rank`.
- The details refresh skips measures where `statusTerminal` is true. This replaces `SETTLED_STATUSES`.
- Josh's DC explainer text is good. It moves into the LIMS vocabulary file unchanged.

**Rule:** any field a provider can extend carries its own label, sort key, and explanation.

---

## Decision 8: Adapters add data, not UI

**Choose:** providers fill canonical tables and declare what they support. Core builds each UI feature once, for every provider.

```sql
bill_extras(bill_id, provider, key, label, value_json)
```

`bill_extras` is the overflow. It renders in one generic panel: "Additional information from *provider*". An adapter author who hits something that does not fit has somewhere to put it.

The contract for contributors:

> If your source has a thing with an identifier, a jurisdiction and session, a status that changes over time, and documents or actions attached, it is a **measure**. Map it into `CentralMeasure`. If it is a meeting or hearing, map it into a body event (Decision 12). Put everything else in `bill_extras`.
>
> Supply a vocabulary file (Decision 7). Declare your capabilities (Decision 11).
>
> **An adapter PR may not add a UI component.**
>
> An undocumented endpoint is allowed only if it fails closed: an error, an unexpected shape, or an empty result changes nothing.

PR #206's later commits break this rule, but in a useful way. The settings page, deadline chips, and explainer tooltips are good features. They should be core features that any provider can feed, not DC branches.

Other cases:

- **Per-member votes.** Not DC-specific. LegiScan has them behind `getRollCall`. Build the display once. `roll_call_votes` is written today and never read.
- **Mayoral review, Congressional review, withdrawn-by, video links.** LIMS returns them. The mapper drops them. They belong in `bill_extras`.

---

## Decision 9: Fix the inverted names

**Choose:** the maintained path takes the bare names. The vestigial one takes the suffix.

| OpenStates (vestigial) | LegiScan (active) |
|---|---|
| `index.ts`, `types.ts` | `index-legiscan.ts`, `types-legiscan.ts` |
| `db/schema.ts`, `migrations/` | `db/schema-legiscan.ts`, `migrations-legiscan/` |
| `cron/sync.ts`, `keywordSweep.ts` | `cron/sync-legiscan.ts` |
| `queue/processor.ts` | `queue/processor-legiscan.ts` |
| `routes/{bills,tenants,admin,stats}.ts` | `routes/{bills,tenants,admin}-legiscan.ts` |

Only `routes/health.ts` and `lib/*` are shared.

**Rename:** bare → `*-openstates`; `-legiscan` → bare; `LegiscanBill` → `CentralMeasure`; `MasterListEntry` → `SyncEntry`; `LsEnv`/`LsDb` → `Env`/`Db`; `ingestLsBill` → `ingestMeasure`.

**Do not rename.** These are data, not code: R2 keys `bills/legiscan-<id>/…`, tenant `external_id` tokens, the D1 name `central-bills-ls`, and the wrangler env `legiscan`.

OpenStates stays. It is vestigial, not dead.

---

## Decision 10: Seeding uses the same write path as syncing

**Choose:** a bulk seeder is a provider that reads from disk instead of HTTP.

`scripts/seed-legiscan.ts --from-dir` bypasses the ingestor. It writes SQL through `scripts/lib/build-bill-statements.ts`. That is a second way to turn a bill into rows, and the two already drift.

A seeder should produce `SyncEntry[]` and `CentralMeasure[]` and call the same `applyMasterList` and `ingestMeasure`.

**DC needs no bulk file.** The zip exists only to dodge LegiScan's 10,000 calls a month. LIMS has no quota: 7 calls load all 2,207 CP26 measures.

---

## Decision 11: Every provider row says which provider wrote it

**Choose:** a `provider` and a `state` column on every central table a provider writes: `bills`, `sessions`, and `body_events`. Tenants see capabilities per state.

Today the ingestor picks a provider by id range (`isLimsBillId`). That works for two providers. At four it is a registry of magic numbers. Id ranges stay, but only as a way to mint ids. Routing reads `bills.provider`.

PR #206's `council_events` table has neither column. Its route serves DC data to every tenant.

Tenants gate features on capability, not state:

```jsonc
// GET /config
"sources": { "DC": { "provider": "lims", "bodyEvents": true, "deadlines": true } }
```

Today the DC settings page shows for any tenant covering DC, even when DC comes from LegiScan. That tenant can save rules and will never get an event.

---

## Decision 12: Events without a measure are first-class

**Choose:** a canonical body event, linked to zero or more measures. Built in PR B.

Most of what a DC team prepares for has no bill: oversight hearings, budget hearings, roundtables, and legislative meetings. PR #206's later commits proved the need. This is not DC-specific. Every legislature has committee meetings, and OpenStates has an events API.

```sql
CREATE TABLE body_events (
  event_id         INTEGER PRIMARY KEY,
  provider         TEXT NOT NULL,
  state            TEXT NOT NULL,
  source_event_id  TEXT NOT NULL,   -- the provider's own id, e.g. LIMS hearingId
  kind             TEXT NOT NULL,   -- Decision 13
  date             TEXT NOT NULL,
  time             TEXT,
  timezone         TEXT NOT NULL,
  committee        TEXT,
  joint_with       TEXT,
  location         TEXT,
  title            TEXT NOT NULL,
  agenda_json      TEXT NOT NULL,
  url              TEXT,
  event_hash       TEXT NOT NULL,
  cancelled_at     TEXT,
  UNIQUE (provider, source_event_id)
);
CREATE TABLE body_event_measures (event_id INTEGER, bill_id INTEGER, PRIMARY KEY (event_id, bill_id));
```

**Central links, not tenants.** A real hearing often shows up twice: as a line in the bill's history and as a calendar event with the bill on its agenda. Today each tenant dedups by date and bill number. Central should do it once: link the agenda item to the measure, and mark the bill calendar entry as covered by the body event.

**Tenant rules are generic.** Committees, kinds, keywords, and tracked measures work for any state. The committee and kind lists come from central data, not a hardcoded file. Topic presets ("public safety", "education") are tenant content.

---

## Decision 13: Calendar entries have a kind, a stable identity, and careful removal

**Choose:** three rules for every calendar entry, bill-level or body-level. PR A must follow them.

**Kind is explicit.** `hearing | markup | meeting | deadline`. Central sets it. Tenants never parse identity keys.

`deadline` is canonical, not DC. Many states have a governor's signing deadline. PR #206 uses a magic type id (`DEADLINE_CALENDAR_TYPE_ID = 10`) in `shared/dcLegislation.ts`, and the tenant detects it by the prefix of the identity key.

**Identity is stable.** Use the provider's own event id when it has one. Otherwise use kind, date, and a normalized description. Never a position-based ordinal.

This fixes the ordinal bug in `lims-map.ts:412`, where cancelling one hearing renumbers the others.

**Absence is not cancellation.** Mark an event cancelled only on positive evidence: a cancellation notice tied to that event, or a removed flag from the source. Or after it is missing from two successful pulls in a row. An empty response is never evidence.

Never hard-delete a synced event. Cancel it, and keep the ICS `SEQUENCE` increasing.

This fixes three PR #206 bugs: the date-only cancellation match, the empty-month mass removal, and the hard delete that resets `SEQUENCE`.

---

## Plan

We build on PR #206 on our own branch. We do not push to Josh's PR branches; the contributor's team runs production from a separate branch on the same fork.

**Step 1: the rename (Decision 9).** Its own PR, landed on main first. Mechanical, no behavior change. Then rebase our branch.

**Step 2: PR A, DC LIMS as a data source.**

- Josh's first 11 commits
- The deadline mapping and the bill type fix from his later commits
- Blocking fixes: sponsors and the session slug (Decision 6)
- Decision 7: the LIMS vocabulary file, with Josh's explainers
- Decision 11: `provider` and `state` columns
- Decision 13: kind, identity, and removal rules

**Step 3: PR B, body events.**

- Decision 12: `body_events`, central linking, and generic tenant rules
- The core UI once: event settings, deadline chips, explainer tooltips
- Josh's calendar commits are the design reference

**Later:**

- Decisions 4 and 5, ownership and cutover, before a second state-specific provider
- Decision 8's `bill_extras`, before we invite outside adapters
- Decision 10, the seed path, whenever it next hurts

---

## PR #206 findings

**Blocking, fixed in PR A:**

- `central/src/cron/sync-lims.ts:172`: only current-period Councilmembers are fetched. Prior-period and imported bills lose sponsors who left. Silent.
- Session slug collision (Decision 6).

**Fixed by Decisions 7 and 13, in PR A:**

- `central/src/lib/lims-map.ts:412`: positional ordinal on calendar descriptions.
- `central/src/lib/lims-map.ts:390`: cancellations match on date alone.
- `central/src/cron/sync-lims.ts:41`: `Deemed Approved` and `Approved` treated as settled.

**Fixed by the rebuild, in PR B:**

- `api/src/routes/councilCalendarAdmin.ts:67`: if the cleanup sync fails when rules are cleared, the rules row is deleted anyway and the old events stay forever.
- `central/src/cron/sync-lims.ts:456`: a `200` with an empty list marks every event that month removed.
- `api/src/lib/councilCalendar.ts:215`: hard deletes reset `SEQUENCE` to 0.
- `web/src/pages/admin/Config.tsx:67`: the DC settings page shows by state, not by source.

**Minor:** `isLimsDocId` is exported but never called outside tests.

---

## Testing

**Safe on the real central.** Set `LIMS_API_KEY`. Leave `LIMS_STATES` unset.

```bash
curl -X POST -H "x-admin-secret: $ADMIN_SECRET" -H 'content-type: application/json' \
  -d '{"tenantId":"<staging>","numbers":["B26-0400"]}' \
  https://<central>/api/admin/lims-import
```

`importLimsMeasures` does not read `LIMS_STATES` and never hits the cutover guard. Blast radius: one bill, one session row, about 13 people rows, one tenant.

Pick a measure the staging tenant does **not** already track, or the slug collision makes its URL a coin flip.

**Not safe.** `LIMS_STATES=DC` on a shared central is global. LegiScan drops DC for every tenant, and all 2,207 measures are keyword-matched against every tenant covering DC or `*`.

**For a full sync**, use a throwaway central with its own D1.

---

## Verified facts

- LIMS documents are public PDFs, no key. `GET .../B26-0400-Introduction.pdf?Id=224385` returns `200`, `application/pdf`, 136,657 bytes.
- One DC bill carried 16 documents. LegiScan gives roughly the introduced text.
- LegiScan's quota is 10,000 calls a month, down from 30,000 on October 1, 2026.
- The Council hearing calendar feed (`lims.dccouncil.gov/Hearings/API/Public/GetHearingsCalendar`) is not part of the documented LIMS API and needs no key.

---

## Open questions

1. Does DC need history before Council Period 25?
2. Should `sessionToSlug` disambiguate automatically, or should the slug be stored on the session row?
3. Is `statusRank` one scale for all providers, or per provider?
4. LIMS's rate limit, whether documents are immutable per `?Id=`, and any attribution requirements are unverified.
5. Is the undocumented hearing calendar feed stable enough to depend on? Can we get the Council to document it?
