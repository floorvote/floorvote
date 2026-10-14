# Sync Architecture

Canonical, code-grounded description of how legislative data flows from a provider (LegiScan by default, or the DC, Maryland, and Virginia providers for the states an admin has claimed for them) into tenant DBs. Sections below describe the LegiScan path unless a heading names another provider. Update this file whenever the pipeline changes. The visual companion is [`architecture.html`](../content/public/internal/architecture.html), served at `floorvote.org/docs/internal/architecture.html` — keep both in sync, but treat this file as the source of truth.

> **Scope:** the LegiScan central env (`floorvote-central-legiscan`), the only central. A state with no `state_providers` row syncs from LegiScan, and the opt-in providers run in the same central.

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
2. **Full pass.** In a session's full-pass hours, `snapshot` returns every record with a hash. A provider whose feed answers conditional requests (Maryland) also gets the ETag of the last snapshot a pass finished (`sessions.snapshot_etag`, migration 0038), and may answer that nothing changed (304). That saves the download, not the pass: core runs the pass on the records it stored from the last full read, since the full pass is what links an instance that newly covers the state, re-queues a changed bill whose ingest failed, and moves links whose keywords no longer match. Core stores the new ETag only after a pass has queued and sent everything while the provider still owns the state, a forced run (`POST /admin/providers/:id/sync`) reads in full, and a claim clears the state's stored ETags in the same batch (`writeClaim`), so a provider that gets a state back reads its files in full. Core stores each changed record in `provider_records`, maps each record through `toEntry`, and runs the same `applyMasterList` as the LegiScan full pass. Queued bills go to the provider's `ingestQueue` binding when it is bound (LIMS: `LIMS_INGESTOR_QUEUE`), and to `INGESTOR_QUEUE` otherwise. With `detailsRefresh` (LIMS), tracked bills whose details are stale are re-queued too, unless their status is terminal in the provider's vocabulary (below). A session whose pass fails (a provider failing closed) doesn't stop the provider's other sessions. Core throws the failures together after the last one, so the job still fails and alerts.
3. **Ingest.** The ingestor routes each bill to its provider by the `provider` column of its `bills` row, and passes `fetchMeasure` the stored record and its session. LIMS also returns its LegislationDetails response, which core stores in `provider_records` beside the listed record (so a field ignored today can be mapped later without fetching it again), and records when it was fetched. The record's hash stays the listed record's.

Core does every read and write. A provider gets `ctx.ids(kind, keys)` to mint central ids from the `provider_ids` table (MGA and LIS, and LIMS for committees; LIMS packs its other ids into reserved ranges, `providers/lims/ids.ts`), `ctx.knownIds(kind, keys)` to look ids up there without minting any (Virginia, for carry-over links), `ctx.people()` for the people it has written, and `ctx.today`. Ids only identify rows. Whatever picks a provider for a bill, session, or person reads that row's `provider` column (the ingestor, the LegiScan sync's session list, the stub backfill, status labels, and sponsor links), never an id range.

### DC Council (LIMS)

DC syncs from the Council's LIMS API once an operator claims it (`POST /admin/state-providers/DC` with `{"provider":"lims"}`, which needs `LIMS_API_KEY`), or for one release from `LIMS_STATES=DC` (below). Until then DC stays on LegiScan. A session is a Council Period, tagged `CP26`. LIMS bill, session, people, and document ids are packed into reserved ranges from the measure number and LIMS's own ids (`providers/lims/ids.ts`), so a fork that already ran DC on LIMS keeps every id.

- **What it pulls.** One BulkData call per category per Council Period, for the current period and, for a year after it ends, the previous one. `LIMS_CATEGORIES` defaults to bills (1), resolutions (6), grant budget modifications (13), reprogrammings (14), and oversight hearing notices (18). Each ingest adds one LegislationDetails call. `POST /admin/lims-import` pulls named measures from any period, and answers 409 unless LIMS owns DC. Every hour, the Council's own calendar too (`providers/lims/hearings.ts`): the undocumented, keyless feed behind lims.dccouncil.gov/hearings, one call per month, last month through three ahead (see "Body events" below).
- **Sponsors across Council Periods.** After each session refresh, LIMS returns the members of every Council Period central holds DC measures in, not just the current one, so a bill keeps a sponsor who has since left the Council.
- **What maps where** (`providers/lims/map.ts`). Bulk history is the history and most of the documents. Introductions, committee prints, engrossments, enrollments, and signed acts are texts. Committee reports, hearing notices and records, memos, and other documents are supplements under their LIMS type, and a document LIMS gives no title is titled from its file name. Each floor reading's per-member votes go through `writeMemberVotes`. Hearing, mark-up, and reading videos attach to the history entries they record (`bill_history.video_url`, migration 0033), and the bill page links each one. Hearings and mark-ups go on the calendar, and an oversight hearing notice is a calendar entry of its own. So do the deadlines the Council records in the history: the Mayor's response due, the end of Congressional review, and when an emergency act or temporary law expires (event type 10, kind `deadline`). A measure has at most one of each, so each kind of deadline carries a fixed event id (`deadline:mayor-response`, `deadline:congressional-review`, `deadline:expires`), and a deadline that moves is a change, not a new entry. Every live calendar entry comes from the BulkData record, which the change hash covers, so a calendar recheck can trust it. A record with no history is a bad answer and comes with no calendar at all (`calendar` undefined). A hearing whose details carry a cancellation notice goes out marked cancelled (see "Bill calendar entries" below). Referrals use the Council's full committee names ("Committee on Youth Affairs", where LegislationDetails says "Youth Affairs"), each pointing at a committees row (see "Committees" below). Committees asked only for comments are an extra, not referrals.
- **Vocabulary decisions.** DC's Approved and Deemed Approved aren't terminal, so the details refresh keeps checking them. Expired is in the enacted stage, after Official Law, since what expires is mostly emergency and temporary acts that were law until their term ran out (tenant migration 0078 moved bills an instance had already staged). Not Applicable, which hearing notices carry, has no stage and is terminal.
- **Extras.** The D.C. Law, act, and resolution numbers, the Mayoral and Congressional review dates, who asked for a measure, the committees asked for comments, and the withdrawal. The bill page shows them under "Additional information from DC Council".
- **Field inventories.** `providers/lims/inventory.ts` keeps one for the BulkData record and one for the LegislationDetails response, and `test/providers/lims/map.test.ts` checks the recorded fixtures against both. A third, for the hearings calendar, is checked by `test/providers/lims/hearings.test.ts`.
- **Fails closed.** The client (`providers/lims/client.ts`) throws on an HTTP error, a body that isn't JSON, or a shape the mapping doesn't read, including details for a different measure. A key the mapping reads must be present, though it may be null: a missing key isn't read as an empty one, so a key LIMS renames can't quietly strip every DC bill of that field. The sync stops for the hour, and the ingest retries, without writing anything from that answer. An empty list, or a null BulkData or Members answer, means nothing new, never that measures, sessions, or members went away. `test/cron/lims-provider.test.ts` covers each case at the main seam.
- **Concurrency 1.** LIMS answers 429 above about two concurrent requests. Its ingests go to `LIMS_INGESTOR_QUEUE` when that binding exists, and to `INGESTOR_QUEUE` otherwise, and both consumers run at `max_concurrency = 1` (`central/wrangler.example.toml`). The client also paces itself at one request a second.

**After deploying a LIMS mapping change, re-ingest DC's tracked bills.** A bill's extras, documents, and videos change only when the bill is next ingested, and an enacted DC bill (the ones with law numbers) is terminal, so the details refresh never re-fetches it. For each tenant covering DC:

```bash
curl -X POST "$CENTRAL/api/admin/reingest-tenant/$TENANT?provider=lims" -H "x-admin-secret: $ADMIN_SECRET"               # dry run: how many
curl -X POST "$CENTRAL/api/admin/reingest-tenant/$TENANT?provider=lims&confirm=true" -H "x-admin-secret: $ADMIN_SECRET"  # queue them
```

`?provider=lims` queues only the tenant's LIMS bills, on the LIMS queue. It spends no LegiScan calls, and one LIMS details call per bill, paced at one a second.

**After adding a status to the vocabulary, re-queue the bills that read it as Not Applicable.** A bill whose status LIMS used before `vocabulary.ts` listed it was stored as 100 (Not Applicable), which is terminal, so the details refresh skips it. It stays at 100 until its list record changes. To fix the ones already stored, run the same `POST /admin/reingest-tenant/:tenantId?provider=lims` for each tenant covering DC (above). The warning "unrecognized status" in the logs, which appears once per name per worker, says which status to add.

### Maryland (MGA)

Maryland syncs from the General Assembly's open data once an operator claims it (`POST /admin/state-providers/MD` with `{"provider":"mga"}`). It needs no key and spends no LegiScan calls. Until then Maryland stays on LegiScan. A session is one of the MGA's session codes, tagged `2026RS` or `2026S1`, and bill, session, people, document, and subject ids are minted from `provider_ids`.

