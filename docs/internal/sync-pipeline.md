# Sync Architecture (LegiScan path)

Canonical, code-grounded description of how legislative data flows from LegiScan into tenant DBs. Update this file whenever the pipeline changes. The visual companion is [`architecture.html`](../content/public/internal/architecture.html), served at `floorvote.org/docs/internal/architecture.html` — keep both in sync, but treat this file as the source of truth.

> **Scope:** the LegiScan central env (`floorvote-central-legiscan`), the only central.

---

## Pipeline at a glance

```
LegiScan API  →  central cron  →  central ingestor queue  →  per-tenant queue  →  tenant D1
                  (Phase 1)        (Phase 2)                  (Phase 3a)         (Phase 3b)
```

Three queue boundaries. LegiScan API quota is **10,000 calls/month total** (reduced from 30,000 on October 1, 2026). Calls happen only in Phases 1 and 2 — the cron polls masterlist endpoints, the ingestor calls `getBill` once per queued bill. Phase 3 is internal data movement, zero API cost.

### Where LegiScan sits

LegiScan is the default **provider** (`central/src/providers/legiscan/`). Core (the cron and the ingestor) decides what to fetch and when, and writes the results. The provider calls the API and maps each response into the shapes in `central/src/providers/types.ts`. Each provider method maps to one LegiScan op, logged to `api_call_log` under the op's name:

| Provider method | LegiScan op | Called from |
|---|---|---|
| `listSessions` | `getSessionList` | Cron, once a day at 5 ET |
| `listMeasures` | `getMasterList?id=` (logged as `getMasterListBySession`) | Cron full pass; `backfill-stub-actions` |
| `listChangeHashes` (optional) | `getMasterListRaw` | Cron raw pass. A provider without it skips raw-pass hours. |
| `fetchMeasure` | `getBill` | Ingestor |
| `fetchDocument` (optional) | `getBillText` | Ingestor, on both the normal and `skipFetch` paths, only when a text's `state_link` fails or selects its version with a URL fragment the server never sees |
| `listVoteDatasets` (optional) | `getDatasetList` | Cron, once a day at 3 ET, for states with a session due its weekly vote check ([legiscan-member-votes.md](legiscan-member-votes.md)) |
| `fetchVoteDataset` (optional) | `getDatasetRaw` | Ingestor, for a `vote-dataset` message, when a session's dataset hash changed |

Two things hold the split. ESLint (`central/eslint-provider-boundary.mjs`) lets core reach the provider only through the registry (`central/src/providers/index.ts`), and lets provider code reach core only through `central/src/providers/sdk.ts`. And a provider's `ctx.env` holds only the env keys it declares (LegiScan's is `LEGISCAN_API_KEY`), so it never gets the database, buckets, or queues.

### Snapshot providers (DC, Maryland, Virginia)

Three opt-in providers read a legislature's own feed: DC Council LIMS (`providers/lims/`), the Maryland General Assembly's open data (`providers/mga/`), and Virginia's LIS data files (`providers/lis/`). Each syncs only the states it owns in the state ownership table (below). Then the LegiScan sync and the weekly vote-dataset check leave those states alone.

None of these feeds has a modified-since filter, so each is read as a snapshot by its own hourly job (`central/src/cron/sync-snapshots.ts`):

1. **Sessions.** At 5 ET, or whenever none of the provider's stored sessions would sync, core calls `listSessions` and upserts what it returns. A session the provider no longer lists stops being current. A provider with `listPeople` then returns its legislators, and core upserts them. `selectSessions` picks which stored sessions to sync.
2. **Full pass.** In a session's full-pass hours, `snapshot` returns every record with a hash. A provider whose feed answers conditional requests (Maryland) also gets the ETag of the last snapshot a pass finished (`sessions.snapshot_etag`, migration 0038), and may answer that nothing changed (304). That saves the download, not the pass: core runs the pass on the records it stored from the last full read, since the full pass is what links an instance that newly covers the state, re-queues a changed bill whose ingest failed, and moves links whose keywords no longer match. Core stores the new ETag only after a pass has queued and sent everything while the provider still owns the state, a forced run (`POST /admin/providers/:id/sync`) reads in full, and a claim clears the state's stored ETags in the same batch (`forgetSnapshotEtags`), so a provider that gets a state back reads its files in full. Core stores each changed record in `provider_records`, maps each record through `toEntry`, and runs the same `applyMasterList` as the LegiScan full pass. Queued bills go to the provider's `ingestQueue` binding when it is bound (LIMS: `LIMS_INGESTOR_QUEUE`), and to `INGESTOR_QUEUE` otherwise. With `detailsRefresh` (LIMS), tracked bills whose details are stale are re-queued too, unless their status is terminal in the provider's vocabulary (below).
3. **Ingest.** The ingestor routes each bill to its provider by the `provider` column of its `bills` row, and passes `fetchMeasure` the stored record and its session. LIMS also returns its LegislationDetails response, which core stores in `provider_records` beside the listed record (so a field ignored today can be mapped later without fetching it again), and records when it was fetched. The record's hash stays the listed record's.

Core does every read and write. A provider gets `ctx.ids(kind, keys)` to mint central ids from the `provider_ids` table (MGA and LIS, and LIMS for committees; LIMS packs its other ids into reserved ranges, `providers/lims/ids.ts`), `ctx.people()` for the people it has written, and `ctx.today`. Ids only identify rows. Whatever picks a provider for a bill, session, or person reads that row's `provider` column (the ingestor, the LegiScan sync's session list, the stub backfill, status labels, and sponsor links), never an id range.

### DC Council (LIMS)

