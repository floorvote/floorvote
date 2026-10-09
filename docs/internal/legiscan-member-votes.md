# Per-Member Votes for LegiScan States

Bill pages list how each legislator voted on each roll call, under "How each legislator voted." Central serves these as `legislatorVotes` on each vote in `GET /api/bills/:id`, read from `roll_call_votes` joined to `people`. The display reads that table whatever the provider, so a provider whose feed carries per-member votes only needs to write it (`writeMemberVotes` in `central/src/lib/rollCallVotes.ts`).

For LegiScan states, the votes come from LegiScan's weekly bulk datasets, not from `getRollCall`.

## Why the bulk dataset

`getBill` carries only each roll call's totals. Each legislator's vote is in `getRollCall`, one call per roll call. A busy session has thousands of roll calls, and the free tier is 10,000 calls a month, so per-roll-call fetching is out.

LegiScan publishes one ZIP per session, refreshed weekly, holding every `getBill`, `getRollCall`, and `getPerson` record as JSON files (`bill/`, `vote/`, and `people/`). One `getDatasetList` call per state lists every session's dataset with a `dataset_hash`, and one `getDatasetRaw` call downloads a session's archive. That makes a session's votes cost about two calls a week when its dataset changed, and one list call per state when it didn't.

## How the weekly load works

Code: `central/src/cron/vote-datasets.ts` (core), and `listVoteDatasets` and `fetchVoteDataset` in `central/src/providers/legiscan/` (the LegiScan calls). State: `sessions.votes_dataset_hash` and `sessions.votes_checked_at` (migration 0021).

The two provider members are optional parts of the Provider interface (`central/src/providers/types.ts`). Core runs the weekly load for any provider that has both and does nothing for one that doesn't. Everything that writes D1 stays in core.

1. **Daily check, at 3 ET.** The hourly cron calls `checkVoteDatasets` once a day. No default sync pass runs at 3 ET, so the check and the loads it queues don't compete with bill ingests. A session is due when its hash was last compared more than six days ago, which makes each session's check weekly, and a check that fails is retried the next day.
2. **Covered sessions only.** The check covers what the hourly sync covers: sessions of states an active instance tracks (all seeded states for a `*` instance), with `sync_enabled` on and not adjourned sine die.
3. **One list call per state.** For each state with a session due, the provider's `listVoteDatasets` runs once (LegiScan's `getDatasetList`). A session whose `dataset_hash` matches `votes_dataset_hash` is marked checked and costs nothing more. A changed session gets a `{ kind: 'vote-dataset', providerId, sessionId, key, hash }` message on the ingestor queue. It shares the ingestor queue so self-hosted configs need no new binding.
4. **Streaming load.** The ingestor consumer calls `loadVoteDataset`, at most one per invocation, which gets the archive from the provider's `fetchVoteDataset` (LegiScan's `getDatasetRaw`). Further dataset messages in the same batch are re-sent with a five-minute delay. The load streams the ZIP through fflate's `Unzip` as it downloads, so the archive (tens of MB for a large state) is never read into memory whole. Every entry is started, because fflate keeps the compressed bytes of any entry that isn't. A deflate decoder registered for the load inflates `vote/*.json` and `people/*.json` and drops every other entry's bytes as they pass.
5. **Roll calls central has.** One query lists the roll calls central has for the session's bills, with how many member votes each stores. Only those roll calls are written: the bill ingest writes a roll call's totals when it fetches a bill, so these are the tracked bills (and seeded sessions). Votes for every other roll call in the session would be rows no page shows. A bill tracked later gets its votes from the next changed dataset, about a week on at most.
6. **Missing or incomplete votes only.** A roll call whose stored vote count matches the file is skipped, since LegiScan treats roll calls as static. One with no votes, or a different count (a partial write, or a correction that adds or drops a vote), is written through `writeMemberVotes`. That function packs about 2,500 votes into one statement's JSON parameter (`json_each`), deletes first only when the roll call has votes to replace, runs in one batch, and uses row ids `<roll_call_id>-<people_id>`, the same as the bulk seeder's, so the two never duplicate each other.
7. **People.** Legislators from `people/*.json` that central has no row for are inserted, with the same row mapping the bill ingest uses for sponsors (`central/src/lib/people.ts`). Without this, a legislator who never sponsored a bill would show without a name. Existing rows are left alone, because the dataset can be a week older than the `getBill` data that wrote them.
8. **Hash recorded last.** Only a load that read the whole archive cleanly records `votes_dataset_hash`.

