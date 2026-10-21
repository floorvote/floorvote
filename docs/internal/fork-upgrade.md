# Moving a Fork onto Upstream

This guide is for a downstream fork that runs DC from the Council's LIMS in production and wants to run upstream FloorVote instead. It was written for, and rehearsed on, the Open-City-Advocates fork (`oca-production` at `dfb763d`, October 2, 2026). That fork's DC work is @anotherpanacea-eng's (#206, #214, #216, #217, #218, and #254–#259), and upstream's provider model (#283) is built from it, so most of the fork's DC code now has an upstream home. Another fork that runs its own features on top of upstream can use the same steps.

Upgrade to an upstream release that includes the provider model: `main` once #358 merges (closing #303), `provider-model` until then. The commands below call it `<ref>`.

## What Comes Through Unchanged

- **DC bill, session, and people ids.** LIMS still packs them into the same reserved ranges (`central/src/providers/lims/ids.ts`), and migration 0025 marks every row in those ranges as LIMS's. Each instance's bills keep their ids and handles.
- **Bill calendar UIDs.** Rows written before migration 0034 keep the identity instances built their UIDs from, including the " (2)" the old LIMS mapping added to a second hearing with the same text. That hearing's description loses the " (2)" at its first re-ingest, so its `SEQUENCE` moves once and the team gets one "hearing changed" entry, under the same UID.
- **Council hearing UIDs.** Upstream's body events keep `council-<hearingId>@lims.dccouncil.gov` and #217's event hash, so subscribed calendars see no change, and each instance's Council rows are taken over in place: same row id, same UID, same `SEQUENCE`.
- **The fork's own tables and columns,** central (`council_*`, `people.term_start`, `people.term_end`, `people.seated`) and instance (`deep_analyses`, `team_links`, `crm_*`). No upstream migration or code reads or writes them, and every CRM, team link, and deep analysis row still points at its bill or event.
- **#217's deadline rows.** Tenant migration 0079 files them as bill entries of kind `deadline` under the same UIDs. There's nothing to run by hand.
- **Each team's Council calendar settings.** #217's `council_calendar_rules` become the instance's event rules (#298), selecting the same Council events.

Three tests prove this on the fork's own data, which its own code wrote from the recorded LIMS fixtures, with no access to anyone's account:

- `central/test/cron/fork-upgrade.test.ts` builds central from the fork's migrations folder and rows, applies upstream's migrations, and runs upstream's DC sync, the LIMS re-ingest, and the Council calendar sync.
- `api/test/migrations/forkUpgrade.test.ts` does the same for an instance: the fork's tenant migrations (0071, 0072, and 0074 included), then upstream's, then what upstream's central sends it, including the event rules carry-over.
- `scripts/lib/fork-upgrade-rehearsal.test.ts` tests the script you run against copies of your own databases (below).

## What Members Will Notice

- **Council events.** A team with #217 calendar settings keeps seeing the events it chose. Within an hour of the upgrade, once central answers the instance's committee options call, the hourly sync saves those settings as event rules. If they name committees, it waits until at least one committee is known. Until then, and for good if central never answers, every Council event shows, and an admin can save the carried-over rules from the Calendar page's control (any choice made there saves them). A team with no #217 settings goes from seeing no Council events to seeing every one until an admin chooses.
- **Deadlines.** A deadline of a tracked bill with no priority leaves the calendar and the ICS feed, as that bill's hearings do. It still shows on the bill page.
- **Expired bills** are staged enacted (tenant migration 0078), since what expires is mostly emergency and temporary acts that were law until their term ran out.
- **The bill page** gains DC's law, act, and resolution numbers, who asked for a measure, and more, in the meta row and under it, and hearing videos, once each bill is re-ingested (step 2 of "After You Deploy"). The review dates DC's extras once carried (sent to the Mayor, signed, and the rest) are gone, since the timeline and calendar show them. Ship central before the page: a page older than central's placements shows every extra in the fold-out. If you also track Virginia from LIS, re-ingest its bills (`?provider=lis`) to drop the earlier summaries that repeat the latest.
- **ICS feeds.** An event the team's rules hide drops out of the feed, as it leaves the calendar page.

## Build Your Upgrade Branch From Upstream

Start a fresh branch from upstream and cherry-pick only what is yours. Don't merge upstream into your production branch: upstream reshaped the DC code your fork carries, so a merge conflicts on nearly every DC file and keeps both versions of what it doesn't conflict on.

```bash
git remote add upstream https://github.com/floorvote/floorvote.git   # once
git fetch upstream
git worktree add ../floorvote-upgrade upstream/<ref>   # main, or provider-model until #358 merges
cd ../floorvote-upgrade
git checkout -b upgrade-to-upstream
git cherry-pick -x <sha>   # each fork-only commit, oldest first
```

A worktree keeps your production checkout, and its gitignored `wrangler.toml` files, as they are. Copy those files into the new worktree. They need no changes beyond the ones under "Before You Deploy."

What to keep from `oca-production`:

| The fork's feature | Upstream | What to do |
|---|---|---|
| LIMS sync and ingest (`central/src/cron/sync-lims.ts`) | The LIMS provider (`central/src/providers/lims/`) | Drop it |
| Council calendar sync, `/bills/council-events`, the instance's Council mirror (`api/src/lib/councilCalendar.ts`) | Body events (#297) | Drop it |
| Council calendar settings (`CouncilCalendarSettings`) | Event rules (#298) | Drop it |
| DC deadlines | Deadline calendar entries (#295) | Drop it |
| DC explainers for bill types and statuses | The status vocabulary and `/bills/labels` (#291) | Drop it |
| Per-member votes on bill pages | Upstream since #214 | Drop it |
| A roundtable linked to its hearing notice | Body event agenda links (#297) | Drop it |
| Council directory, committees, membership history, and the People page (central 0022–0024, `dccouncil-directory.ts`, `council-changes.ts`, `/bills/council-directory`) | None | Cherry-pick it |
| The DC directory CRM (tenant 0074) | None | Cherry-pick it |
| Deep analyses and hearing briefs (tenant 0071) | None | Cherry-pick it |
| Team links (tenant 0072) | None | Cherry-pick it |
| gitleaks allowances for dccouncil.gov | None | Cherry-pick them with the directory |

When porting what you keep:

- **The directory refresh ran inside the old LIMS sync** (`runLimsSync`). Upstream's LIMS provider doesn't run it, so give it a cron job of its own in `central/src/index.ts`, beside the provider jobs. Select DC's legislators by `people.provider = 'lims'`, not by id range. Until it runs, the `council_*` tables and the seated and term columns go stale. Nothing is lost.
- **So did the term refresh.** `people.term_start` and `people.term_end`, and the "sworn in" and "leaving" rows of `council_changes`, came from the old sync's `upsertMembers` and `diffTerms` (`central/src/cron/sync-lims.ts`), not from the directory code. Upstream's LIMS provider reads the same Members call but keeps no term dates. Port that part into the directory job: fetch each Council Period's members, write only `term_start` and `term_end` by `people_id`, and record the changes. Without it, a special election leaves the People page and hearing briefs with stale terms, and nothing says so.
- **Instances reach central only through the tenant surface allowlist** (`central/src/lib/tenantSurface.ts`), which denies everything else. Add each fork-only route an instance calls, such as `GET /api/bills/council-directory`, and list it in the caller test beside it. Register the route ahead of `/bills/:id`, which would otherwise answer for it.
- **Council rows become body events.** Upstream's mirror takes over each `source = 'council'` row as `source = 'body'`, under the same id and UID. Code that selects `source = 'council'`, as the fork's hearing briefs (`deepAnalysis.ts`, `deepApi.ts`) and event popover do, must select `source IN ('body', 'council')` instead, or it finds nothing once the mirror has run. The mirror only takes over rows in its window (a month back and four ahead), so older Council rows stay `'council'` for good. Existing rows that point at a Council event's id stay valid.
- **Key what you keep to upstream's ids.** Point CRM and analysis rows at instance bill ids, central `people_id` (LIMS keeps its packed range), and committees by the central `committee_id` instances get from `body-event-options`, not by display names. Build and parse bill handles with the shared helpers (`shared/billHandle.ts`), never by matching a prefix: handles moved from `legiscan:` to the neutral `bill:` (#305), and a row may hold either. Hearing UIDs keep their form for good.
- **Nothing may write `council_events` or read `lims_records`.** Migration 0029 drops `lims_records`, and `council_events` is left only for you to drop.
- **Read a member's title from `users.title`.** Instance migration 0105 adds `users.title` and copies `users.subtitle` into it, keeping `subtitle` for one release so a rollback still works. Upstream's code writes both and reads `title`, falling back to `subtitle`. Fork code that reads or writes a member's `subtitle` should move to `title`, and write both until a later migration drops `subtitle`.

## Migrations Coexist by Filename

Wrangler records each applied file by name in `d1_migrations` and applies every file in the folder it hasn't recorded, in order. Your production has applied your own files and upstream's under different names, so both sets apply and nothing runs twice. Your central's `0020_lims_records.sql` and upstream's `0020_legiscan_limit_10k.sql` are both recorded, and upstream's `0021_lims_records.sql` creates `lims_records` only if it doesn't exist, so it keeps yours, which has the same columns.

- **Upstream keeps your numbers and names free.** Central 0022, 0023, and 0024 and tenant 0071, 0072, and 0074 are reserved upstream for good. `AGENTS.md` also lists your tables and columns (`council_*`, `people.term_start`, `people.term_end`, `people.seated`, `deep_analyses`, `team_links`, and `crm_*`), which upstream never creates, changes, or assumes exist or don't.
- **Put future fork-only migrations in their own range:** `0900_oca_<what>.sql`, in `central/migrations/` or `api/migrations/`. Upstream leaves 0900 and up to forks, and `AGENTS.md` records that, so your names never meet upstream's. Use the next free number in the range for each one.
- **Never rename or edit a file production applied.** A renamed file runs again.
- **Change only your own tables.** Never alter or drop an upstream table or column. A column you add to an upstream table (as `people.seated` is) is one upstream could someday add under the same name, so prefer a table of your own keyed to upstream's id.
- **No `;` inside a comment** in a migration file. The tenant test helper splits on it before stripping comments, and the error it gives points elsewhere.
- **Register each tenant migration of yours in the api tests.** `applyMigrations()` in `api/test/helpers.ts` lists tenant migrations by name, so add every one you keep (0071, 0072, 0074, and each future `0900_oca_*`) or the api tests run without your tables. Central's tests read the whole folder.
- **Rehearse before each upstream upgrade.** The script below lists your tables and columns and names any upstream migration that would meet one.

## Keep Fork Features Separate

Your data layer is already apart from upstream's: the 0900 range, the tables and columns `AGENTS.md` lists as yours, and the rehearsal script. Your feature code isn't. The Council directory, CRM, deep analyses, team links, and hearing briefs hook into shared upstream files: the cron list in `central/src/index.ts`, the tenant surface allowlist (`central/src/lib/tenantSurface.ts`), the api router, and the web routes. Each upstream change to one of those files is a hand merge. This is fork-side work. Upstream adds nothing for it and promises no hooks.

The pattern that keeps those merges small:

1. **Put fork-only code in fork-only folders** that upstream never creates, such as `central/src/fork/`, `api/src/fork/`, and `web/src/fork/`.
2. **Cut each edit to a shared file down to one line** that hands off to your folder. One call registers your crons, one adds your routes, one extends the allowlist, and one adds your web routes. An example only, not an upstream API:

   ```ts
   // central/src/index.ts: the only line of yours in this file
   registerForkCrons(jobs);
   ```

3. **List the folders and the hook lines in your overlay manifest, and check them in CI** after each upstream merge. A merge that drops a hook line fails the build instead of silently turning a feature off. This is the "assert your overlay in CI" pattern from [Forking and operator overlays](../content/contributing/index.md).

When upstream changes a feature you extended, such as a simpler event-rules UI (#420), you can take upstream's version or keep yours as a fork feature in your folder. Either way, its data stays yours.

## Before You Deploy

1. **Configuration.** Your gitignored `central/wrangler.toml` names `src/index-legiscan.ts` and `migrations-legiscan`, which still work as aliases of `src/index.ts` and `migrations`. Switch to the neutral names when you like. Keep the `LIMS_API_KEY` secret (claiming DC for LIMS needs it), the hourly cron, and `LIMS_INGESTOR_QUEUE` with its consumer at `max_concurrency = 1` (LIMS answers 429 above about two concurrent requests). Compare the rest with `central/wrangler.example.toml`. Deploy central before the instances. Each instance's footer credit comes from central now (DC's from the LIMS provider's own declaration), so the LIMS credit is there when the tenant upgrades. Each instance can then drop `DATA_SOURCES = "lims"`, and one that still sets it is unaffected. Its `PROVIDER` var is no longer read. Keep your deep analysis vars if you ported that feature.
2. **Rehearse on copies.** Export each database, read-only, from your production checkout (so wrangler finds the bindings), into a directory outside both checkouts: the exports hold members' emails and sign-in history, and `.gitignore` doesn't cover `*.sql`. A D1 export holds up the database's other queries while it runs, so start it away from the top of the hour. Then run the rehearsal from your upgrade branch, with absolute paths:

   ```bash
   EXPORTS=~/floorvote-exports && mkdir -p "$EXPORTS"
   cd central && npx wrangler d1 export <central-db> --remote --env legiscan --output "$EXPORTS/central.sql"
   cd ../api && npx wrangler d1 export <tenant-db> --remote --env <tenant> --output "$EXPORTS/tenant-<tenant>.sql"
   # from the upgrade branch:
   git fetch upstream
   npx tsx scripts/rehearse-fork-upgrade.ts --central "$EXPORTS/central.sql" --instance "$EXPORTS/tenant-<tenant>.sql"
   ```

   Pass `--instance` once for each instance. The script tells upstream's migration files from the ones you cherry-picked by reading `upstream/main`, so it checks your own tables and columns too. Pass `--upstream-ref upstream/provider-model` until #358 merges, or whatever ref you built the branch from. If git can't read the ref, the script stops and shows git's error rather than guessing which files are yours. On a plain upstream checkout with none of your files, pass `--upstream-ref HEAD`. A pending file that isn't at the ref is listed as your own, so a file there that isn't yours means the ref is stale or wrong. Each copy takes every pending upstream migration in memory, and the script checks what this guide says comes through unchanged, then notes what to expect for your data. It only reads the exports, and writes nothing unless you pass `--save <dir>`. It exits 1 if any check fails, and each failure says what to look at. The exports hold your data, so delete them when you're done.

3. **The DC preflight.** The script runs it, and you can run it alone, read-only:

   ```bash
   npx wrangler d1 execute <central-db> --remote --env legiscan --command \
     "SELECT COUNT(DISTINCT b.bill_id) AS n FROM bills b JOIN bill_tenants bt ON bt.bill_id = b.bill_id
      WHERE b.state = 'DC' AND (b.bill_id < 1000000000 OR b.bill_id >= 2000000000)"
   ```

   To see which bills those are, list their ids instead of counting them:

   ```bash
   npx wrangler d1 execute <central-db> --remote --env legiscan --command \
     "SELECT DISTINCT b.bill_id, b.bill_number FROM bills b JOIN bill_tenants bt ON bt.bill_id = b.bill_id
      WHERE b.state = 'DC' AND (b.bill_id < 1000000000 OR b.bill_id >= 2000000000) ORDER BY b.bill_id"
   ```

   It must be 0: no LegiScan DC bill is tracked by an instance. Otherwise upstream refuses the claim of DC for LIMS, since instances would hold both providers' copies of the same bills, and DC stays on LegiScan (see "If Something Goes Wrong").

## Deploy

Deploy central, claim DC, then deploy every instance, all before the next top of the hour. The first DC sync after the upgrade runs then and sends each instance its notifications, which each instance should take in on upstream's code.

**A fork on a build older than v2026.10.0** (before the ownership table, #303) upgrades in two steps. Deploy v2026.10.0 first, with `LIMS_STATES` set, and let one top-of-the-hour sync write DC's ownership row. Then deploy this release. That closes the late-claim window, and the claim step below finds DC already owned.

1. **Central.** `cd central && npm run deploy:central`. It builds the dashboard, applies the migrations, and deploys, so the code follows the migrations within a minute or so. Start at least 15 minutes after the hour, once the LIMS ingestor queue shows no backlog in the Cloudflare dashboard, so the old code's hourly LIMS pass isn't running.

   Between the migrations and the new code, the old LIMS sync and ingest fail (migration 0029 drops `lims_records`) and their messages retry. A message that runs out of retries before the new code deploys is lost. A tracked bill recovers at the re-ingest below, and any other bill at its next change. A bill the old code inserts in that window is labeled LegiScan's and blocks DC's ownership row (see "If Something Goes Wrong"). To rule both out, first deploy your current code with `crons = []` under `[env.legiscan.triggers]`, then upgrade. Deleting the triggers block wouldn't do it: wrangler changes a Worker's schedules only when the config defines `crons`, so without one the hourly cron keeps firing. The upgrade's configuration brings the hourly cron back.

   Central migration 0036 (cutovers) only adds tables and nullable columns, and 0037 (body events) only adds tables, so neither needs anything run.

2. **Claim DC for LIMS,** as soon as central is deployed:

   ```bash
   curl -X POST "$CENTRAL/api/admin/state-providers/DC" -H "x-admin-secret: $ADMIN_SECRET" \
     -H 'content-type: application/json' -d '{"provider":"lims"}'
   ```

   It answers 200 when no LegiScan DC bill is tracked, which the preflight checked. Claim before the next top of the hour. A state with no ownership row is LegiScan's, so without a claim, the next LegiScan sync could link LegiScan's copies of DC bills to instances, and the claim would then be refused (409). Nothing else writes DC's row. Upstream no longer reads `LIMS_STATES` (#319), and your migrations write no row, so the claim is the only way DC moves to LIMS, with no safety net for a late one. A fork on a build older than the ownership table (#303) has no row until it claims. A late claim can also leave DC's session URLs on LegiScan's sessions for good when the central holds LegiScan DC sessions: slugs never change, the first cron tick slugs every session, and LegiScan's sessions go first while DC has no row, so the current Council Period gets "-2". That slug is permanent: slugs never change once assigned, and there is no hand fix (the rehearsal notes it). `central/test/cron/fork-upgrade.test.ts` covers the claim, a refused claim, a claim after the first tick, and `LIMS_STATES` left set or removed.

3. **Each instance.** `cd api && npm run deploy:tenant -- <tenant>`. Until an instance is upgraded, its old Council mirror calls `/bills/council-events`, which upstream central doesn't have, and fails without changing the rows it holds. Its directory pages fail the same way until your ported directory route is deployed.

## After You Deploy

1. **Confirm DC's ownership row.** Your claim writes it.

   ```bash
   curl "$CENTRAL/api/admin/state-providers" -H "x-admin-secret: $ADMIN_SECRET"
   ```

   DC should be `lims`, `active`, with `previousProvider` `legiscan`.

2. **Re-ingest each instance's DC bills from LIMS,** so they gain extras, videos, and documents, and their calendar rows store the identities instances hold:

   ```bash
   curl -X POST "$CENTRAL/api/admin/reingest-tenant/$TENANT?provider=lims" -H "x-admin-secret: $ADMIN_SECRET"               # dry run: how many
   curl -X POST "$CENTRAL/api/admin/reingest-tenant/$TENANT?provider=lims&confirm=true" -H "x-admin-secret: $ADMIN_SECRET"  # queue them
   ```

   It costs one LIMS details call per bill, paced at one a second, and no LegiScan calls.

3. **Check each team's event rules** through the Calendar page's "Event filters" button (admins only) within the hour. It shows the committees, and one line, "Kept from an earlier setting: …", for the rest of a carried-over rule: hearing types as event types, topic keywords, and the tracked-bills choice. They should match the team's #217 settings.
4. **Check the LegiScan budget.** Central migration `0020_legiscan_limit_10k` lowers the dashboard's monthly budget from 30,000 to 10,000 calls (LegiScan's free tier since October 1, 2026) if you never changed it. Raise it on the dashboard if you pay for more.
5. **Remove `LIMS_STATES`** from `central/wrangler.toml` at your next deploy. Central doesn't read it (#319): only the row decides, and a state changes provider only by a claim or a cutover (`docs/internal/sync-pipeline.md`, "State ownership").
6. **Drop `council_events`** once every instance is upgraded and its Council rows are body events. Upstream's `body_events` replaced it.

   ```bash
   npx wrangler d1 execute <central-db> --remote --env legiscan --command "DROP TABLE council_events"
   ```

   Keep the other `council_*` tables if you ported the directory.

## If Something Goes Wrong

- **The claim answered 409,** and DC has no row, so LegiScan keeps syncing it. The 409 names the instances tracking LegiScan DC bills. Most likely a DC bill the old code wrote between the migrations and the deploy is labeled LegiScan's. The 409 body has only `owner`, `trackedBills`, and `instances`, no bill ids, so list the bills with the preflight's id query ("Before You Deploy", step 3, the second command) and check their ids. Ids from 1000000000 up to 2000000000 are old-code bills labeled LegiScan's: give them back to LIMS, then claim DC again. The statements below relabel bills, sessions, and people. `central/test/cron/fork-upgrade.test.ts` covers only the `bills` one. Ids below 1000000000 are LegiScan's own DC bills, and the claim was late: a LegiScan sync linked them before DC had a row, so the instances hold LegiScan copies of those bills. Relabeling doesn't help; go to the cutover paragraph below. After a relabel, run the preflight query again: if late LegiScan bills also exist, the next claim answers 409 again.

  ```sql
  SELECT bill_id, bill_number FROM bills
  WHERE state = 'DC' AND provider = 'legiscan' AND bill_id >= 1000000000 AND bill_id < 2000000000;
  UPDATE bills SET provider = 'lims'
  WHERE state = 'DC' AND provider = 'legiscan' AND bill_id >= 1000000000 AND bill_id < 2000000000;
  UPDATE sessions SET provider = 'lims'
  WHERE state = 'DC' AND provider = 'legiscan' AND session_id >= 1000000000 AND session_id < 2000000000;
  UPDATE people SET provider = 'lims'
  WHERE provider = 'legiscan' AND people_id >= 1000000000 AND people_id < 2000000000;
  ```

  The old code writes sessions and people in that window too, so give those back as well.

  If instances track LegiScan DC bills outside LIMS's ranges (the preflight wasn't 0, or it was 0 and the claim came late), move DC with a cutover, not a claim, starting with its dry run (`docs/internal/sync-pipeline.md`, "Moving a state to another provider (cutover)"). The 409 names the case:

  - **Tracked LegiScan DC bills with no LIMS copy** (the usual late-claim shape). Run the dry run, then confirm the cutover. It keeps each bill's row id and flips ownership itself as its last step, so there is no unlinking and no separate claim.
  - **Bills the dry run lists as conflicts**, because an instance already holds their LIMS copy. A cutover can't move those. Check in each instance named that it holds the LIMS copy (its bill id is in LIMS's range, 1000000000 up to 2000000000), unlink only those LegiScan copies in central, then re-run the dry run and confirm the cutover:

  ```sql
  DELETE FROM bill_tenants WHERE tenant_id = '<tenant>' AND bill_id IN (<the conflicting LegiScan bill ids>);
  ```

  The instance keeps its row for the LegiScan copy, which stops updating. Untrack that bill on the instance too: otherwise it tracks a LegiScan row that no longer updates, beside the LIMS copy.

- **Every Council event shows** after an hour. The carry-over is waiting for central's committee list. The instance logs "[event-rules] central options unavailable" when `GET /api/tenants/<tenant>/body-event-options` fails. An admin can save the carried-over rules by hand from the Calendar page's control (any choice made there saves them).
- **Hearing briefs find no events.** Code selecting `source = 'council'` wasn't ported (see "Build Your Upgrade Branch From Upstream").
- **`POST /admin/lims-import` answers 409** until LIMS owns DC.
- **`POST /tenants/seed-session/:tenantId` answers 404** for a session id central doesn't have, **and 409** for a session whose provider no longer owns its state, such as a LegiScan DC session once LIMS owns DC.

## Later

- **Moving DC between providers again.** Event rules name committees by central id, and each provider mints its own. Only if DC is later cut over between two providers that both publish body events do teams need to re-pick committees. Going from LegiScan to LIMS carries none, since LegiScan publishes no body events.
- **Each upstream upgrade.** Pull upstream into your upgrade branch (now your production branch), rerun the rehearsal on fresh exports, and deploy central, then each instance, as above.