DC syncs from the Council's LIMS API once an operator claims it (`POST /admin/state-providers/DC` with `{"provider":"lims"}`, which needs `LIMS_API_KEY`), or for one release from `LIMS_STATES=DC` (below). Until then DC stays on LegiScan. A session is a Council Period, tagged `CP26`. LIMS bill, session, people, and document ids are packed into reserved ranges from the measure number and LIMS's own ids (`providers/lims/ids.ts`), so a fork that already ran DC on LIMS keeps every id.

- **What it pulls.** One BulkData call per category per Council Period, for the current period and, for a year after it ends, the previous one. `LIMS_CATEGORIES` defaults to bills (1), resolutions (6), grant budget modifications (13), reprogrammings (14), and oversight hearing notices (18). Each ingest adds one LegislationDetails call. `POST /admin/lims-import` pulls named measures from any period, and answers 409 unless LIMS owns DC.
- **Sponsors across Council Periods.** After each session refresh, LIMS returns the members of every Council Period central holds DC measures in, not just the current one, so a bill keeps a sponsor who has since left the Council.
- **What maps where** (`providers/lims/map.ts`). Bulk history is the history and most of the documents. Introductions, committee prints, engrossments, enrollments, and signed acts are texts. Committee reports, hearing notices and records, memos, and other documents are supplements under their LIMS type, and a document LIMS gives no title is titled from its file name. Each floor reading's per-member votes go through `writeMemberVotes`. Hearing, mark-up, and reading videos attach to the history entries they record (`bill_history.video_url`, migration 0033), and the bill page links each one. Hearings and mark-ups go on the calendar, and an oversight hearing notice is a calendar entry of its own. So do the deadlines the Council records in the history: the Mayor's response due, the end of Congressional review, and when an emergency act or temporary law expires (event type 10, kind `deadline`). Every live calendar entry comes from the BulkData record, which the change hash covers, so a calendar recheck can trust it, and a record with no history sends no calendar at all. A hearing whose details carry a cancellation notice goes out marked cancelled (see "Bill calendar entries" below). Referrals use the Council's full committee names ("Committee on Youth Affairs", where LegislationDetails says "Youth Affairs"), each pointing at a committees row (see "Committees" below). Committees asked only for comments are an extra, not referrals.
- **Vocabulary decisions.** DC's Approved and Deemed Approved aren't terminal, so the details refresh keeps checking them. Expired is in the enacted stage, after Official Law, since what expires is mostly emergency and temporary acts that were law until their term ran out (tenant migration 0078 moved bills an instance had already staged). Not Applicable, which hearing notices carry, has no stage and is terminal.
- **Extras.** The D.C. Law, act, and resolution numbers, the Mayoral and Congressional review dates, who asked for a measure, the committees asked for comments, and the withdrawal. The bill page shows them under "Additional information from DC Council".
- **Field inventories.** `providers/lims/inventory.ts` keeps one for the BulkData record and one for the LegislationDetails response, and `test/providers/lims/map.test.ts` checks the recorded fixtures against both.
- **Fails closed.** The client (`providers/lims/client.ts`) throws on an HTTP error, a body that isn't JSON, or a shape the mapping doesn't read, including details for a different measure. A key the mapping reads must be present, though it may be null: a missing key isn't read as an empty one, so a key LIMS renames can't quietly strip every DC bill of that field. The sync stops for the hour, and the ingest retries, without writing anything from that answer. An empty list, or a null BulkData or Members answer, means nothing new, never that measures, sessions, or members went away. `test/cron/lims-provider.test.ts` covers each case at the main seam.
- **Concurrency 1.** LIMS answers 429 above about two concurrent requests. Its ingests go to `LIMS_INGESTOR_QUEUE` when that binding exists, and to `INGESTOR_QUEUE` otherwise, and both consumers run at `max_concurrency = 1` (`central/wrangler.example.toml`). The client also paces itself at one request a second.

**After deploying a LIMS mapping change, re-ingest DC's tracked bills.** A bill's extras, documents, and videos change only when the bill is next ingested, and an enacted DC bill (the ones with law numbers) is terminal, so the details refresh never re-fetches it. For each tenant covering DC:

```bash
curl -X POST "$CENTRAL/api/admin/reingest-tenant/$TENANT?provider=lims" -H "x-admin-secret: $ADMIN_SECRET"               # dry run: how many
curl -X POST "$CENTRAL/api/admin/reingest-tenant/$TENANT?provider=lims&confirm=true" -H "x-admin-secret: $ADMIN_SECRET"  # queue them
```

`?provider=lims` queues only the tenant's LIMS bills, on the LIMS queue. It spends no LegiScan calls, and one LIMS details call per bill, paced at one a second.

### Maryland (MGA)

Maryland syncs from the General Assembly's open data once an operator claims it (`POST /admin/state-providers/MD` with `{"provider":"mga"}`), or for one release from `MGA_STATES=MD`. It needs no key and spends no LegiScan calls. Until then Maryland stays on LegiScan. A session is one of the MGA's session codes, tagged `2026RS` or `2026S1`, and bill, session, people, document, and subject ids are minted from `provider_ids`.