Roll call totals stay with the bill ingest. If the load wrote `roll_calls` rows, the ingest's change detection would see a new vote as already known, and tracked bills would never get their "vote recorded" notification. The load sends nothing to instances: bill pages read votes from central when they open.

## Worker limits

- **Memory (128 MB).** The archive is streamed, and skipped entries' bytes are dropped as they arrive. At any time the load holds one download chunk, the entry being inflated, up to 300 roll calls waiting to be written, the session's people, and the list of the session's roll call ids with their stored counts.
- **D1 queries (about 1,000 per invocation).** A load counts every statement it runs, including the roll call list, the people lookup, and the people inserts, and spends at most about 400. That leaves room for bill messages in the same consumer batch, and only one load runs per invocation. Past the budget, it stops, queues the same message again, and the next invocation re-downloads the archive (one more call) and skips what's already written. Because only roll calls of fetched bills are written, a load rarely gets near the budget.
- **CPU.** Only vote and people entries are inflated and parsed.

## Failure behavior

- A response that isn't a ZIP (an HTML error page, a LegiScan JSON error), or a ZIP with no `bill/`, `vote/`, or `people/` entries, throws. The queue retries the message after 15 minutes, and the hash isn't recorded, so the next weekly check queues it again if the retries run out.
- A vote or people file that doesn't parse is skipped and counted. Everything that did parse is written, but the hash isn't recorded and the count is logged, so the archive is retried weekly (one download) until LegiScan's data is fixed.

## Call budget

Every call goes through the provider context's `logCall` into `api_call_log`, which the dashboard counts against `legiscan_monthly_limit`, under the call types `getDatasetList` and `getDatasetRaw`. A typical month is one `getDatasetList` per covered state per week, plus one `getDatasetRaw` per covered session per week while it's in session.

## Backfilling older sessions

The weekly load skips sessions the sync doesn't poll, such as adjourned ones. Backfill those with the bulk seeder, which reads the same dataset files from disk or the API (see `scripts/seed-legiscan.ts`):

```bash
# A session already seeded into central, from an extracted dataset directory:
npx tsx scripts/seed-legiscan.ts --individual-votes-only \
  --from-dir bulkseeds/legiscan/RI/2025-2025_Regular_Session \
  --state RI --session-id 2189 --remote

# A session not seeded yet, with its votes in one pass:
npx tsx scripts/seed-legiscan.ts --with-individual-votes \
  --from-dir bulkseeds/legiscan/RI/2025-2025_Regular_Session \
  --state RI --session-id 2189 --remote
```

`--individual-votes-only` writes only `roll_call_votes` and leaves bills, people, and roll call totals alone. It needs `--from-dir`. People must already be seeded (a full seed does it), or names fall back to person ids. For the second form, `--from-api` downloads the archive instead of reading a directory, at one `getDataset` call against the same monthly budget. The seeder writes with its own SQL through `wrangler d1 execute`, but its row ids match `writeMemberVotes`, so running both over one session is safe.

To make the weekly load revisit a session, clear its hash. The next weekly check then downloads the dataset again, and fills roll calls whose stored vote count differs from the file:

```sql
UPDATE sessions SET votes_dataset_hash = NULL, votes_checked_at = NULL WHERE session_id = 2189;
```

A correction that changes how someone voted without changing the count isn't detected that way. To rewrite every roll call of a session, delete its stored votes as well, then clear the hash:

```sql
DELETE FROM roll_call_votes WHERE roll_call_id IN (
  SELECT rc.roll_call_id FROM roll_calls rc JOIN bills b ON b.bill_id = rc.bill_id WHERE b.session_id = 2189);
UPDATE sessions SET votes_dataset_hash = NULL, votes_checked_at = NULL WHERE session_id = 2189;
```