- **What it pulls.** One JSON file per session (`{session}/misc/billsmasterlist/legislation.json`, about 8 MB, regenerated through the day), holding every bill and resolution. The session refresh sends a HEAD request for this year's regular and special sessions and next year's regular session, and a session syncs while its year is current or ahead, since the Governor signs and vetoes into late May. Each full pass reads the file with the ETag of the last one read, so an unchanged file costs a 304, and the pass runs on the stored records. An ingest builds the bill from its stored record with no further request. The record hash leaves out `StatusCurrentAsOf`, the file's timestamp, which changes on every regeneration.
- **What maps where** (`providers/mga/map.ts`). The file has no action history, so the history is rebuilt from each chamber's first reading, committee report, and second and third readings. The first, third, and enrolled readers are texts, each with a `text_hash` of `sha256("mga-doc:<doc_id>")`, since the MGA publishes no checksum: stable, and different for each reading, so a bill's newest text changing is what gets AI to run again. Every bill and joint resolution has its fiscal and policy note as a supplement, at paths built from the bill number: a text sits under its chamber prefix (`bills/hb/hb0618F.pdf`), and a fiscal note under `fnotes/bil_` and the number's last digit, zero-padded to four (`fnotes/bil_0008/hb0618.pdf`, `bil_0000/hb1000.pdf`). The MGA doesn't document that folder rule. It fit every note link on 37 bill pages checked, and the bill number as the folder missed nearly all. A few bills list no note, and the file doesn't say which, so the link is made for every bill. The last action date is the latest of the milestones above, also for a bill the Governor signed or vetoed, since the file dates no Governor action. Each hearing time goes on the calendar as a Hearing (kind `hearing`), one for each chamber's primary and secondary committee, described by chamber and committee. The MGA publishes no event ids, but each hearing has a fixed slot in the record, so the slot is its `event_id` (`2026RS/SB0002/S/primary`), and a hearing the committee moves reads as changed rather than cancelled and added again. An emptied slot isn't positive evidence of a cancellation, since the file doesn't say that hearing was cancelled, so the hearing is cancelled after two pulls that leave it out (the second usually a recheck). Referrals carry committee ids from `provider_ids`, keyed by chamber and name (each chamber has its own Rules committee), and the measure names the committee a bill waits in. Cross-files are related bills. Broad subjects and narrow index terms map to subjects, without the printed index's "-see also-" cross-references. Sponsors are names only ("Delegate Crosby"), each minted one person id by name, so a member keeps one id across bills and sessions. A chair, officer, or delegation sponsor keeps its whole name, and its id is per session, since different people hold the office over time.
- **Statuses.** The file's Status is the last action as free text, so `mgaStatus` derives Maryland's own codes (201 to 216, never LegiScan's range): from the structured fields for readings, reports, and passage, and from the text only for how an act became law, a veto, a withdrawal, and a motion that ended the bill. First reading is In committee, since Maryland refers a bill to committee at its first reading. A joint resolution is Adopted by its number in the chapter field, and a House or Senate resolution once its chamber adopts it. Bills still in committee at sine die keep their status, since the file doesn't mark them.
- **Extras.** The chapter of the session laws (or the joint resolution's number), the statutes affected, the emergency and constitutional amendment flags (shown only when set), and the latest step between the chambers. The bill page shows them under "Additional information from Maryland General Assembly".
- **Field inventory.** `providers/mga/inventory.ts` lists every field of a record, and `test/providers/mga/map.test.ts` checks the recorded records against it.
- **Fails closed.** The client (`providers/mga/client.ts`) throws on an HTTP error, a body that isn't JSON (a truncated download included), a body that isn't a list, and a record without its bill number, without any key the mapping reads (null is allowed, missing isn't), or with a sponsor, subject, or statute of the wrong shape. The sync stops for the hour without writing anything from that answer. An empty list or a missing file means nothing new, never that bills went away. `test/cron/mga-provider.test.ts` covers each case at the main seam.
- **Not mapped.** Per-member votes, which the MGA publishes only as PDFs. Bill text is the MGA's PDF, which core downloads from its link rather than reading from the feed.

### Virginia (LIS)

Virginia syncs from the Legislative Information System's public data files once an operator claims it (`POST /admin/state-providers/VA` with `{"provider":"lis"}`). It needs no key and spends no LegiScan calls (a key is optional, for bill text, below). Until then Virginia stays on LegiScan. A session is one of the LIS's session codes, tagged `20261` (the 2026 regular session) or `20262` (Special Session I), and bill, session, people, roll call, document, and committee ids are minted from `provider_ids`. The provider reads the CSV files, and bill text from the LIS API when the deployment sets the optional `LIS_API_KEY`. The API's terms allow non-commercial use only, so the key is opt-in, and without it Virginia bills have no text (`texts` is `[]`) and no API call is made. The API also has meeting schedules, which the provider doesn't read.

- **What it pulls.** Ten CSVs per session (`lis.blob.core.windows.net/lisfiles/{session}/`): BILLS, HISTORY, VOTE, Sponsors, Summaries, FiscalImpactStatements, DOCKET, SUBDOCKET, Members, and Committees, about 16 MB for a regular session. The session refresh sends a HEAD request for this year's regular and special sessions and next year's regular session. A pass reads one file at a time and folds it into a record per bill (`LisAssembler` in `providers/lis/map.ts`) before reading the next. An ingest builds the bill from its stored record with no further request, except for bill text (next).
- **Bill text (optional `LIS_API_KEY`).** The API's terms allow non-commercial use only, so text is opt-in: a deployment that sets `LIS_API_KEY` takes on the terms, and without it nothing below happens (no call, no `texts`). With it, a pass that reads the files also makes one call, `getlegislationtextlistasync?sessionCode=<code>` with the key in a `WebAPIKey` header, which lists every text version in the session (12,000 rows for the 2026 regular session). Only `LegislationVersionID` 1 to 7 are bill text (Introduced, Engrossed, Enrolled, Chaptered, Substitute, Reengrossed, Reenrolled). 8 to 11 (amendments, veto explanations, governor's recommendations, conference reports) are left out, so AI never reads an amendment as the bill's newest text. Each bill's record carries its versions as `texts`: LIS text id, document code (trimmed: the LIS sends some with a trailing space), version, description, and draft day, oldest first. A row for a bill the CSVs lack is ignored, and the API's `HJ` and `SJ` numbers (written `HJR` and `SJR` by LegiScan) match the CSVs' bills. A new version changes only its bill's record hash, which queues that bill. The ingest then makes one call per version central doesn't already store, `getlegislationtextbyidasync?legislationTextID=<id>`, for its blob PDF link (`TextsList[].PDFFile[].FileURL`, in the entry for the id asked for; public, so core downloads it with no key), and emits a PDF text: `doc_id` minted from the text id, `state_link` the blob link, and a `text_hash` from the session, the trimmed document code, and the text id (the id because the LIS reuses a code across versions). A link never changes for a text id, so core hands `fetchMeasure` the bill's stored texts (`MeasureRef.texts`: each `doc_id` and `state_link`), the provider finds each version's stored text by its `doc_id` (`ctx.knownIds`, which mints nothing), and a stored version keeps its link with no call. That includes a text whose download failed (no R2 key): its link is reused and core retries the download as before. So re-ingesting a bill whose versions are all stored makes no by-id call, and a new version makes one. Turning the key on for the first time looks up every version of every bill once (about 10,500 calls for 2026, at the shared 2/s `lis` rate), and none after that. A version whose answer has no PDF is left out, and is asked for again on the next ingest. Every call is logged as `lis:<operation>` and paced on the `lis` bucket. It fails closed: an HTTP error, a body that isn't JSON, a text list with no `LegislationTextList`, or a by-id answer with no `TextsList`, no entry for the id asked for, or no `PDFFile` in it fails the pass or the ingest (which retries), and writes nothing from it. The list is read only when a pass reads the files, so a version published while the files are unchanged waits for their next change (the CSVs name each bill's versions, so they change with it). Adding or removing the key forces a full re-read, since the ETag records whether the pass read texts (below). Removing the key leaves texts already stored, and stops adding to them.
- **ETags.** The session's `snapshot_etag` packs every file's ETag into one versioned JSON string (`{"v":3,"files":{...},"docketed":true,"texts":false}`, where `texts` says whether the pass read bill text). A scheduled pass checks each file with HEAD first, and when no file changed, appeared, or went, and `texts` matches whether a key is set now, reports the session unchanged (core then runs the pass on the stored records). Otherwise it reads every file, since each record joins all of them. An empty file keeps its ETag, marked, so it doesn't read as appeared on every pass. Bump the version when `LisRecord`'s shape changes: a stored ETag of another version reads as none, so the next pass reads every file and rewrites the stored records, instead of a 304 handing the mapping records of the old shape.
- **What maps where.** History is the history, Sponsors the patrons, and each history line's per-member votes (VOTE.CSV, by the line's reference id) a roll call through `writeMemberVotes`. A reference id names a vote, not a bill, and a block vote's id is shared by every bill on it, so a roll call's id is minted from the session, the bill, and the reference id (`lisRollCallKey`): each bill on a block vote has its own roll call. A vote whose member rows are all X (not voting) has no tally, which is how the files record a voice vote (the history line says "(Voice Vote)"). It is no roll call, since there is no count to show and the files record no result for it, and its history line stays. Fiscal impact statements are supplements. The latest summary is the description, as plain text (summaries hold HTML). Referrals carry committee ids keyed by chamber and name: one for each "Referred to Committee on/for X", "Rereferred to X", "Recommitted to X" (after a floor motion), and "Referred to X" line. The lines that say where a bill came from ("Reported from X and referred to Y", "Rereferred from X to Y") are each followed by a line of one of those kinds, so they are not referrals of their own. The pending committee is the committee of the bill's latest referral, until a later line reports the bill out or ends it there (reported, failed to report, passed by indefinitely, stricken, left in committee, continued, tabled, incorporated, discharged), and only while the bill is in committee or has passed one chamber. History is read in date order, and a day's lines keep the file's order. Each Senate committee or subcommittee docket is a Hearing on the calendar. The files publish no event ids, so an entry's identity is its kind, date, and description ("Senate Finance and Appropriations docket"), and one committee's dockets on two days are two entries. That is intended: a docket is one meeting on one day, and a bill can sit on the same committee's docket on several days, so no key built from the files names one event for good. A docket moved to another day reads as a new entry, and the old one is cancelled two pulls later. Until a pass reads DOCKET.CSV or SUBDOCKET.CSV, bills send no calendar at all (no evidence) rather than an empty one, which would count toward cancelling. The House publishes its agendas elsewhere, so House committees have no calendar entries.
- **Carry-over.** A bill continued to a later session reappears in that session's files with its whole history, and becomes a new central bill there, linked to the old one (a "Carry Over" related bill). The history says where it went: "to next session" (the next year's regular session), "to 2027", or "to 2026 Sp. Sess. 1" (the 2026 budget went from the regular session to Special Session I). The link goes to the latest session of the year it was continued in that central holds the bill in (`ctx.knownIds`, which mints nothing), so nothing assumes the previous regular session, and a session central never synced links nothing. The new bill's votes are this session's. Its earlier votes stay on the old bill, since each session's VOTE.CSV holds only its own.
- **Statuses.** The files carry flags, not statuses, so `lisStatus` derives Virginia's own codes (301 to 312). A referred bill is In committee. A carried-over bill is Continued from last session until it moves, and its progress after that shows as usual. The LIS copies a carried-in bill's flags from the session it came from, so until the bill has history in its new session, `Failed` and `Passed_*` describe the old one, and the bill reads as Continued from last session (#385). This relies on the LIS resetting those flags once a carried bill acts in its new session. Recheck it against live 2027 data mid-session: a carried bill that acts but keeps `Failed` or `Passed_*` set would show the old session's status.
- **Extras.** The chapter in the Acts of Assembly, the emergency flag (shown only when set), and each earlier summary: as introduced, as passed by each chamber, and as passed by both. The bill page shows them under "Additional information from Virginia General Assembly".
- **Field inventory.** `providers/lis/inventory.ts` lists every column of every file, and `test/providers/lis/map.test.ts` checks the recorded files against it.
- **Fails closed.** A pass fails without writing anything from that answer, so no bill is rebuilt without its history, patrons, or votes:
  - A missing (404) or empty BILLS, HISTORY, Sponsors, Summaries, Members, or Committees, which a session publishes from its first prefiled bill.
  - A missing VOTE or FiscalImpactStatements once this session's history records a counted vote or a statement. A carried-over bill's earlier lines don't count, since their votes and statements stay in the earlier session's files (2027's prefile files have neither).
  - Any file the last finished pass read going missing.
  - A file cut down to its header: a history or patrons file naming none of the bills, no vote rows for the counted votes this session's history records, or no statements for the ones it records. Docket files may be empty, but not once the last pass found bills on them (`docketed`), or every docket would be cancelled.
  - A cut-off file: a body shorter than its Content-Length, a file that doesn't end with a line break, a quote that never closes, or a row with more or fewer fields than its header.
  - A missing column the mapping reads, a VOTE row with a member but no vote, or a vote that isn't Y, N, X, or A.

  A file cut by the LIS's own export exactly at a row boundary, ending in a whole row, can't be told from a complete one. `test/cron/lis-provider.test.ts` covers each case at the main seam.

  A failing session doesn't stop the provider's other sessions: core runs each session's pass, then throws the failures together, so the job still fails and alerts. **If the LIS really stops publishing a file a previous pass read** (or empties a docket file for good), every scheduled pass of that session fails until an operator checks the files and runs `POST /admin/providers/lis/sync`. A forced run reads without the stored ETags, so it skips the "last pass read it" and "docketed" checks, and stores fresh ETags if it succeeds.

**After a Maryland or Virginia mapping change.** A fix to what a bill builds into (a link, a roll call, a referral) reaches a stored bill when it is next ingested, which is when its record changes. A session whose bills have stopped changing (a finished regular session) keeps the old build until then, so after deploying such a fix, re-ingest each instance's tracked bills from the provider, as for LIMS above: `POST /api/admin/reingest-tenant/:tenantId?provider=mga&confirm=true` (or `lis`). It spends no LegiScan calls. The list-row fields (last action and its date) are written by the sync pass only when a bill's record changes, so a re-ingest doesn't refill them: the last action date a fix gives an enacted Maryland bill appears when the MGA next changes that bill's record.

### Memory

A snapshot pass holds a whole session in memory, so the cron runs the snapshot providers one after another, each as its own job (`central/src/index-legiscan.ts`), and `storeRecords` writes changed records a batch at a time. Virginia's 2026 regular session (3,646 bills, 16 MB of CSVs) is the largest snapshot. Its pass, from reading the files to storing every record, completes in a 40 MB V8 heap (Node's `--max-old-space-size`, the mapping bundled with esbuild and run on the real files), against a Worker's 128 MB. Before these changes it needed 72 MB. Each bill's history is stored as one string, as its votes are, since as 65,000 small arrays it was half of what a pass held.

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

**For one release, the old env var seeds rows.** Only `LIMS_STATES` ever ran, so Maryland and Virginia have no env var: they move only by a claim. On the first sync after the upgrade, each state named by `LIMS_STATES` (with `LIMS_API_KEY` set) that has no row gets one, under the claim's refusal rule (`Provider.statesEnvKey`). Whichever sync runs first writes it, and every sync agrees from then on. A seeded row is logged, and the env var can then be removed. A refused seed is logged once an hour, by the LegiScan sync, and the state stays on LegiScan. If the env var's provider also has tracked bills in that state, instances hold bills from both providers. That split state is logged as an error for an operator to settle, and the state still stays on LegiScan. The env var never changes a state that has a row. A later release removes the seeding. A fork moving onto upstream relies on this for DC: see `fork-upgrade.md`.

### Session slugs and old links

A bill's URL is `/STATE/SLUG/NUMBER`. Central gives each session a slug that is unique within its state (`central/src/lib/sessionSlugs.ts`, from migration 0031) and sends it with each bill: the slug the session's name asks for (`sessionToSlug` in `shared/sessionSlug.ts`), or `-2`, `-3`, and so on when another session of the state holds it. The owning provider's sessions go first, then lowest id. A slug never changes once assigned.

The rule changed with the provider model. Numbered special sessions and Council Periods used to slug to their year, and now have their own slug:

| Session | Before | Now |
|---|---|---|
| 2026 Special Session 1 (Maryland) | `2026` | `2026-s1` |
| 2026 Special Session II (Virginia) | `2026` | `2026-s2` |
| 2025-2026 Council Period 26 (DC) | `2025-2026` | `cp26` |
| 2026 1st Special Session, 2026 Regular Session | unchanged | unchanged |

The old rule is kept, frozen, as `sessionToSlugBeforeProviders`, so links in old digests and bookmarks keep working. The tenant's resolve routes (`api/src/routes/billsApi/lookupRoutes.ts`) try, in order:

1. **The bill's own slug.** A canonical URL always reaches its bill.
2. **A slug an older link may use:** the one the session's name asks for (when central gave it `-2`), or the one the old rule gave it (`legacySessionSlug`). One match resolves. More than one is a 409 that lists each bill, and the page links to each.

When step 1 matches but another bill answers to the slug by step 2, as the 2026 Regular Session's HB5 does at `/MD/2026/HB5` beside a 2026 Special Session 1 HB5, the response adds `otherSessionMatches` and the page points to those bills. An old link to the special-session bill lands on the regular one, as it already did when both slugged to `2026`, but not silently.

**Before merging a slug change,** run `scripts/session-slug-dry-run.ts` against the production central (the header has the commands). It prints renames (each session the current rule slugs differently from the old one, as old → new, and which session will hold the old slug, if any) and collisions (each session that won't get the slug its name asks for). Between them, they're every session whose URLs change. If the rule changes again, leave `sessionToSlugBeforeProviders` as it is and have `legacySessionSlug` also return the slug under the rule being replaced.

### Moving a state to another provider (cutover)

A claim can't move a state whose provider has tracked bills there. A cutover does, without writing to any instance's database, and an undo puts it back (`central/src/lib/cutover.ts`, from #296). Both are operator-only and off the tenant surface allowlist, and both are dry runs unless `?confirm=true`:

```bash
curl -X POST "$CENTRAL/api/admin/state-providers/DC/cutover" -H "x-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' -d '{"provider":"lims"}'                          # dry run
curl -X POST "$CENTRAL/api/admin/state-providers/DC/cutover?confirm=true" -H "x-admin-secret: $ADMIN_SECRET" \
  -H 'content-type: application/json' -d '{"provider":"lims"}'                          # cut over
curl -X POST "$CENTRAL/api/admin/state-providers/DC/undo-cutover" -H "x-admin-secret: $ADMIN_SECRET"               # what an undo would do
curl -X POST "$CENTRAL/api/admin/state-providers/DC/undo-cutover?confirm=true" -H "x-admin-secret: $ADMIN_SECRET"  # undo
```

The new provider must be a snapshot provider that serves the state and is configured (the same 400s as a claim).

**The dry run** reads the new provider's sessions, records, and legislators, and writes nothing but the API call log, which counts every call it spends. It reports:

- matched bills, each with the handle it keeps;
- unmatched bills on both sides. `old` lists the losing provider's bills nothing matched (tracked ones flagged), which keep their rows and links but stop syncing. `new` lists the new provider's bills nothing matched, which arrive as new bills;
- `ambiguous` match keys, and `conflicts`: bills the new provider already holds under another row, which are left unmatched;
- for each moved bill with calendar entries, the entries that keep their identity, the ones that will be cancelled, and the ones that will be added;
- matched people, with what agreed (`on`) and the weak ones flagged, and unmatched people on both sides;
- `losingMatch`: tracked bills whose keyword link the new provider's title and description won't match. The new provider's first pass still ingests them, as it does every moved bill, but instances then hold them as monitored bills.

For LIMS, the calendar preview costs one LegislationDetails call per moved bill that has calendar entries, paced at one a second. `?calendar=false` skips the preview and those calls. For Maryland, which names its legislators only on its bills, the plan builds each tracked moved bill from its stored record, with no calls.

**Matching.**

- **Bills** match on the session's first year, whether it's a special session, and the bill number without padding (`HB0001` is `HB1`), as #259's planner did. A key two bills on one side share matches neither. Bills from sessions earlier than the new provider's stay as they are.
- **People** match on name, chamber, and district, each compared only where both records have it, and any that disagree rule a pair out (`central/src/lib/cutoverMatch.ts`). Whole names are tried first, then last name and first initial, then last name alone where a record has no first name. A pair counts only when each is the other's one candidate, so two Smiths in one chamber match no one. Those left out that way stay out of the looser comparisons too, on both sides, so the plan never guesses between them. A match that chamber and district don't both confirm is weak. Every DC, Maryland, and Virginia match is weak: LIMS gives titles rather than chambers or wards, Maryland names its sponsors by title and last name, and Virginia's files have no districts. Weak matches are kept, so check them in the dry run before confirming.

**The cutover** plans again, so it acts on what the feed says now. It answers 409 when no bill matched, since it would only strand the old provider's bills. Then it writes everything in one D1 batch, which is one transaction:

1. It records the cutover (`cutovers`, `cutover_bills`, `cutover_people`, migration 0036), but only while the state still has the provider the plan read and that provider has added no bills there since. Otherwise nothing is written, and it answers 409.
2. Each moved bill keeps its central row id, so its handle and every instance's copy of it stay as they are. The new provider's key for it maps to that id in `provider_ids`, so Maryland and Virginia, which mint ids from that table, give the kept id everywhere, cross-filed and carried-over bills included. LIMS packs its ids from measure numbers, so core gives the kept ids in its place wherever its records reach core (`central/src/lib/carriedIds.ts`). Legislators work the same way: core swaps the kept person id into the provider's people, sponsors, and votes.
3. It writes the new provider's sessions, moves each matched bill to its new provider and session, and clears the bill's texts, supplements, amendments, roll calls, and member votes. The ingest upserts those by their own ids rather than replacing them, so the two providers' would otherwise mix.
4. It gives matched legislators to the new provider, so a provider that finds sponsors among its own people (LIMS) has them before its first session refresh. And it marks the losing provider's sessions in the state prior and sine die, so they leave the dashboard's active list.
5. Last, it flips `state_providers`, with no claim's refusal check, since moving tracked bills is the point. As a claim does, it forgets the state's snapshot ETags in the same batch (`forgetSnapshotEtagsStatement`), so the new owner's first pass reads its files in full instead of taking a 304 for records it stored the last time it owned the state.

If anything fails, nothing is written and the state stays on its provider. Once the batch lands, the new provider's sync runs at once, and its answer is in the response (`sync`). That pass queues a first ingest for **every** moved bill, tracked or not, tracked ones first, on the queue `ingestQueueFor` gives the provider. It gives each untracked one the new provider's status at once (a tracked one gets it from its ingest), and sends instances a monitor stub for each, since each one's change hash moved, so there's no stub resend to run by hand. The pass's `queued` count says how many went. Until its first ingest runs, an untracked moved bill shows the new provider's status and the old provider's history and sponsors, with no documents or votes.

**Which queue, and how long.** A provider's bills go to its own ingest queue only when it declares one (`Provider.ingestQueue`) and the binding is there. Otherwise they share `central-legiscan-ingestor` with LegiScan's bills, one at a time (`max_concurrency = 1`):

- **LIMS** declares `LIMS_INGESTOR_QUEUE`, which `wrangler.example.toml` leaves commented out. Bind it before cutting DC over. With it, the drain runs at LIMS's one LegislationDetails call a second, so DC's roughly 1,900 moved bills (about 2,300 measures in all) take a little over half an hour, and LegiScan's ingests don't wait. Without it, the same half hour holds up every LegiScan ingest, including bills an admin promotes.
- **MGA and LIS** declare no queue of their own. Their ingests make no LegiScan calls (each builds the bill from its stored record; LIS with a key also makes one call per text version, paced at two a second), but each still writes the bill and downloads its texts, so a cutover of a few thousand Maryland or Virginia bills holds up LegiScan's ingests while they drain. Run one when a delay to LegiScan's ingests is acceptable, such as outside the full-pass hours (5, 13, and 23 ET).

**If the response has `sync.error`, the cutover still stands: run that sync again** (`POST /api/admin/providers/lims/sync`), or wait for its next full pass. That pass queues the first ingests, and sends a stub itself for each untracked moved bill, since each one's change hash moved.

**The first ingest of each moved bill** (flagged by `bills.carried_from`) is quiet. It writes no change log entries and sends instances no `changes` and no calendar changes, so instances write no feed events and members get no "bill changed" emails. It still bumps `updated_at`, so instances fetch the bill again with the new data, and run AI again if its text changed. It clears the old provider's documents again first, in case an ingest from the old provider was in flight. `carried_from` is cleared only after everything else is written, so an ingest that fails partway is retried just as quietly. A bill no instance tracks stays a monitored bill: its notification carries no match type, so no link becomes tracked and no AI runs, and its instance copy just takes the new provider's data. Every ingest writes the bill row only while the row still names its provider, so an ingest that hadn't written the row when the cutover (or an undo) landed writes nothing at all. One that had keeps going:

- **An old provider's ingest past its row write** goes on writing its documents, roll calls, and calendar. Most of that lands before the new provider's first ingest, which clears it. The window that's left is narrow: two ingests of one bill overlapping, with the old one's tail still writing after the first ingest's clear. Then a few of its texts, supplements, amendments, or roll calls can stay beside the new provider's, since the ingest upserts those by their own ids and nothing replaces them. Delete those rows by hand if it happens. Stray calendar rows go the usual way: the new provider's pulls miss them, and they're cancelled.
- **A new provider's first ingest when an undo lands past its row write** finishes writing the new provider's data onto a bill that's now the previous provider's again. So it doesn't clear `carried_from`. It sets it to its own provider, and the previous provider's next ingest is the quiet one that clears the leftovers and carries the calendar back.

Each full pass queues a moved bill until its first ingest clears `carried_from`, so an ingest that ran out of retries is tried again at the next pass. Each of those messages names the provider that queued it (`queuedBy`, or `firstIngestFor` for an untracked bill), and the ingestor skips it with no provider call once the bill has moved to another provider. An untracked bill's message is also skipped once the bill has had its first ingest, so a copy a forced sync adds while the queue drains usually costs one D1 read. A tracked bill's never is, since it may also be for a new keyword match that instances must hear of. The exception is a bill whose carry-over waits for a calendar (LIMS for a record with no history, LIS for a bill with no docket file): it keeps `carried_from`, so each copy runs a full ingest and notifies instances, up to three in all (`MAX_CARRY_WAITS`). After an undo, a message the new provider queued is skipped, and the previous provider's own sync queues the bill on its own queue, so the new provider's consumer never spends the previous provider's calls.

Then the first ingest carries the calendar over (`carryCalendar` in `central/src/lib/billCalendar.ts`):

- Each live entry is paired with the new provider's entry on the same date and of the same kind, each side's kind from its own vocabulary. It keeps its identity, so the event keeps its UID in every subscriber's calendar, now with the new provider's details.
- An old entry nothing pairs with is cancelled at once, since nothing will list it again.
- The new provider's other entries arrive under identities of their own.

So an entry that doesn't match is cancelled and recreated once, and the dry run lists it. LegiScan's hearings with the same type and description on different days share one identity, and instances hold one event for them, so only the row they hold (the latest) carries it on. The others are cancelled, and their new entries arrive as new events. An empty calendar counts, and cancels every old entry. A measure that comes with no calendar at all (LIMS sends none for a record with no history) says nothing, so the carry-over waits: the ingest sends instances no calendar, and `carried_from` stays until a later ingest brings one, which is quiet too. After three ingests with no calendar (`bills.carried_waits`), it stops waiting, logs the bill, and cancels the old entries.

**Session slugs.** A moved bill moves to the new provider's session. When that session's name asks for the slug the old session holds, as LIMS's "2025-2026 Council Period 26" does beside LegiScan's, it gets `-2` (`cp26-2`), since slugs never change (#290). Instances store the new slug when the bill next reaches them, so its URL becomes `/DC/cp26-2/B26-0400`. Old links keep resolving through the tenant's fallback while no other bill answers to them exactly ("Session slugs and old links" above).

**What stays behind.** The losing provider's unmatched bills keep their rows and links, frozen. Its committee rows stay, with no bill pointing at them, and unmatched legislators keep their rows. R2 copies of the cleared documents stay in the bucket.

**Event rules need re-picking.** The new provider mints committee ids of its own, and names its event types its own way. After a cutover, ask the admins of each instance covering the state to re-pick committees in their event rules (Settings → Calendar events, see "Event rules" below). A saved committee rule matches by central committee id, so it stops selecting the committee's own events, and matches only where the committee's name turns up in another event's joint-with text. A rule on an event type only the old provider used stops matching too. The settings page keeps listing the old choices, so the rules look fine while they select little or nothing, and an instance whose rules are all like that shows only the state's body events with a prioritized bill on the agenda, which rules never hide. Rules on kinds (`hearing`, `markup`, `meeting`), topics, and tracked bills keep working. Moving off LegiScan, which publishes no body events, leaves no rules to fix: the new provider's events are the state's first.

**Legislators across Council Periods.** LIMS can list a member under a new id in a new Council Period, and it resolves sponsors by name, latest id first. Core lists the people a cutover carried over last (`ctx.people()`), so a legislator keeps the id instances already have.

**Hearings without bills.** Coverage needs a bill's provider to be the event's. The batch flips each moved bill's provider, so the new provider's events cover moved bills at once. After an undo, the old owner's events stop syncing and reaching instances, along with the ownership.

**Undo** reverses the state's latest cutover. The state goes back to its previous provider, each moved bill to its old session, and the previous provider's sessions to the flags they had. The new provider's sessions in the state are marked ended, moved legislators go back to the previous provider, and the state's snapshot ETags are forgotten. The moved bills' documents are cleared again, and their next ingest from the previous provider is quiet and carries the calendar back the same way, so entries instances have kept through both moves keep their identities. The previous provider's sync then rewrites the bills. A snapshot provider's runs at once, and queues every moved bill's first ingest and sends the stubs as a cutover does. LegiScan's runs at its next full pass (the hourly raw pass doesn't queue them, so up to about eight hours), for one `getBill` per **tracked** moved bill. LegiScan never ingests an untracked moved bill, since each would cost a `getBill` from the monthly budget: such a bill takes the status and title from LegiScan's master list, and a stub, at that pass, and has no documents or votes until an instance tracks it. A tracked bill with `carried_from` set is queued for that ingest whatever its change hash says. That matters for a bill the new provider never ingested: its change hash is still the previous provider's (a snapshot pass writes the hash of a bill it queues only at its ingest), and its documents are cleared, so without that it would sit empty until the bill next changed. Such a bill is queued on each pass until an ingest clears its flag, which takes one ingest, or up to three for a provider whose measure arrives with no calendar. One known edge: if an undo and a re-cutover both land while a single first ingest is between its row write and its flag clear, the documents it wrote before the re-cutover's clear are lost, and the bill isn't queued again until the provider next changes it. Another: an undo to LegiScan that lands while an untracked bill's first ingest is between its row write and its flag clear leaves that bill LegiScan's, with `carried_from` set to the new provider and that provider's documents and votes. LegiScan never ingests an untracked bill, so it stays that way until an instance tracks it (its next ingest is the quiet one that clears them) or a later cutover moves it back. Bills the new provider added in the meantime stay with it, frozen, and the undo's dry run counts them (`added`) and how many of them an instance tracks (`addedTracked`).

**Instances** see none of this except their usual notifications. Their queue consumer drops a text central no longer lists, so the old provider's documents leave the bill page instead of failing to open. `POST /tenants/seed-session/:tenantId` answers 409 for a session whose provider doesn't own its state, so it can't hand an instance copies of the bills a cutover moved, and it links bills only while that holds, as the sync does. `GET /tenants/current-session/:state` prefers a session still in progress when two providers have one for the same year.

### Status vocabulary

Each provider keeps one vocabulary file, `providers/<id>/vocabulary.ts` (`Provider.vocabulary`). It lists every status code the provider writes to `bills.status`, with:

- a **label**, which is what the bill API sends as the bill's `status` and what members see;
- a common **stage** from `shared/statusStages.ts` (Introduced, In committee, Passed one chamber, Passed legislature, Failed, Vetoed, Enacted), or none for a status outside the legislative path, like a DC hearing notice's;
- a **rank**: the stage's position in that list times 100, plus the provider's own order within the stage (Enacted is 7, so LegiScan's Chaptered is 703). Failed and Vetoed sit below Enacted because that is where LegiScan's status sort always put them;
- a **terminal** flag, for a measure that is done changing. It stays in central, where it stops the details refresh (DC's Approved and Deemed Approved are not terminal);
- a plain-language **explainer**.

It also labels the provider's bill types and calendar event types. `central/test/providers/vocabulary.test.ts` checks the rank formula, that labels and ranks are unique, and that each provider's mapping can't write a code its vocabulary lacks.

The bill API sends each bill's label, stage, and rank (`status`, `statusStage`, `statusRank`). Tenants store the stage and rank on `bills` (migration 0076), filter the bill list by stage, and sort status by rank, so bills from different providers sort together. Central used to send LegiScan's progress codes 7 to 12 as bare digits. 0076 rewrote stored digits to the words central sends now, the queue consumer does the same for a central that still sends digits, and the status filter accepts each digit as an alias of its word, so saved views and links keep working (`shared/legacyStatusOrder.ts`). When a central sends no stage or rank, the queue consumer looks them up in the same file, from the table 0076 backfilled with. `GET /bills/labels?state=XX` serves the explainers of the state's owner (above), plus the calendar name, whether the state has events, and its capabilities (see "Body events" below). It is on the tenant surface allowlist, and the web app shows a status's explainer when a member hovers over the status chip on a bill page.

**Changing a status's stage or rank needs a one-time metadata resend for that provider's states.** Instances keep what central last sent, so their bills would keep the old stage and rank until each one changes. Ship the vocabulary change, then, for every tenant covering an affected state, send both:

```bash
curl -X POST "$CENTRAL/api/admin/refresh-metadata/$TENANT?state=DC" -H "x-admin-secret: $ADMIN_SECRET"   # tracked bills
curl -X POST "$CENTRAL/api/admin/refresh-stubs/$TENANT?state=DC" -H "x-admin-secret: $ADMIN_SECRET"      # monitor stubs
```

Neither makes a provider call or runs AI. Changing a label needs the same resend, and also leaves saved views and links that filter on the old label matching nothing. Explainers can change freely, since instances read them from central each time.

### The State coverage page

The published page `docs/content/contributing/state-coverage.md` is generated by `npm run gen:state-coverage` (`scripts/gen-state-coverage.ts`) from the registry. A provider declares `coverage` in code: its maintainers, as GitHub handles with no @. The page has one row for LegiScan, which covers every state, DC, and Congress, then one row for each direct provider with its `states` and maintainers. It doesn't list what each provider supplies or how mature it is, so there is nothing else to keep current.

The drift test in `scripts/lib/state-coverage.test.ts` (the `check-scripts` job) fails when the committed page doesn't match the generator, and when `.github/CODEOWNERS` doesn't have a line for each registered provider's directory naming its declared maintainers and the owners of the `*` line, so the project maintainer stays a code owner of every provider. `npm run gen:state-coverage -- --check` runs the same checks without vitest. A directory that isn't registered, such as the provider template, isn't listed or checked. `ci.yml` ignores `docs/**`, so a PR that edits only the page (and not a provider) isn't checked. Regenerate the page instead of editing it.

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

The check fails on any fixture field the inventory doesn't list, and on an inventory entry naming an extra the vocabulary lacks. `unfedExtras(vocabulary, ...inventories)` from the same helper lists the declared extras no inventory entry names, across all of a provider's inventories. An ignored object or array covers everything inside it, while a mapped one doesn't, so a field the feed starts sending fails the test until someone decides what to do with it. The test-only example provider (`central/test/providers/example/`) shows the whole path: its vocabulary declares extras, its inventory lists its fixture's fields, its mapping test runs the check, and `central/test/cron/provider-extras.test.ts` follows the extras from the feed to the bill API at the main seam. LIMS keeps two, for its BulkData record and its LegislationDetails response (`central/src/providers/lims/inventory.ts`), Maryland one, for a record of its session file (`central/src/providers/mga/inventory.ts`), and Virginia one, for every column of its data files (`central/src/providers/lis/inventory.ts`). LegiScan doesn't keep one, since central's shapes are LegiScan's own.

### Bill calendar entries

A bill's hearings, mark-ups, meetings, and deadlines live in central's `bill_calendar`, one row per entry, and instances mirror them into `calendar_events`. The rules are the same for every provider (`central/src/lib/billCalendar.ts`, from #295):

- **Kind.** Every entry has one of `hearing`, `markup`, `meeting`, or `deadline` (`shared/calendarKinds.ts`). Each provider's vocabulary names the kind of each of its calendar event types, and central sends the kind with every entry, in the bill API, in `/upcoming-hearings`, and in each notification's calendar block. Instances store it (`calendar_events.kind`, tenant migration 0079) and never work it out from an entry's identity or type id. A deadline makes no hearing feed event.
- **Identity.** The provider's own event id when it publishes one (`MeasureCalendarEntry.event_id`). Otherwise the kind, date, and normalized description, so two same-text entries on different days are two entries, and none is ever numbered by position. Instances build each entry's calendar UID from its identity (`hearingUid` in `api/src/queue/processor.ts`), so it must never change for an entry they already have:
  - **LegiScan keeps the identity it always had**, its type id and description (`Provider.legacyCalendarIdentity`). getBill has no event ids, and every subscriber's UIDs are built from that identity. A moved LegiScan hearing is still one entry that changed. Two LegiScan hearings with the same type and description on different days share the identity: central keeps a row for each (the bill page lists both), and instances get the later one under the one UID, as before.
  - **A row written before identities were stored** (migration 0034) keeps the identity central sent it under. Its `identity_key` is null, and the first pull that lists it again writes the old identity there for good. This is how DC entries from a fork's LIMS keep their UIDs, including the ordinal the old LIMS mapping added to a second same-text hearing ("Public Hearing on B26-0400 (2)"): central matches the row on its kind, date, and description less the ordinal, and keeps sending its old identity.
- **Cancellation.** An entry is cancelled only on positive evidence, or once it is missing from two successful pulls in a row. Positive evidence is the provider marking the entry cancelled (`MeasureCalendarEntry.cancelled`): a notice tied to it, as LIMS's hearing cancellation notices are, or a removed flag in the feed. A measure that comes with no calendar at all (`CentralMeasure.calendar` undefined) is no evidence either way. An empty list is a calendar with nothing on it, and counts like any other, so when LegiScan drops a bill's only hearing, it is cancelled after two pulls. A date passing never cancels anything. A cancelled entry that was still to come is reported (`hearing_cancelled`), and a past one is cancelled quietly.
- **Pulls and rechecks.** A pull is an ingest of the bill from its provider. An ingest of the same record again (a retried message, or a re-ingest at the same change hash) is the same pull, and counts once. A sync pass that lists the bill with the change hash an ingest left also counts, since the provider still serves the record the entry was missing from: the pass queues `{ billId, calendarRecheck: <hash> }` on the ingestor queue, and the ingestor counts one more miss with no provider call. So LegiScan call counts don't move, and an entry LegiScan drops is cancelled at the next pass that finds the bill unchanged. For LegiScan, that second pull is always such a recheck, which trusts the change hash: sound, because LegiScan's change hash moves whenever the bill's calendar does, so an unchanged hash means getBill would return the same calendar. A recheck that finds its rows already written (its first try failed to reach instances) still sends instances the calendar. Only rows of missing entries are read for this (a partial index).
- **No deletes.** The ingest updates rows in place. A cancelled row stays, with `cancelled_at`, and comes back under the same identity if the provider lists the entry again. Instances bump an event's ICS `SEQUENCE` on every change, cancellation, and return, so it only ever rises.

Changing an event type's kind re-identifies a non-LegiScan provider's entries of that type, which instances see cancelled and recreated once.

**Deadlines on instances** (#298). An instance's calendar, ICS feed, and dashboard count show a bill's deadlines as they show its hearings: only once the bill has a priority (`lib/calendarVisibility.ts`), so a large keyword match doesn't flood the calendar. The bill page shows them for any bill, from central's calendar. The calendar marks a deadline with an amber clock rather than the gavel. The bill page shows the next upcoming deadline under the title, and lists deadlines with the hearings ("Hearings and deadlines"), each explained from the state's labels (`GET /bills/labels`, the vocabulary's event type explainer by type id), as the bill's status and type are. Deadlines stay out of the week-ahead email and the hearing feed.

**For a provider.** Give each entry a `type_id` whose vocabulary event type names its kind. Set `event_id` to an id the feed publishes for the event and keeps, or to a key that names one event of the measure for good (LIMS's deadlines use their kind of deadline, since a measure has one of each). Never use a position, a counter, or anything that changes when the event moves or is retitled. Without an event id, keep the description stable (no ordinals or counts, and no time). List every entry the feed shows, past ones too, and never drop one to signal anything. Send an empty list for a measure whose calendar is empty, and leave `calendar` out only when the answer can't say (a bad record). Set `cancelled: true` only when the feed says that specific event was cancelled (a notice tied to it, or a cancelled or removed status on the event), with the identity the live entry had. Build live entries only from the record the measure's change hash covers, since a recheck trusts that hash. Separately fetched data, like LIMS's details response, may supply cancellations but not live entries.

### Body events (the legislature's own calendar)

A provider that publishes the legislature's own calendar of hearings, roundtables, and meetings, with or without bills on the agenda, implements `listBodyEvents`. DC's Council calendar (LIMS) is the first. Central keeps each event in `body_events` (migration 0037) and the bills on its agenda in `body_event_bills` (`central/src/lib/bodyEvents.ts`, from #297). The rules are the bill calendar entries' (above):

- **Kind.** The provider sets one on every event, from its own type, and keeps the type's name (`type`, such as "Performance Oversight Hearing") for display. LIMS calls a mark-up `markup`, any other meeting `meeting`, and every hearing, roundtable, and oversight hearing `hearing`.
- **Identity.** Always the provider's own event id, one the feed publishes and keeps. A moved or retitled event is the same event, changed.
- **Cancellation.** On positive evidence (`BodyEvent.cancelled`, a cancelled status on the event itself), or once the event is missing from two successful pulls in a row. A pull is one month of the provider's calendar. Central reads last month through three months ahead every hour, one call a month (`cron/body-events.ts`, a job of its own per provider beside its snapshot sync), so an event the legislature drops leaves calendars about two hours later. A sync in which any month fails or comes back in a shape the mapping doesn't read counts no absences at all, since an event may have moved into that month, and neither does a sync that lists no live event anywhere. A month that comes back empty while other months list events counts on its own, far slower counter (`empty_pulls`): the event is cancelled after 24 such syncs in a row, about a day. That differs from a bill's calendar, where an empty list counts like any other: a legislature's whole month gone blank is likelier a bad answer from the feed than its only event cancelled. A date passing never cancels anything.
- **No deletes.** A cancelled event keeps its row, and comes back under the same identity if the provider lists it again.

The sync runs only for states the provider owns that an instance covers, and only while the provider is configured.

**Agenda links and coverage.** An agenda item with a bill number links the provider's bill of that number in the state (where numbers repeat across sessions, the one whose session spans the event's year). An item with no number links the one bill with a live calendar entry that day whose description is mostly the item's words, which is how a DC oversight hearing notice (an HN measure, whose entry is described by its title) pairs with the Council's roundtable. A bill's own title is never matched, since an oversight topic naming an agency would pair with any act about that agency heard the same day, and neither is a topic that only repeats the event's own name ("Legislative Meeting"). Links are rewritten on every sync, so one that couldn't resolve yet (a bill not synced yet) heals within the hour. A bill's calendar entry on the day of an event with the bill on its agenda is **covered** by the event, unless it's a deadline: the bill API's `calendar` and every calendar block name the event's UID in `coveredBy`. It is null when nothing covers the entry, and absent from a provider with no calendar of its own, so LegiScan's are unchanged. Where two events that day link the bill, a live one wins, then one of the entry's kind, then the earlier. A cancelled event still covers its entries, and a cancelled entry stays covered, so a cancellation shows once too. Coverage is worked out when it's read, so an event that arrives after the bill's hearing needs no rewrite.

**Committees.** An event's committee is the one the provider's referrals name, under the same id. LIMS mints it with `ctx.ids('committee', ...)` from the Council's full name ("Health" is "Committee on Health"), as its referrals do. Central writes a `committees` row for it under the rule in "Committees" below, from the provider's session spanning the event's year, so a committee that holds only oversight hearings is listed too.

**UIDs.** Each event goes to instances with its calendar UID: `body-<provider>-<event id>@floorvote.org` (the event id percent-encoded), or the provider's own scheme (`Provider.bodyEventUid`). LIMS keeps the UID the contributor's fork already gives Council hearings, `council-<hearingId>@lims.dccouncil.gov` (#217), so a fork's subscribers see nothing change when it moves to upstream. LIMS's event hash is #217's too, over the same values, so those events keep their ICS `SEQUENCE`. Never change either for an event instances have.

**Instances.** Every hour, an instance asks central for the events of the states it covers (`GET /tenants/:tenantId/body-events?from=&to=`, a month back to four ahead, on the tenant surface allowlist and scoped to the caller), each with its UID, its agenda bills by handle, and the bill entries it covers by handle and identity. Each state's events come from the provider that owns it. The instance (`api/src/lib/bodyEvents.ts`):

- Mirrors them into `calendar_events` as source `body`, bumping an event's `SEQUENCE` when its hash or status changes, links its agenda bills through `calendar_event_bills`, and cancels an event central stops sending (a state it stopped covering, or an event moved out of the window) while a covered state still has body events. It deletes its body events only once no covered state has any, so an event's `SEQUENCE` never falls.
- Sets `covered_by` (tenant migration 0082) on each covered bill entry, from this pull and from each notification's calendar block. The calendar page, the ICS feed, and the dashboard's upcoming count show the event in the entry's place (`lib/calendarVisibility.ts`), and an entry whose cover the instance doesn't have shows as before. Instances never de-duplicate by date and bill number, as #217's tenant code did.
- Shows the body events its event rules select (below) to every member, on the calendar page and in the ICS feed, and every body event of its covered states while it has none.

A central blip, a failed request, or an answer without its events and capabilities changes no event, and the next hour retries.

**Event rules.** An instance's admins choose which body events its calendar shows, under Settings → Calendar events (`shared/eventRules.ts`, `api/src/lib/eventRules.ts`, from #298). The tab appears only while a covered state has the `bodyEvents` capability. With no rules saved, every event shows. Once rules are saved, an event shows when any rule selects it:

- a committee holding the event, by central committee id, or named in its joint-with text, optionally narrowed to one kind or event type;
- a kind (`hearing`, `markup`, `meeting`) or one of the provider's own event types ("Budget Oversight Hearing"), in any committee. Rules store both in one list, and the settings page lists them apart. A value matches an event's kind exactly or its event type in any case (as #217's types matched), so a kind-named value (`meeting`) also selects an event typed "Meeting" under another kind;
- a topic, a named list of keywords in the bill keyword syntax, matched against the event's title and agenda. Topics are the instance's own content: no presets ship in code;
- a bill the instance tracks (a keyword match, an added bill, or a prioritized one) on the event's agenda.

The committee and kind lists come from central: `GET /tenants/:tenantId/body-event-options` (on the tenant surface allowlist, scoped to the caller) sends, for each covered state with body events, the state owner's rows in `committees` (those its referrals name and those holding events) and the kinds and types its `body_events` carry. The settings page adds any committee or kind the instance's events or saved rules name, so a central outage or a committee since gone drops no choice, and it previews the rules over the next four months of events with the same matcher the instance uses.

Rules never hide an event with a prioritized bill on its agenda: it shows whatever the rules say, as the bill's own hearing would.

Filtering happens on the instance, at read time, never by leaving events out of the mirror. The hourly sync keeps every body event and writes what the rules read of it (`calendar_events.rule_facets`, tenant migration 0083) and whether the instance shows it (`rule_match`: null with no rules, else 1 or 0). The calendar, ICS feed, and dashboard count hide an event whose `rule_match` is 0, so a hidden event drops out of members' subscribed ICS feeds too (a calendar app removes it at its next refresh). A covered bill entry is hidden only while its event shows, so a bill prioritized since the rules last ran shows its own hearing until the next sync shows the event. Saving or clearing rules rewrites `rule_match` from the stored facets in the same D1 batch as the rules, without asking central, so clearing them can't leave an event hidden even when central is down, and #217's failure mode (a clear whose cleanup sync fails, leaving events behind) can't happen. The hourly sync applies the rules again, so new events and bills tracked or prioritized since are selected within the hour.

The week-ahead email lists a body event with a prioritized bill on its agenda, as before, and any body event the rules select (`rule_match` 1). With no rules it lists only the first kind, so a state's whole calendar never floods the email.

A fork's teams chose their Council events with #217's `council_calendar_rules`. While an instance has no `event_rules`, the hourly sync carries those over (`rulesFromCouncilCalendar`) and saves them as its event rules once central's committee list arrives. If central doesn't answer, or neither its list nor the instance's events name any committee, the sync applies no rules and tries again the next hour, so a committee name never falls back to a keyword for want of the list. It doesn't try while no covered state has body events. An admin's rules saved meanwhile win over the carry-over, and opening the settings page can save the carry-over too, applying it at once. The carry-over: each committee name matched to a committee by its name or short name ("Health" for "Committee on Health"), a name matching none (the Council's "Legislative Meeting") as a keyword in a topic, which matches the event's title, #217's hearing types as event types, and its keywords and tracked-bills flag as they were. Clearing the rules drops both, so the fork's rules don't come back.

**Capabilities.** The same answer carries the capabilities of each covered state (`central/src/lib/capabilities.ts`): `bodyEvents`, when the state's owner implements `listBodyEvents`, and `deadlines`, when its vocabulary has an event type of kind `deadline`. The instance keeps them (`association_config.state_capabilities`), and `GET /config` serves them as `capabilities`, by state. A state left out has none. Features gate on capabilities, never on a state's name. An instance none of whose states has body events asks every hour like any other (the cache stands under an hour, so each run asks), so a state claimed after the instance's first sync shows its events within the hour. A LegiScan-only instance makes one extra binding call an hour and nothing else changes. `GET /bills/labels` sends the state's `capabilities` too, and its `hasEvents` is `bodyEvents`.

**Attribution.** The footer's data credit rides on the same answer. Each provider declares `attribution` in code (`Provider.attribution`: `name`, `url`, and an optional `license` with an optional one-sentence `note` explaining it; the shape is `shared/dataAttribution.ts`), and `coverageAttribution` (`central/src/lib/attribution.ts`) returns `{ providers }` for the instance's coverage: one credit per provider that owns a covered state (the default provider first, then the rest by id, and with `*` coverage LegiScan is always credited). The instance keeps it (`association_config.data_attribution`, dropping any credit without an id, name, and http(s) link, or whose license has no name and http(s) link, and cutting names to 200 characters and notes to 500), and `GET /config` serves it as `attribution`, which the sidebar footer renders as one comma-separated "Data:" line (`OperatorBranding.tsx`): the name links to the provider's `url`, a license is linked in parentheses after it with the `note` on hover and for screen readers, and a credit with no license has no hover. Until the instance has heard from central, or when central names no provider, `GET /config` serves LegiScan's credit (`LEGISCAN_ATTRIBUTION`), so a LegiScan-only instance never loses its CC BY line. The instance asks every hour, so a claim, or a central that has just been upgraded, reaches the footer within the hour. The `DATA_SOURCES` tenant var that once named the credited providers by hand is no longer read: a tenant that still sets it is unaffected.

`POST /admin/providers/:id/sync` syncs the provider's calendar too, and reports each state under `bodyEvents`.

**For a provider.** Return every event the feed shows for the range, past ones too, each with an `event_id` the feed publishes and keeps, a kind, and an `event_hash` that changes whenever anything shown changes (date, time, location, title, agenda), but not on counts that change by themselves, like witnesses signed up. Give each agenda item the measure number your bills carry. Throw on an error or an unexpected shape, never return a partial month, and set `cancelled: true` only when the feed marks that event cancelled. The mapping test checks the recorded responses against a field inventory, like a measure's (`hearingsInventory` in `providers/lims/inventory.ts`).

### Committees

Central's `committees` table holds one row per committee a bill is referred to, and `bill_referrals.committee_id` points at it, so a committee reads the same on every bill. Rows carry the `provider` that wrote them (migration 0035). There are no memberships, chairs, or staff.

- **Ids.** The provider sets each referral's `committee_id` (and the pending `committee`'s) on the measure. LegiScan's are its own, from what `getBill` already sends, so committees cost no extra LegiScan call. A provider without integer committee ids mints them with `ctx.ids('committee', keys)`. LIMS keys a committee by its canonical name, case folded (`providers/lims/map.ts`, `committeeKey`). A referral with no id (a provider that has none for it, or DC's "Retained by the Council") is stored as before and names no committee.
- **The ingest** upserts the measure's committees just before it replaces the bill's referrals (`central/src/lib/committees.ts`). A committee keeps the provider and id that first wrote it. Its name and chamber follow the latest ingest that names it from the committee's latest session, so a committee LegiScan renames is renamed on every bill at once, and re-ingesting an older session's bill can't bring back an old name. The LegiScan bulk seed (`scripts/lib/build-bill-statements.ts`) writes committees the same way.
- **The bill API.** `GET /bills/:id` sends `committee` (the pending committee, or null) and `referrals`, in the provider's order, each `{ date, committeeId, name, chamber }`. A referral's name is its committee row's, and `committeeId` is null when no row exists.
- **Instances** pass both through in the bill detail, with no tenant schema change, and the bill page's "Committee" and "Referrals" row shows them. `bills.committee` is still only filled by demo seeds, and the detail falls back to it when central sends no committee.
- **Body events.** A provider's calendar names the committee holding each event under the id its referrals use, and writes the committee's row the same way (see "Body events" above).
- **Existing data.** 0035 fills the table from the referrals LegiScan bills already hold, so they point at real rows at once. LIMS referrals get their ids on each bill's next ingest (the post-deploy LIMS re-ingest above covers DC's tracked bills). Maryland and Virginia mint their committees' ids keyed by chamber and name (`mgaCommitteeKey`, `lisCommitteeKey`), since each chamber has its own Rules committee, and their referrals get them on their first ingest after the state is claimed.

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
   - **→ ingestor queue, tracked or not, in a snapshot provider's pass**: bills a cutover moved there that haven't had their first ingest (`carried_from` set), after the pass's other bills. LegiScan's pass queues only tracked ones (see "Moving a state to another provider").
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

Consumes from `central-legiscan-ingestor` queue. Message shape: `{ billId: number; skipFetch?: boolean; forceMetadata?: boolean; forceAI?: boolean; calendarRecheck?: string; queuedBy?: string; firstIngestFor?: string }`. A `calendarRecheck` message only rechecks the bill's calendar (see "Bill calendar entries") and calls no provider. A `queuedBy` or `firstIngestFor` message is for a moved bill's first ingest, skipped with no provider call once the bill has moved on, and a `firstIngestFor` one also once that ingest has happened (see "Moving a state to another provider").

### skipFetch branch

Used by the bulk-seed script and the `redownload-texts` admin route. Skips `getBill` entirely. Downloads any `bill_texts` row with null `r2_key` from `state_link`, then calls `notifyTenants` and returns. No `getBill` calls, but a text whose `state_link` fails (or names its version with a fragment) still falls back to `getBillText`, one LegiScan call per document.

### Normal branch (the common path)

`processBill` calls the owning provider's `fetchMeasure`. For a LegiScan bill that is `getBill`, **one LegiScan quota tick per message**, and the cron is the only gate preventing that tick. A bill of a snapshot provider (LIMS, MGA, LIS) is built from the record central stored, plus one LegislationDetails call for LIMS, and spends no LegiScan calls.

It hands the result to `ingestMeasure`, which unconditionally:

1. Reads existing `bills` row (if any) and snapshots its child rows.
2. Runs `detectChanges` to compute a list of `ChangeRecord`s.
3. Writes `bill_change_log` rows (one per detected change).
4. Upserts the `bills` row (status, title, last_action, etc.).
5. **Delete + reinsert** these child tables: `bill_history`, `bill_sponsors`, `bill_sasts`, `bill_subjects`, `bill_referrals`, `bill_extras`. Just before the referrals, it upserts the `committees` they name. `bill_calendar` is updated in place instead, and never deleted from (see "Bill calendar entries").
6. **Upsert** these child tables: `bill_texts`, `bill_supplements`, `bill_amendments`, `roll_calls`. A provider that sets `replacesRollCalls` (MGA and LIS) also has the bill's other roll calls deleted, with their member votes (see the note below this list). Every other provider's roll calls are only upserted.
7. Downloads any text without an R2 key to `bills/legiscan-{billId}/texts/{docId}.{ext}`.
8. Stamps `bills.texts_fetched_at` → derives `text_status` for the response.
9. Calls `notifyTenants` for each covering tenant.

**Note:** for a LegiScan bill, per-legislator vote rows (`roll_call_votes`) are **not** written by this path: `getBill` returns vote summaries (`MeasureVote`) only. They come from the weekly vote-dataset load (`cron/vote-datasets.ts`, from `getDatasetRaw`, when a session's dataset hash changes) and from the bulk-seed script. A snapshot provider's ingest writes them itself, from the per-member votes in its feed (`writeMemberVotes`: LIMS and LIS). A provider that sets `replacesRollCalls` (MGA and LIS) says its measure carries every roll call of the bill, so its ingest also replaces them: a roll call the bill holds that the measure no longer names is deleted with its member votes, while the bill still belongs to that provider (`central/src/lib/billRollCalls.ts`). It is opt-in, since an empty `votes` must always mean the bill has none: LIMS's details can answer with no actions (HN26-0171's do), so its ingest only upserts. That is how such a provider can change how it derives roll call ids, or stop emitting a vote, and have the old rows go on the bill's next ingest. A vote that was only re-keyed (the same date, description, tally, and chamber under a new id) isn't reported to instances as a vote added. LegiScan's ingest still only upserts.

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

*`roll_call_votes` are populated by the weekly vote-dataset load, the bulk-seed script, and snapshot providers' ingests (see the note under "Normal branch"), not by a LegiScan `getBill` ingest.

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
| `POST /admin/providers/:id/sync` (alias `POST /admin/lims-sync`, for `lims`) | Yes, through the provider's sync, in full (stored ETags ignored) | The provider's snapshot and sessions, and for LIMS 1 details call per queued bill. No LegiScan calls | Run a snapshot provider's sync now instead of waiting for its full-pass hours. It also syncs the provider's calendar, when it publishes one. `lims-sync` is the original name for DC and is kept for scripts that call it. |
| `POST /admin/state-providers/:state/cutover` | Yes, through the new provider's sync (dry run by default; `?confirm=true` to cut over) | The new provider's snapshot, and for LIMS 1 details call per moved bill with calendar entries in the dry run. No LegiScan calls | Move a state instances track to another provider, keeping every bill's handle. See "Moving a state to another provider (cutover)". |
| `POST /admin/state-providers/:state/undo-cutover` | Yes, at the previous provider's next pass (dry run by default) | LegiScan: 1 `getBill` per tracked moved bill, at its next full pass | Put a state back on its previous provider. |
| Bulk seed (`scripts/seed-legiscan.ts --from-dir`) | Yes, `skipFetch: true` | 0 `getBill`; 1 `getBillText` per text whose `state_link` fails | Seed central D1 from LegiScan bulk JSON dump. |

---

## Things to grep when this gets out of date

- **Cron logic**: `central/src/cron/sync.ts` (`runFullPass`, `applyMasterList`, `runRawPass`)
- **Ingestor**: `central/src/queue/processor.ts` (`processBill`, `ingestMeasure`)
- **LegiScan calls**: `central/src/providers/legiscan/` (the API client, and the provider that maps it onto the interface in `central/src/providers/types.ts`)
- **Snapshot providers**: `central/src/cron/sync-snapshots.ts` (`runSnapshotSync`), and `central/src/providers/{lims,mga,lis}/` (each keeps its field inventory in `inventory.ts`)
- **State ownership**: `central/src/lib/stateProviders.ts` (`loadStateOwners`, `claimState`), and the `/state-providers` routes in `central/src/routes/admin.ts`
- **Cutovers**: `central/src/lib/cutover.ts` (`planCutover`, `applyCutover`, `applyUndo`), `central/src/lib/cutoverMatch.ts`, `central/src/lib/carriedIds.ts`, `carryCalendar` in `central/src/lib/billCalendar.ts`, and `carried_from` in `ingestMeasure`
- **Cadence**: `central/src/lib/sync-schedule.ts`
- **Change detection**: `central/src/lib/detect-changes.ts`, and `central/src/lib/billCalendar.ts` for calendar entries
- **Body events**: `central/src/lib/bodyEvents.ts`, `central/src/cron/body-events.ts`, `central/src/providers/lims/hearings.ts`, `GET /tenants/:tenantId/body-events` in `central/src/routes/tenants.ts`, and on instances `api/src/lib/bodyEvents.ts` and `api/src/lib/calendarVisibility.ts`
- **Capabilities**: `central/src/lib/capabilities.ts`, and `capabilities` in `GET /config` (`api/src/routes/configApi.ts`)
- **Status vocabulary**: `central/src/providers/<id>/vocabulary.ts`, `central/src/lib/vocabulary.ts`, `shared/statusStages.ts`, and `GET /bills/labels` in `central/src/routes/bills.ts`
- **Provider extras**: `extras` in `central/src/providers/<id>/vocabulary.ts`, `central/src/lib/billExtras.ts`, `shared/providerExtras.ts`, `web/src/components/ProviderExtras.tsx`, and the inventory helper in `central/test/helpers/fieldInventory.ts`
- **Tenant consumer**: `api/src/queue/processor.ts` (`processCentralNotification`)
- **Central bill detail API**: `central/src/routes/bills.ts`
- **Tenant bill detail API**: `api/src/routes/billsApi/detail.ts` (`buildBillDetail`)
- **Schemas**: `central/src/db/schema.ts`, `api/src/db/schema.ts`