- **What it pulls.** One JSON file per session (`{session}/misc/billsmasterlist/legislation.json`, about 8 MB, regenerated through the day), holding every bill and resolution. The session refresh sends a HEAD request for this year's regular and special sessions and next year's regular session, and a session syncs while its year is current or ahead, since the Governor signs and vetoes into late May. Each full pass reads the file with the ETag of the last one read, so an unchanged file costs a 304, and the pass runs on the stored records. An ingest builds the bill from its stored record with no further request. The record hash leaves out `StatusCurrentAsOf`, the file's timestamp, which changes on every regeneration.
- **What maps where** (`providers/mga/map.ts`). The file has no action history, so the history is rebuilt from each chamber's first reading, committee report, and second and third readings. The first, third, and enrolled readers are texts, and every bill and joint resolution has its fiscal and policy note as a supplement, at paths built from the bill number. Each hearing time goes on the calendar as a Hearing (kind `hearing`), one for each chamber's primary and secondary committee, described by chamber and committee. The MGA publishes no event ids, but each hearing has a fixed slot in the record, so the slot is its `event_id` (`2026RS/SB0002/S/primary`), and a hearing the committee moves reads as changed rather than cancelled and added again. An emptied slot isn't positive evidence of a cancellation, since the file doesn't say that hearing was cancelled, so the hearing is cancelled after two pulls that leave it out (the second usually a recheck). Referrals carry committee ids from `provider_ids`, keyed by chamber and name (each chamber has its own Rules committee), and the measure names the committee a bill waits in. Cross-files are related bills. Broad subjects and narrow index terms map to subjects, without the printed index's "-see also-" cross-references. Sponsors are names only ("Delegate Crosby"), each minted one person id by name, so a member keeps one id across bills and sessions. A chair, officer, or delegation sponsor keeps its whole name, and its id is per session, since different people hold the office over time.
- **Statuses.** The file's Status is the last action as free text, so `mgaStatus` derives Maryland's own codes (201 to 216, never LegiScan's range): from the structured fields for readings, reports, and passage, and from the text only for how an act became law, a veto, a withdrawal, and a motion that ended the bill. First reading is In committee, since Maryland refers a bill to committee at its first reading. A joint resolution is Adopted by its number in the chapter field, and a House or Senate resolution once its chamber adopts it. Bills still in committee at sine die keep their status, since the file doesn't mark them.
- **Extras.** The chapter of the session laws (or the joint resolution's number), the statutes affected, the emergency and constitutional amendment flags (shown only when set), and the latest step between the chambers. The bill page shows them under "Additional information from Maryland General Assembly".
- **Field inventory.** `providers/mga/inventory.ts` lists every field of a record, and `test/providers/mga/map.test.ts` checks the recorded records against it.
- **Fails closed.** The client (`providers/mga/client.ts`) throws on an HTTP error, a body that isn't JSON (a truncated download included), a body that isn't a list, and a record without its bill number, without any key the mapping reads (null is allowed, missing isn't), or with a sponsor, subject, or statute of the wrong shape. The sync stops for the hour without writing anything from that answer. An empty list or a missing file means nothing new, never that bills went away. `test/cron/mga-provider.test.ts` covers each case at the main seam.
- **Not mapped.** Per-member votes, which the MGA publishes only as PDFs. Bill text stays a link to the MGA's PDF.

### State ownership

Which provider a state syncs from is a central table, `state_providers` (`central/src/lib/stateProviders.ts`): one row per state, with its provider, a status (`active`), the provider it had before, and when the row was written. **A state with no row is LegiScan's**, so a LegiScan-only central has no rows. Each sync reads the table once per run: the LegiScan sync and the weekly vote-dataset check skip only the states another provider owns, and each snapshot provider syncs only the states whose row names it. Every state is decided on its own, so a problem in one state never pauses another.

An operator changes a state's provider with a claim:

```bash
curl -X POST "$CENTRAL/api/admin/state-providers/DC" -H "x-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' -d '{"provider":"lims"}'
curl "$CENTRAL/api/admin/state-providers" -H "x-admin-secret: $ADMIN_SECRET"   # every row
```

- **200** when the state's current provider has no tracked bills there, meaning no bill of that provider in the state is linked to an instance. Monitor links count, since instances hold those bills too. Claiming a state for the provider it already has changes nothing.
- **409** otherwise, naming the current provider (`owner`), its `trackedBills` count, and the `instances` tracking them. The row doesn't change, and the state keeps syncing from its current provider. The new provider would give each tracked bill a second copy under a new id, and instances would see, and pay AI for, both. Only a cutover moves a state with tracked bills.
- **400** for an unknown provider, a state the provider doesn't serve (`Provider.states`), or a provider that isn't configured on this central (`Provider.configured`, such as LIMS without `LIMS_API_KEY`), since that would leave the state with no working provider.

The check and the write are one SQL statement, so a link or another claim landing in between can't slip past the rule. The other half is in the syncs: each reads ownership once, when it starts, so a claim can land mid-pass. `applyMasterList` therefore writes each new link with a statement that holds only while the row still names the syncing provider (`insertLinkWhileOwner`), and it queues and notifies nothing for a state that changed provider during the pass. Links and claims serialize in D1: either the link lands first and the claim is refused, or the claim lands first and the link isn't written. `POST /admin/lims-import` answers 409 unless LIMS owns DC. Neither ownership route is on the tenant surface allowlist. API keys stay in env vars.

**A state whose provider loses its key goes unsynced.** If a provider owns a state but is no longer configured (for example, `LIMS_API_KEY` was removed after DC was claimed), its sync skips the state with a warning every hour, and LegiScan doesn't take it back, since that would duplicate the provider's tracked bills. The state stays unsynced until the key is restored or the state is claimed for another provider.

**For one release, the old env vars seed rows.** On the first sync after the upgrade, each state named by `LIMS_STATES` (with `LIMS_API_KEY` set), `MGA_STATES`, or `LIS_STATES` that has no row gets one, under the claim's refusal rule (`Provider.statesEnvKey`). Whichever sync runs first writes it, and every sync agrees from then on. A seeded row is logged, and the env var can then be removed. A refused seed is logged once an hour, by the LegiScan sync, and the state stays on LegiScan. If the env var's provider also has tracked bills in that state, instances hold bills from both providers. That split state is logged as an error for an operator to settle, and the state still stays on LegiScan. The env vars never change a state that has a row. A later release removes the seeding.

### Status vocabulary

Each provider keeps one vocabulary file, `providers/<id>/vocabulary.ts` (`Provider.vocabulary`). It lists every status code the provider writes to `bills.status`, with:

- a **label**, which is what the bill API sends as the bill's `status` and what members see;
- a common **stage** from `shared/statusStages.ts` (Introduced, In committee, Passed one chamber, Passed legislature, Failed, Vetoed, Enacted), or none for a status outside the legislative path, like a DC hearing notice's;
- a **rank**: the stage's position in that list times 100, plus the provider's own order within the stage (Enacted is 7, so LegiScan's Chaptered is 703). Failed and Vetoed sit below Enacted because that is where LegiScan's status sort always put them;
- a **terminal** flag, for a measure that is done changing. It stays in central, where it stops the details refresh (DC's Approved and Deemed Approved are not terminal);
- a plain-language **explainer**.

It also labels the provider's bill types and calendar event types. `central/test/providers/vocabulary.test.ts` checks the rank formula, that labels and ranks are unique, and that each provider's mapping can't write a code its vocabulary lacks.

The bill API sends each bill's label, stage, and rank (`status`, `statusStage`, `statusRank`). Tenants store the stage and rank on `bills` (migration 0076), filter the bill list by stage, and sort status by rank, so bills from different providers sort together. Central used to send LegiScan's progress codes 7 to 12 as bare digits. 0076 rewrote stored digits to the words central sends now, the queue consumer does the same for a central that still sends digits, and the status filter accepts each digit as an alias of its word, so saved views and links keep working (`shared/legacyStatusOrder.ts`). When a central sends no stage or rank, the queue consumer looks them up in the same file, from the table 0076 backfilled with. `GET /bills/labels?state=XX` serves the explainers of the state's owner (above), plus the calendar name and whether the state has events. It is on the tenant surface allowlist, and the web app shows a status's explainer when a member hovers over the status chip on a bill page.

**Changing a status's stage or rank needs a one-time metadata resend for that provider's states.** Instances keep what central last sent, so their bills would keep the old stage and rank until each one changes. Ship the vocabulary change, then, for every tenant covering an affected state, send both:

```bash
curl -X POST "$CENTRAL/api/admin/refresh-metadata/$TENANT?state=DC" -H "x-admin-secret: $ADMIN_SECRET"   # tracked bills
curl -X POST "$CENTRAL/api/admin/refresh-stubs/$TENANT?state=DC" -H "x-admin-secret: $ADMIN_SECRET"      # monitor stubs
```

Neither makes a provider call or runs AI. Changing a label needs the same resend, and also leaves saved views and links that filter on the old label matching nothing. Explainers can change freely, since instances read them from central each time.

### Provider extras

A field only one provider publishes, such as a DC law number, is still shown on the bill page, as a provider **extra**. The provider declares it in its vocabulary file under `extras`: a key, a label, an optional explainer, and a display type (`text`, `date`, `link`, or `identifier`, from `shared/providerExtras.ts`). Its mapping sets the values on `CentralMeasure.extras`, by key. A provider never writes them itself.

- **Storage.** Core stores the values in `bill_extras` (migration 0032), one row per bill, provider, and key, and replaces a bill's rows on every ingest, like its other child data (`central/src/lib/billExtras.ts`). Labels aren't stored, so relabeling an extra needs no resend. Core drops a value whose key the vocabulary doesn't declare, a value that isn't a string, a `date` that isn't a real YYYY-MM-DD, and a `link` that isn't http(s), with a warning. These checks never throw, since a throw mid-ingest would skip the bill's texts, votes, and tenant notifications. The delete and inserts run in one batch.
- **The bill API.** `GET /bills/:id` sends `extras`: the provider's display name (`Provider.displayName`) and its fields in vocabulary order, each with its label, explainer, display type, and value, or null when the bill has none.
- **Instances** pass `extras` through in the bill detail, with no tenant schema change. The bill page shows one generic "Additional information from <provider>" panel, only when there are extras, and an explainer as a tooltip. No provider has UI code of its own.
- **Display only.** Change detection never sees extras, so an extra changing alone writes no change-log entry and sends instances no changes. Nothing sorts, filters, notifies, or runs AI on them, and instances don't store them.

**Adding an extra needs a backfill.** A new extra, or a fix to how one is mapped, reaches a bill only when that bill is ingested again. That happens when its record changes, and for LIMS also on the details refresh, which skips terminal statuses. The bills an extra matters most for are often the ones that no longer change, such as enacted DC laws with their law numbers. So shipping an extra includes re-ingesting the provider's tracked bills:

- `POST /api/admin/reingest-tenant/:tenantId?provider=<id>&confirm=true` queues every bill an instance tracks from that provider, on the provider's `ingestQueue` (without `confirm`, it's a dry run that says how many). For a provider other than LegiScan it spends no LegiScan calls. Run it for each instance covering the provider's states. Without `provider`, it queues the instance's tracked bills from every provider, on `INGESTOR_QUEUE`, and each LegiScan bill costs a `getBill` call.
- `POST /api/admin/reingest-bill/:billId` queues one bill, on `INGESTOR_QUEUE`.

Neither route runs AI, and an extra changing alone sends instances no changes. For LIMS's own steps, see "DC Council (LIMS)" above.

**When an extra becomes a shared column.** Promote an extra to a shared column (or table) on central's bills, with a tenant column if instances need it, when either of these holds:

1. A core feature needs it: sorting, filtering, notifications, AI, or a dedicated view. Each of those reads stored, typed columns that mean the same thing for every provider, and extras are neither.
2. A second provider publishes the same fact. Two providers' copies of one field belong in one column under one name, so members can compare states, rather than two panels that happen to agree.

Promoting means a migration for the column, mapping it in every provider that has it (and removing it from their `extras`), and a backfill or one-time resend for bills already stored. Until either test is met, an extra is the right home: it costs one vocabulary entry and no schema.

**Field inventories.** Every provider keeps an inventory of every field its feed returns, in `central/src/providers/<id>/inventory.ts` beside its vocabulary (`FieldInventory` in `providers/types.ts`), each `'mapped'`, `{ extra: key }`, or `{ ignored: reason }`, by path (`Sponsors[].Name`). A provider with a listing and a per-measure details response keeps one for each. Reviewers read it to see that nothing in the feed is dropped silently. The provider's mapping test checks its recorded fixtures against it with the shared helper in `central/test/helpers/fieldInventory.ts`:

```ts
expect(inventoryProblems(inventory, fixtures, vocabulary)).toEqual([])
```

The check fails on any fixture field the inventory doesn't list, and on an inventory entry naming an extra the vocabulary lacks. `unfedExtras(vocabulary, ...inventories)` from the same helper lists the declared extras no inventory entry names, across all of a provider's inventories. An ignored object or array covers everything inside it, while a mapped one doesn't, so a field the feed starts sending fails the test until someone decides what to do with it. The test-only example provider (`central/test/providers/example/`) shows the whole path: its vocabulary declares extras, its inventory lists its fixture's fields, its mapping test runs the check, and `central/test/cron/provider-extras.test.ts` follows the extras from the feed to the bill API at the main seam. LIMS keeps two, for its BulkData record and its LegislationDetails response (`central/src/providers/lims/inventory.ts`), and Maryland one, for a record of its session file (`central/src/providers/mga/inventory.ts`). Virginia gets its own with its provider ticket. LegiScan doesn't keep one, since central's shapes are LegiScan's own.

### Bill calendar entries

A bill's hearings, mark-ups, meetings, and deadlines live in central's `bill_calendar`, one row per entry, and instances mirror them into `calendar_events`. The rules are the same for every provider (`central/src/lib/billCalendar.ts`, from #295):

- **Kind.** Every entry has one of `hearing`, `markup`, `meeting`, or `deadline` (`shared/calendarKinds.ts`). Each provider's vocabulary names the kind of each of its calendar event types, and central sends the kind with every entry, in the bill API, in `/upcoming-hearings`, and in each notification's calendar block. Instances store it (`calendar_events.kind`, tenant migration 0079) and never work it out from an entry's identity or type id. A deadline makes no hearing feed event.
- **Identity.** The provider's own event id when it publishes one (`MeasureCalendarEntry.event_id`). Otherwise the kind, date, and normalized description, so two same-text entries on different days are two entries, and none is ever numbered by position. Instances build each entry's calendar UID from its identity (`hearingUid` in `api/src/queue/processor.ts`), so it must never change for an entry they already have:
  - **LegiScan keeps the identity it always had**, its type id and description (`Provider.legacyCalendarIdentity`). getBill has no event ids, and every subscriber's UIDs are built from that identity. A moved LegiScan hearing is still one entry that changed. Two LegiScan hearings with the same type and description on different days share the identity: central keeps a row for each (the bill page lists both), and instances get the later one under the one UID, as before.
  - **A row written before identities were stored** (migration 0034) keeps the identity central sent it under. Its `identity_key` is null, and the first pull that lists it again writes the old identity there for good. This is how DC entries from a fork's LIMS keep their UIDs, including the ordinal the old LIMS mapping added to a second same-text hearing ("Public Hearing on B26-0400 (2)"): central matches the row on its kind, date, and description less the ordinal, and keeps sending its old identity.
- **Cancellation.** An entry is cancelled only on positive evidence, or once it is missing from two successful pulls in a row. Positive evidence is the provider marking the entry cancelled (`MeasureCalendarEntry.cancelled`): a notice tied to it, as LIMS's hearing cancellation notices are, or a removed flag in the feed. A pull that lists no live entries (none at all, or only cancellations) counts for nothing, and a date passing never cancels anything. A cancelled entry that was still to come is reported (`hearing_cancelled`), and a past one is cancelled quietly.
- **Pulls and rechecks.** A pull is an ingest of the bill from its provider. An ingest of the same record again (a retried message, or a re-ingest at the same change hash) is the same pull, and counts once. A sync pass that lists the bill with the change hash an ingest left also counts, since the provider still serves the record the entry was missing from: the pass queues `{ billId, calendarRecheck: <hash> }` on the ingestor queue, and the ingestor counts one more miss with no provider call. So LegiScan call counts don't move, and an entry LegiScan drops is cancelled at the next pass that finds the bill unchanged. Only rows of missing entries are read for this (a partial index).
- **No deletes.** The ingest updates rows in place. A cancelled row stays, with `cancelled_at`, and comes back under the same identity if the provider lists the entry again. Instances bump an event's ICS `SEQUENCE` on every change, cancellation, and return, so it only ever rises.

Changing an event type's kind re-identifies a non-LegiScan provider's entries of that type, which instances see cancelled and recreated once.

**For a provider.** Give each entry a `type_id` whose vocabulary event type names its kind. Set `event_id` only to an id the feed publishes and keeps. Without one, keep the description stable (no ordinals or counts, and no time). List every entry the feed shows, past ones too, and never drop one to signal anything. Set `cancelled: true` only when the feed says that specific event was cancelled (a notice tied to it, or a cancelled or removed status on the event), with the identity the live entry had. Build live entries only from the record the measure's change hash covers, since a recheck trusts that hash. Separately fetched data, like LIMS's details response, may supply cancellations but not live entries.

### Committees

Central's `committees` table holds one row per committee a bill is referred to, and `bill_referrals.committee_id` points at it, so a committee reads the same on every bill. Rows carry the `provider` that wrote them (migration 0035). There are no memberships, chairs, or staff.

- **Ids.** The provider sets each referral's `committee_id` (and the pending `committee`'s) on the measure. LegiScan's are its own, from what `getBill` already sends, so committees cost no extra LegiScan call. A provider without integer committee ids mints them with `ctx.ids('committee', keys)`. LIMS keys a committee by its canonical name, case folded (`providers/lims/map.ts`, `committeeKey`). A referral with no id (a provider that has none for it, or DC's "Retained by the Council") is stored as before and names no committee.
- **The ingest** upserts the measure's committees just before it replaces the bill's referrals (`central/src/lib/committees.ts`). A committee keeps the provider and id that first wrote it. Its name and chamber follow the latest ingest that names it from the committee's latest session, so a committee LegiScan renames is renamed on every bill at once, and re-ingesting an older session's bill can't bring back an old name. The LegiScan bulk seed (`scripts/lib/build-bill-statements.ts`) writes committees the same way.
- **The bill API.** `GET /bills/:id` sends `committee` (the pending committee, or null) and `referrals`, in the provider's order, each `{ date, committeeId, name, chamber }`. A referral's name is its committee row's, and `committeeId` is null when no row exists.
- **Instances** pass both through in the bill detail, with no tenant schema change, and the bill page's "Committee" and "Referrals" row shows them. `bills.committee` is still only filled by demo seeds, and the detail falls back to it when central sends no committee.
- **Existing data.** 0035 fills the table from the referrals LegiScan bills already hold, so they point at real rows at once. LIMS referrals get their ids on each bill's next ingest (the post-deploy LIMS re-ingest above covers DC's tracked bills). Maryland mints its committees' ids keyed by chamber and name (`providers/mga/map.ts`, `mgaCommitteeKey`), since each chamber has its own Rules committee. Virginia referrals have no ids until its provider ticket mints them.

---

## Phase 1 — Cron (`central/src/cron/sync.ts`)

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
   - **→ ingestor queue, match or no match**: bills whose masterlist entry carries **no title** and whose hash changed (a brand-new row counts as changed). There is nothing to keyword-match against, and `getBill` is the only way to get a real title, description, sponsor, and history — so these go to the ingestor even when no tenant matches them. Self-limiting: the ingestor writes the fresh `change_hash`, so later passes see no delta and don't re-queue.
   - **→ tenant queue directly** (no API call): `stubOnly` messages for `match_type=null` link changes, so the tenant refreshes denormalized fields from central's `/bills/:id`.
   - **→ ingestor queue, as a calendar recheck**: unchanged bills whose calendar has an entry missing from the last pull (see "Bill calendar entries"). No provider call.
   - **Nothing**: other unchanged bills, and changed-but-never-matched bills that do have a title.

### Raw pass

For each masterlist-raw entry:

1. **Bills row maintenance.** New bills inserted with `change_hash = ''` sentinel and `title = bill_number` (raw has no title); *not* queued. Existing changed bills get `change_hash` + `updatedAt` updated **only if matched** (`match_type ∈ {'keyword','manual'}` for some covering tenant). Unmatched (`match_type=null`) changed bills are deliberately **left with their stale `change_hash`** — see "Why the raw pass leaves unmatched hashes stale" below.
2. **Dispatch:**
   - **→ ingestor queue**: already-matched bills with changed hash (the ingestor re-pulls via `getBill` and re-writes the hash itself, so advancing it here is harmless).
   - **→ ingestor queue, as a calendar recheck**: unchanged bills whose calendar has an entry missing from the last pull, as in the full pass.
   - **Nothing else**: no `stubOnly` notifications (raw has no fresh metadata to send), no new-match discovery (no titles to match against), and unmatched changed bills are left untouched.

#### Why the raw pass leaves unmatched hashes stale

The full pass is the **only** pass that refreshes `last_action`/`status` for monitoring-only bills and sends them `stubOnly` notifications, and it gates that work on `billChanged = stored.change_hash !== masterlist.change_hash`. The raw masterlist carries no `last_action`/`status` and the raw pass never notifies stub tenants — so if the raw pass advanced an unmatched bill's `change_hash`, the *next full pass would see no delta and silently swallow the change forever* (until some later change happened to land in a full-pass window first). Because ~7 of every 10 passes are raw, that swallow was the common case. Leaving the unmatched hash stale lets the full pass reliably detect and propagate the change (≤8h latency). Fixed in `runRawPass` ([sync.ts](../../central/src/cron/sync.ts)); the one-off `POST /admin/backfill-stub-actions/:tenantId` route heals stubs that were already swallowed before the fix.

### Cron design consequences

- `getBill` is called for matched bills (`match_type ∈ {'keyword', 'manual'}`) **and** for changed masterlist entries with no title, matched or not (`runFullPass` in [sync.ts](../../central/src/cron/sync.ts) — untitled entries are queued before the per-tenant match loop runs). The cron is the API gate; apart from that untitled-entry exception, unmatched changes never touch the ingestor.
- New keyword matches surface in full passes only ⇒ ≤8h latency.
- Monitoring-only bill metadata updates surface in full passes only ⇒ ≤8h latency. The raw pass leaves unmatched bills' `change_hash` stale precisely so the full pass keeps detecting them (see "Why the raw pass leaves unmatched hashes stale"); advancing it there used to swallow the change.
- **Ordering note**: the cron writes the new `change_hash` and masterlist fields to central D1 *before* sending the queue message. By the time the ingestor's snapshot reads `bills.change_hash`, it already matches what `getBill` will return. This means `bill_change_log` rows for `title_changed` / `status_change` / `description_changed` are not emitted for cron-triggered messages — the snapshot reads the post-change value. Child-collection diffs (history, sponsors, votes, supplements, amendments) are still captured correctly. This is a known caveat.

---

## Phase 2 — Central ingestor (`central/src/queue/processor.ts`)

Consumes from `central-legiscan-ingestor` queue. Message shape: `{ billId: number; skipFetch?: boolean; forceMetadata?: boolean; forceAI?: boolean; calendarRecheck?: string }`. A `calendarRecheck` message only rechecks the bill's calendar (see "Bill calendar entries") and calls no provider.

### skipFetch branch

Used by the bulk-seed script and the `redownload-texts` admin route. Skips `getBill` entirely. Downloads any `bill_texts` row with null `r2_key` from `state_link`, then calls `notifyTenants` and returns. No `getBill` calls, but a text whose `state_link` fails (or names its version with a fragment) still falls back to `getBillText`, one LegiScan call per document.

### Normal branch (the common path)

`processBill` always calls the provider's `fetchMeasure(billId)`, which is LegiScan's `getBill` — **one LegiScan quota tick per message**. The cron is the only gate preventing that tick.

It hands the result to `ingestMeasure`, which unconditionally:

1. Reads existing `bills` row (if any) and snapshots its child rows.
2. Runs `detectChanges` to compute a list of `ChangeRecord`s.
3. Writes `bill_change_log` rows (one per detected change).
4. Upserts the `bills` row (status, title, last_action, etc.).
5. **Delete + reinsert** these child tables: `bill_history`, `bill_sponsors`, `bill_sasts`, `bill_subjects`, `bill_referrals`, `bill_extras`. Just before the referrals, it upserts the `committees` they name. `bill_calendar` is updated in place instead, and never deleted from (see "Bill calendar entries").
6. **Upsert** these child tables: `bill_texts`, `bill_supplements`, `bill_amendments`, `roll_calls`.
7. Downloads any text without an R2 key to `bills/legiscan-{billId}/texts/{docId}.{ext}`.
8. Stamps `bills.texts_fetched_at` → derives `text_status` for the response.
9. Calls `notifyTenants` for each covering tenant.

**Note:** per-legislator vote rows (`roll_call_votes`) are **not** populated by this path — `getBill` returns vote summaries (`MeasureVote`) only. Bulk-seeded bills have per-legislator rows; live-ingested bills don't. Architecture-review §B4.

### notifyTenants

Reads `bill_tenants` rows for this bill (joined to `tenants` for `queue_id`), then sends one message per covering tenant to that tenant's queue: `{ tenantId, billId: 'legiscan:<id>', forceMetadata, forceAI, matchType, changes }`. Sets `bill_tenants.notified_at`.

Delivery goes through `deliverToTenant` ([central/src/lib/tenantDelivery.ts](../../central/src/lib/tenantDelivery.ts)): **binding-first** — if a static `TENANT_QUEUE_<ID>` producer binding exists it uses `queue.send`/`sendBatch` (unchanged) — else it **HTTP-publishes by `queue_id`** via the Queues REST API (`CF_QUEUES_TOKEN`), so a tenant onboarded without a static binding still receives bills. Only when neither exists is the message dropped (logged).

---

## Phase 3a — Per-tenant queue boundary

Each tenant has its own queue (`floorvote-{id}-queue`). Messages come from three places:

1. **Ingestor `notifyTenants`** — bills that just went through `getBill`. Normal flow.
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
| `ai_skip_reason` | `'pdf_too_large'` / `'unreadable_document'` / `null` | Paired qualifier on `ai_processed_at`. When the AI provider rejects the input non-retryably, the tenant queue processor records the reason here and leaves `ai_processed_at` null. `'pdf_too_large'` is Gemini's 1000-page PDF cap; `'unreadable_document'` is Gemini refusing the bytes as a document at all (a state site serving an HTML shell under a `.pdf` URL is the known cause). Both come from `classifyAiError` in `processor.ts` — transient 429/503 errors are shed and retried instead, so they never land here. The early-return dedup at `processor.ts` treats `ai_skip_reason != null` symmetrically with `ai_processed_at != null` — both mean "permanently decided, don't waste a text fetch + AI call." Cleared automatically when a subsequent AI run succeeds (e.g. on a new, smaller text version, or after `forceAI`). |

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
  - Runs AI (Gemini, at the tier chosen below) when:
    - **shouldRunAi**: `msg.forceAI || derivedMatchType !== null` (where `derivedMatchType` comes from the message, the existing row, or keyword-match for brand-new bills)
    - **AND** text was successfully fetched
    - **AND** `aiDedup` is false: `existing.lastAiTextHash !== centralBill.textHash`, *unless* `forceAI` bypasses dedup. `forceMetadata` does **not** bypass it — see "Two AI gates, easily confused" below.
  - Writes `ai_processed_at`, `last_ai_text_hash`, `last_ai_text_doc_id` on success.

### AI service tiers

Every AI call in the pipeline goes to Gemini via `processBill` ([api/src/lib/llm.ts](../../api/src/lib/llm.ts)) with an explicit `serviceTier`. There is **no second provider** — no Anthropic/Claude path exists anywhere in this codebase, and no call ever falls back to a different or cheaper model. What changes under load is the tier and the timing, never the analysis.

The tier is picked in `processor.ts` by a single line:

```ts
const tier: 'flex' | 'priority' = msg.interactive ? 'priority' : 'flex'
```

| Tier | When | Why |
|---|---|---|
| `flex` | **The default** — every cron-, ingestor-, and admin-driven message | Bulk ingestion is throughput work with nobody watching. Flex is the cheapest tier and the first Google sheds under load, which is exactly the right trade for a backlog that can be retried for hours. |
| `priority` | Only when the message carries `interactive: true` | Set **only** by the promote-bill and reprocess-bill routes (`interactive` in [api/src/types.ts](../../api/src/types.ts) and [central/src/types.ts](../../central/src/types.ts)); it is never inferred from anything else. It means a human clicked something on a page and is watching a spinner for this one bill. |
| `standard` | Never chosen up front — only as a one-shot fallback after a shed `priority` call | The escalation step below. |

Escalation on a shed (`isGeminiShed` = upstream HTTP 429 or 503):

1. **priority sheds** → retry once, immediately, at `standard`. Somebody is waiting, so spend a second call now instead of parking the message in a queue backoff.
2. **flex sheds** → no in-invocation retry; throw `AiShedError(60)` straight to the queue.
3. **the `standard` retry also sheds** → `AiShedError(0)` — retry, but with no added delay.
4. `AiShedError` reaches `processQueue`, which records the shed on the bill row (`ai_attempted_at` + `ai_error`, deliberately *not* `last_ai_text_hash`, so the bill can't dedup itself into permanent silence) and calls `message.retry({ delaySeconds: shedRetryDelay(base, attempts) })`. The base doubles per attempt and caps at 3600s, so ten retries cover roughly five hours of shedding instead of ten minutes.

The shape is deliberate: a human waiting on a page gets priority capacity and, when that is unavailable, an immediate retry on another tier instead of a queue backoff; bulk ingestion never competes for that capacity; and shed work waits with backoff rather than silently degrading. A bill's summary is always the same model's output — the only variable is how long it took to arrive.

### Two AI gates, easily confused

`forceMetadata` appears in one of them and not the other:

| Gate | Condition | Bypassed by |
|---|---|---|
| **Early skip** — "nothing changed, don't even fetch the text" | `existing.providerUpdatedAt === centralBill.updatedAt` **and** AI is already terminally decided (`ai_processed_at` or `ai_skip_reason` set) | `forceMetadata`, `forceAI`, `stubOnly`, `metadataOnly`, or central holding an R2 key the tenant hasn't recorded yet |
| **AI dedup** — "the model already read this exact text" | `existing.lastAiTextHash === centralBill.textHash` | **`forceAI` only** |

So `POST /tenants/reprocess/:tenantId` (`forceMetadata: true`) gets past the early skip and re-upserts metadata, then still dedups on the text hash and pays for no model call. That split is load-bearing: while `forceMetadata` was part of the dedup condition, every metadata refresh was a fresh AI call — and because `PATCH /bills/:id/priority` reaches `/reprocess` through `backfillCalendar`, merely setting a priority re-analyzed the bill and could surface a phantom "New bill matching your keywords" event. Only `forceAI` forces the model.

### What lives where

- **Tenant D1** — the `bills` row (with denormalized JSON for actions/sponsors), member votes, official positions, comments, notes, feed events, custom fields, AI summary + tags + relevance.
- **Central D1 (LS)** — bills + all relational children (`bill_history`, `bill_sponsors`, `bill_texts`, `bill_supplements`, `bill_amendments`, `bill_sasts`, `bill_subjects`, `bill_calendar`, `bill_referrals`, `roll_calls`, `roll_call_votes`*, people, committees, sessions, `bill_change_log`, `api_call_log`, `session_sync_log`).
- **Central R2** — bill text files at `bills/legiscan-{billId}/texts/{docId}.{ext}`.

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
| `POST /admin/reingest-tenant/:tenantId` | Yes (dry-run by default; `?confirm=true` to fire) | 1 `getBill` per matched bill | Bulk tenant backfill. `?provider=lims` limits it to the tenant's LIMS bills, on the LIMS queue, for 1 LIMS details call each and no LegiScan calls. |
| `POST /tenants/promote-bill/:tenantId/:billId` | Yes, `forceAI: true` | 1 `getBill` | Manually add a bill: sets `match_type='manual'` and forces AI. |
| Bulk seed (`scripts/seed-legiscan.ts --from-dir`) | Yes, `skipFetch: true` | 0 `getBill`; 1 `getBillText` per text whose `state_link` fails | Seed central D1 from LegiScan bulk JSON dump. |

---

## Things to grep when this gets out of date

- **Cron logic**: `central/src/cron/sync.ts` (`runFullPass`, `applyMasterList`, `runRawPass`)
- **Ingestor**: `central/src/queue/processor.ts` (`processBill`, `ingestMeasure`)
- **LegiScan calls**: `central/src/providers/legiscan/` (the API client, and the provider that maps it onto the interface in `central/src/providers/types.ts`)
- **Snapshot providers**: `central/src/cron/sync-snapshots.ts` (`runSnapshotSync`), and `central/src/providers/{lims,mga,lis}/` (LIMS's field inventories are `providers/lims/inventory.ts`)
- **State ownership**: `central/src/lib/stateProviders.ts` (`loadStateOwners`, `claimState`), and the `/state-providers` routes in `central/src/routes/admin.ts`
- **Cadence**: `central/src/lib/sync-schedule.ts`
- **Change detection**: `central/src/lib/detect-changes.ts`, and `central/src/lib/billCalendar.ts` for calendar entries
- **Status vocabulary**: `central/src/providers/<id>/vocabulary.ts`, `central/src/lib/vocabulary.ts`, `shared/statusStages.ts`, and `GET /bills/labels` in `central/src/routes/bills.ts`
- **Provider extras**: `extras` in `central/src/providers/<id>/vocabulary.ts`, `central/src/lib/billExtras.ts`, `shared/providerExtras.ts`, `web/src/components/ProviderExtras.tsx`, and the inventory helper in `central/test/helpers/fieldInventory.ts`
- **Tenant consumer**: `api/src/queue/processor.ts` (`processCentralNotification`)
- **Central bill detail API**: `central/src/routes/bills.ts`
- **Tenant bill detail API**: `api/src/routes/billsApi/detail.ts` (`buildBillDetail`)
- **Schemas**: `central/src/db/schema.ts`, `api/src/db/schema.ts`
