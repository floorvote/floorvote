# Direct sources and the shared legislative model

Status: **proposal**. This page describes a model to settle with the maintainers before more sources land, and the stacked draft PRs that try it out on three legislatures.

## Why

FloorVote reads almost all of its legislative data from LegiScan. That has two costs:

- **Access.** LegiScan's free tier fell from 30,000 to 10,000 calls a month on October 1, 2026, and its paid tiers are priced for heavy users.
- **Depth.** LegiScan normalizes every legislature into one shape, and that shape is thinner than many official feeds:
  - DC's LIMS feed carries reprogrammings, grant budget modifications, hearing notices, Mayoral and Congressional review deadlines, and committee prints. LegiScan has none of them.
  - Maryland publishes hearing times, subject codes and statute citations.
  - Virginia publishes committee and subcommittee dockets, and per-member votes keyed to each history entry.

The goal is to cover all 50 states, DC and the territories without depending on one vendor. Where an official feed is good, FloorVote reads it directly. Elsewhere it keeps LegiScan, or adds another aggregator such as OpenStates bulk data. Each of these is just another *source*.

DC is the first direct source (#206). It works by imitating LegiScan:
- LIMS records are mapped into LegiScan's `getBill` shape.
- Their ids are offset into ranges LegiScan never reaches, and the range is how the code tells the two apart.
- DC's hearings, committees, staff directory and membership history live in DC-only tables (the `council_*` tables in the stacked drafts).

That works for one source. It does not scale to fifty, and review on #206 asked for three things first:

1. Hearings without a bill, committees, and members who change over time are shared concepts that any state can fill.
2. Every row records which source wrote it.
3. Labels and explainers ship with the data instead of living in the UI.

## The three cases

| | DC (LIMS) | Maryland (MGA) | Virginia (LIS) |
|---|---|---|---|
| Access | REST API, key required | One JSON file per session, no key | CSV files per session, no key; REST API with a registered key |
| Bill list | `BulkData`, one call per category | `/{YYYY}RS/misc/billsmasterlist/legislation.json`, about 2,700 records, 8 MB | `BILLS.CSV` plus `HISTORY.CSV`, `Sponsors.csv`, `Summaries.csv` and others, about 16 MB per session |
| Change signal | None; hash each record | ETag (`If-None-Match` returns 304); hash each record | ETag per file; hash each record |
| Detail | `LegislationDetails`, one call per bill | None needed; everything is in the list | None needed; everything is in the CSVs |
| History | Full, with documents | Milestones only: first reading, hearing, report, 2nd and 3rd reading for each chamber | Full, with a reference id that keys votes |
| Text | Download URL per document | PDFs at predictable paths (`/{YYYY}RS/bills/hb/hb0001F.pdf`; F, T, E versions) | Document ids only; text needs the API |
| Fiscal notes | Fiscal impact statements | One PDF per bill at a predictable path | `FiscalImpactStatements.csv`, with URLs |
| Votes | Per member, on floor readings | PDFs only (not in this round) | Per member, floor and committee (`VOTE.CSV`) |
| Hearings | Hearings calendar API, with bills and without | Hearing date and time per chamber in the bill record; meetings pages are HTML | Committee and subcommittee dockets (`DOCKET.CSV`, `SUBDOCKET.CSV`); meetings via the API |
| Members | Member ids, terms per Council Period | Names only ("Delegate Crosby") | Member ids (`H0173`) |
| Status | 16 named statuses (Under Congressional Review, Deemed Approved, …) | Free text: the last action (1,134 distinct values in 2026RS) | Flags: passed each chamber, passed, failed, carried over, approved, vetoed |
| Sessions | Two-year Council Periods | Annual (`2026RS`), plus specials (`2021S1`); numbers reset each year | Annual codes (`20261`, `20262` special, `20271`); numbers continue across the two-year cycle; carried-over bills reappear in the next session |

Every one of these is a snapshot without a modified-since filter. A source therefore stores each raw record and its hash, and the hash comparison is the change signal.

## The model

### Bills keep LegiScan's shape

A source turns its records into the two shapes central already ingests:
- `MasterListEntry`, for the sync: keyword matching, change gating, monitor stubs.
- `LegiscanBill`, for the ingestor.

This keeps `ingestLsBill`, which holds the change detection and every child-table write, as the single ingest path. A FloorVote-owned bill type would duplicate it, and the three cases fit the existing shape:

| Case | Where it goes |
|---|---|
| Maryland's free-text status | A per-source status code read from the structured fields, with the raw text as the last action |
| Maryland's chapter number | The status: a chapter means enacted, and the Status text says how |
| Maryland's emergency flag, statute citations and constitutional amendment flag | Kept in the stored record, not shown yet |
| Virginia's carried-over bills | A related-bill link of type "Carry Over", as LegiScan does |
| Virginia's per-member votes | The roll call's member votes, which the shape already carries for LIMS |
| DC's deadlines | Calendar entries of type Deadline, as #206 already does |

The bill shape can grow fields when a source needs them; that is a smaller change than a second ingest path.

### Every row records its source

`bills`, `sessions` and `people` gain `source TEXT NOT NULL DEFAULT 'legiscan'`. Existing LIMS rows are backfilled to `'lims'`.

- The tables under a bill (`bill_history`, `bill_texts`, `roll_calls`, …) don't need the column: one source writes a bill and everything under it.
- Code that needs to know where a bill came from reads the column. It no longer tests id ranges.
- Tenants keep addressing bills as `legiscan:<int>` for now. The prefix now means "central bill id", and renaming it touches about fifteen parse sites across tenant and web for no change in behavior. That can be its own PR later.

### Ids come from one table

Central ids stay integers, because tenants and every child table use them. New sources get them from one table:

```sql
source_ids(id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, kind TEXT, native_key TEXT,
           UNIQUE (source, kind, native_key))
```

- `kind` is bill, session, person, doc or rollcall.
- `native_key` is the source's own key: `2026RS/HB0001`, `20261/HB1`, `20261/H0173`.
- A placeholder row starts the sequence above 3,000,000,000, clear of LegiScan's ids (in the millions) and the LIMS ranges (1e9 to 3e9).

Packing ids arithmetically, as LIMS does, means designing a collision-free scheme for every source. It can't encode string keys such as Maryland's sponsor names, and a record it can't encode is silently skipped. The LIMS ids already in production stay as they are.

Subject ids are the one exception: Maryland's subjects carry short codes, not records, and their ids are a hash of the code.

### Raw records are stored per source, in one table

`source_records(bill_id, source, native_key, session_id, raw_json, raw_hash, details_fetched_at, updated_at)` holds each source's raw record and the hash the sync compares. It replaces `lims_records`, so each new source doesn't add a raw table of its own.

### Committees, memberships and events are shared

| Table | Columns |
|---|---|
| `committees` | `committee_id, source, state, kind (chamber, committee, subcommittee, office), parent_id, name, slug, url, valid_from, valid_to, detail_json` |
| `memberships` | `id, source, committee_id, people_id (nullable), name, role (member, chair, vice_chair, staff), title, email, phone, valid_from, valid_to (null while current)` |
| `events` | `id, source, state, session_id, native_id, uid, date, time, event_type, title, committee_id, joint_with, location, url, detail_json, event_hash, removed_at, updated_at`; unique on `(source, native_id)` |
| `event_items` | `event_id, seq, topic, bill_id (nullable), bill_number` |
| `roster_changes` | today's `council_changes`, with a `source` column |

Notes:
- **`committees`** replaces the empty LegiScan table of the same name, and `bill_referrals.committee_id` starts pointing at real rows.
- **`memberships`** puts membership over time in rows rather than JSON snapshots, so "who chaired Judiciary in March 2025" is one query.
- **`events`** holds a hearing whether or not it has bills. `event_items` links an agenda item to a bill when the source names one.
- **`roster_changes`** keeps the list of roster changes the People page shows.

How each case fills these tables:
- **DC:** the `council_*` tables move into them; the dccouncil.gov scrape keeps filling staff memberships.
- **Maryland:** hearings come from the hearing date and time fields.
- **Virginia:** hearings come from the docket files, with committee and subcommittee rows from `Committees.csv`.

Bill-bound calendar entries stay in `bill_calendar`, because tenants already consume them.

### Labels ship from central

Each source already declares its status labels in code (`statusLabels`), and central labels a bill by its source. The shared-model PR widens this, so each source declares:
- status codes, bill types and event types, each with a label;
- an optional plain-language explainer;
- for statuses, a common stage (introduced, in committee, passed one chamber, passed, enacted, vetoed, failed), so a team covering several states can filter across them.

Central serves them at `GET /bills/labels?state=XX`, together with a little display metadata: the calendar's name ("DC Council hearings"), whether the state has events, and whether it has a directory. The web app reads these instead of testing `state === 'DC'`.

They live in code rather than a table because they change only when the source's code changes, and they're reviewed with it. If labels ever need editing without a deploy, a table can replace the code behind the same endpoint.

### A source is a module

```ts
interface DirectSource {
  id: string                                   // 'lims', 'mga', 'lis'; stored in `source`
  states: readonly string[]
  enabled(env): boolean
  ingestQueue?(env): Queue                     // for sources that can't take concurrent calls
  syncSessions(env, db, ctx): Promise<SessionRow[]>          // refresh when due, return the ones to sync
  snapshot(session, env, db, ctx): Promise<SourceRecord[]>  // { billId, nativeKey, raw, hash }
  toEntry(record, stored, ctx): Promise<MasterListEntry>
  buildBill(billId, env, db): Promise<LegiscanBill>
  detailsRefresh?: { maxAge, perPass, settledStatuses }     // LIMS: details change while the list record doesn't
  statusLabels: Record<number, string>
  // Added by the shared-model PR: events?(), organizations?(), and labels beyond statuses.
}
```

A registry lists the sources. Central asks it which source owns a state or a bill, instead of testing id ranges.

One generic sync runs every enabled source, each in its own job:
1. Find the tenants covering its states.
2. Apply the cutover guard (below).
3. Pick the current and prior sessions.
4. Take the snapshot, compare hashes against `source_records`, and hand changed records to the same `applyMasterList` LegiScan uses.

What's specific to a legislature stays in its module. For DC that is Council Periods, LIMS categories, the dccouncil.gov directory and the hearings feed.

### Moving a state off LegiScan

When a state switches from LegiScan to a direct source, tenants that already track its LegiScan bills would otherwise see every bill twice and pay for AI on both copies. The sync therefore refuses to run a direct source for a state while tenant links to that state's LegiScan bills remain, and says so in the job log. #206 does this for DC. This proposal makes it per state.

The guard counts monitor links too, since every covering tenant gets a monitor link for every bill in its states. It counts only sessions the direct source syncs: a LegiScan session that ended before them stays as it is, frozen, since the LegiScan sync no longer covers the state.

`POST /api/admin/sources/:id/cutover` moves a state over:

1. **Plan** (a dry run unless `?confirm=true`). It refreshes the source's sessions and stores their records, which tenants never see. Then it matches each linked LegiScan bill to the source's bill with the same year, kind of session (regular or special) and number, compared without padding. It reports matched links, unmatched monitor links, and unmatched tracked links.
2. **Tenants.** Each tenant points its own bills at the new ids, over a new `rekeyBills` RPC. A tenant stores central ids only in `bills.external_id`, so its positions, notes, votes and analyses stay with the bill. A tenant with no service binding is left alone and reported.
3. **Central.** It moves the links and drops unmatched monitor links. Unmatched tracked links stay unless `?dropUnmatched=true`, and while any remain the sync stays paused.
4. **Sync.** The source's sync then runs. Its pass creates the new bills and queues every tracked one for ingest, so tenants refetch them. A tenant's AI runs again on a moved bill when the new source's text differs from LegiScan's.

## How the other states follow

For each state, in order of preference:

1. **A direct source** when the official feed is machine-readable and richer than LegiScan. Writing one means:
   - one module implementing the interface above;
   - fixtures recorded from the live feed;
   - a mapping test.

   No pipeline, tenant or web change. Maryland's module is about 550 lines, and 870 with its tests; Virginia's is about 660, and 910 with its tests.
2. **An aggregator source** when it isn't. LegiScan stays available. OpenStates bulk data or a self-hosted OpenStates scraper fits the same interface: OpenStates' Bill, Event, Organization and Membership models map closely onto the shared tables, though it has no provenance or labels.

The work for a state is the module, nothing else. That is the test of whether this model is right.

## The PRs

Each is a draft stacked on the previous one, starting from #206.

| # | PR | What |
|---|---|---|
| 1 | This document | The proposal |
| 2 | Source registry | `source` columns, `source_ids`, `source_records`, LIMS as the first module, status labels from the module. No behavior change. |
| 3 | Generic sync | Pulled out of `sync-lims.ts` |
| 4 | Maryland | Bills |
| 5 | Virginia | Bills, from the CSVs |
| 6 | Shared model | `committees`, `memberships`, `events`, `event_items`, `roster_changes`, the labels endpoint; DC's calendar and directory move onto them (replacing #217 and #218); Maryland hearings; Virginia dockets |
| 7 | Tenant and web | Read events and labels from central; remove the `state === 'DC'` gates |

## What the Worker limits taught

- **Memory.** A Worker has 128 MB. Virginia's 2026 files are about 16 MB of text. A parser that builds fields a character at a time needed over 200 MB to assemble them; cutting fields with `slice`, streaming rows, folding in one file at a time, and storing each vote as one compact string brings the whole session in under a 64 MB heap.
- **Queries.** D1 allows about 1,000 queries per Worker invocation. Virginia's budget bill has more than 4,600 member votes, so the ingestor writes a bill's member votes as one batch of multi-row inserts.
- **Change signals.** A field that moves on every regeneration (Maryland's file timestamp) must stay out of the record's hash, or every bill reads as changed on every pass.

## Open questions

- **Carried-over Virginia bills.** Should a bill carried over from 2026 be the same FloorVote bill in 2027, or a new bill linked to the old one? This proposal follows LegiScan (new bill, linked), so a team's positions and notes don't move automatically.
- **Virginia's API terms** say "personal and non-commercial use only". Until that is clarified with DLAS, the Virginia module reads only the public CSVs, and Virginia bills have no text.
- **Maryland votes and amendments** are published only as HTML pages and PDFs. They are left out until someone needs them.
- **The tenant id prefix.** `legiscan:<int>` could become a neutral prefix in a later PR.
