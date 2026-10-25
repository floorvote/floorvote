# Release notes: next release

Releases are published as GitHub Releases (the first is `v2026.10.0`), and the repository holds no release notes file. This page holds the draft entries for the next release, so they're reviewed with the code that earns them. When the release is cut, paste the entries into the release body and clear this page.

Keep each entry to what a deployer or an admin needs: what changed, what to do, and anything that moves. Name no instance or tenant.

## State ownership comes only from the table

Central no longer reads the old `LIMS_STATES` env var. For one release (`v2026.10.0`) it seeded a `state_providers` row for each state the var named that had none. That seeding is gone, and so are the `MGA_STATES` and `LIS_STATES` names, which never ran. A state with no row is LegiScan's.

**Before you upgrade, confirm your `state_providers` rows with the admin read.** Any state you sync from another provider needs its row. A state `LIMS_STATES` names that still has no row, because its seed was refused or its provider wasn't configured, is LegiScan's after this release, and nothing will write the row for you:

```bash
curl "$CENTRAL/api/admin/state-providers" -H "x-admin-secret: $ADMIN_SECRET"
```

Each row lists `state`, `provider`, `status`, `previousProvider`, and `claimedAt`. A state you expect on another provider that isn't listed gets its row from a claim (`POST /api/admin/state-providers/<STATE>`, with `{"provider":"lims"}`, `"mga"`, or `"lis"`), refused while the state's current provider has tracked bills there. Then remove `LIMS_STATES` from your central's config. Leaving it set does nothing.

A fork upgrading from a build older than `v2026.10.0` has no rows to confirm. Claim DC for LIMS right after deploying central, as `docs/internal/fork-upgrade.md` says, before the next top of the hour.

## Every Maryland, Virginia, and DC bill fully ingested

Bills from the Maryland General Assembly, the Virginia LIS, and DC's LIMS now get a full ingest whether or not they match an instance's keywords, so instances covering those states receive every bill's history, sponsors, votes, and texts, not only the matched ones'. Analysis is unchanged: AI still runs only on keyword and manual matches, and untracked bills send members no notifications. LegiScan states are unchanged.

- **Nothing to configure, but bind the provider queues.** The providers declare it, and there's no switch. A provider whose queue isn't bound (`MGA_INGESTOR_QUEUE`, `LIS_INGESTOR_QUEUE`, `LIMS_INGESTOR_QUEUE`, commented out in `wrangler.example.toml`) sends these ingests to the shared queue, where they delay LegiScan's tracked bills by up to 500 ingests a pass per state. Bind each provider's queue before upgrading if you sync Maryland, Virginia, or DC from their own providers.
- **A bill whose ingest keeps failing goes back to stubs.** After three passes without a first full ingest landing, the bill gets status updates as a stub, as before.
- **A backfill over about a day.** Bills never fully ingested are queued at most 500 a pass for Maryland and Virginia and 200 for DC, so a state's existing stubs, and a new session's first pass, drain over several hourly passes rather than at once. Expect each provider's ingest queue, and each instance's queue, to stay busy meanwhile.
- **More storage and calls.** Central's D1 grows by tens of megabytes and its R2 by about a gigabyte for all three states, mostly Maryland's PDFs. DC spends one `LegislationDetails` call per changed bill, at the pace of whichever queue it is on. LegiScan's budget is untouched.

**Deploying.** Upgrade the instances before central, so a bill page shows an untracked bill's full data as full rather than as a stub (#832).

## Summary citations

Statements in an AI summary can now link to the bill text behind them, as summary citations. On an HTML bill, clicking a statement opens the bill text at the passage, highlighted. On a PDF, it opens the cited page, with the quote beside the link. A statement whose quote can't be found stays plain text.

- **A per-instance setting, on by default.** Admins can turn summary citations off in the instance's AI settings. Off, new analyses don't ask for claim sources, and existing links show as plain text. On again, stored links show again.
- **Links arrive on a bill's next analysis.** Existing summaries aren't backfilled.
- **A small added cost.** Each analysis returns about 490 more output tokens. The setting says it may raise AI costs slightly.
- **Relevance scores move slightly.** Any change to the analysis call moves them, and this one does: the mean score dropped by 0.07 to 0.19 points on the 10-point scale in testing. A few more bills than re-running the same analysis would move may cross the digest's relevance threshold when they are next analyzed.
- **A claim can link to several passages.** When a claim draws on separate passages, the link opens all of them highlighted, scrolled to the first, and a PDF's quote box lists each quote under its page. A quote the model stitched together with ellipses is split and resolved per passage. A claim whose quote only partly matched shows the model's whole quote in its preview, not a short fragment.
- **Operators can see how well links resolve.** Central's dashboard shows, for each instance, its stored claim sources counted as exact, normalized, fuzzy, anchored, ungrounded, or unverified (PDF quotes the instance can't check), plus how many analyses asked for claim sources and stored none, and how many responses were cut off inside them and retried without them. See "Summary citations" in the operating guide.

**Deploying.** Deploy central before the instances. An instance on an older central keeps working and simply doesn't ask for claim sources. An instance that hasn't been upgraded shows its claim source counts as unavailable in central's dashboard until it is. The instance migration only adds nullable columns.

## Committee filter

The Bills page has a Committee filter. It lists each committee with its number of bills, grouped by state, with the committees holding the most bills first and ties in alphabetical order. A switch chooses whether a bill counts for the committee it is pending in now ("Current committee") or for any committee it was referred to ("Any referral," the default). The filter is in the page address and saved views as `committee` and `committeeScope`. On a computer, the menu works like the Subject menu: a search box narrows the committees by name, the heading of the state on screen stays pinned at the top while the list scrolls, and the scope switch sits above the list on the same gray as the state headings.

- **Instance migration only.** Instance migration 0116 adds an empty `bill_committees` table. Central doesn't change, since it already sends each bill's committees.
- **Run the refresh after deploying each instance.** An instance stores a bill's committees only when the bill is next delivered, and an analyzed bill that hasn't changed isn't redelivered. Until the refresh runs, the counts and the filter cover only bills delivered since the deploy. Fill every bill at once with `POST /admin/refresh-metadata` on the instance (an admin request). It queues one metadata-only delivery per stored bill, so one central fetch each: about 52,000 on the largest instance. It runs no AI, and it rewrites each bill's stored metadata from central.

## Comment attachments

Members can attach files to comments (#465): from a paperclip in the comment toolbar, by dropping files on the composer, or by pasting. Posted comments list their files with a Download link, and admins see storage used against the quota in Settings. The feature stays off, and nothing needs doing, until you set it up.

**To turn it on for an instance** (optional, and never on a demo instance, where it stays off regardless): create a private R2 bucket (no public access, no `r2.dev` URL), bind it as `ATTACHMENTS_BUCKET` (`api/wrangler.example.toml` has the block), and deploy as usual. Uploads stream through the instance's Worker, so the bucket needs no CORS rule and no API token. Several instances may share one bucket, since each stores its files under its `TENANT_ID`. `scripts/new-instance.sh` now does this for each new instance, creating `<prefix>-<slug>-files` and binding it, unless you pass `--no-attachments`. It adds a step 3, so every later step's number moves up by one: a `--from-step` you have noted from an earlier run now means the step before. `verify-instance.sh` prints whether an instance's attachments are on.

**Limits.** 25 MB a file, 10 files a comment, 30 uploads a member an hour, and 5 GB for the instance. Programs, scripts, web pages (HTML, SVG, JavaScript), macro-enabled Office files, and archives are refused, by name and by the file's first bytes. Files download only for a signed-in member of the instance, while their comment shows. Uploads that never finish are deleted after an hour, uploads never posted after a day, a deleted comment's files 30 days after the delete, by the hourly cron, which also removes within the hour any file whose comment was removed with its member's account. The admin data export lists the files (not their contents).

**Deploying.** Migration `0115` adds the `comment_attachments` table and touches no existing table.

## Central's provider-neutral names

Central runs LegiScan and every opt-in provider, so its entry file, migrations folder, and npm scripts drop the LegiScan name. Nothing breaks: the old names keep working as aliases for now, and a later release removes them.

| Old name | New name |
|---|---|
| `src/index-legiscan.ts` | `src/index.ts` |
| `migrations-legiscan/` | `migrations/` |
| `npm run deploy:legiscan` | `npm run deploy:central` |
| `npm run migrate:legiscan:remote` | `npm run migrate:central:remote` |
| `npm run migrate:legiscan:local` | `npm run migrate:central:local` |
| `npm run smoke:legiscan` | `npm run smoke:central` |

**Switch your `central/wrangler.toml`** before the aliases go. Under `[env.legiscan]`, set:

```toml
main = "src/index.ts"
```

and under `[[env.legiscan.d1_databases]]`:

```toml
migrations_dir = "migrations"
```

Then deploy with `npm run deploy:central`. Both sets of names build the same worker and list the same migration files, and wrangler records an applied migration by its filename alone, so a database migrated under the old names has nothing new to apply under the new ones.

- **What doesn't change.** The `legiscan` wrangler environment (`--env legiscan`), the deployed worker's name (`floorvote-central-legiscan`), and your D1 database, bucket, and queue names all stay as they are. (The bill handle prefix changes in this release too, but separately: see [Neutral bill handles](#neutral-bill-handles).)
- **`migrations-legiscan` is now a symlink to `migrations`.** A checkout without symlink support (Git for Windows with `core.symlinks` off) gets a plain file in its place, and wrangler then finds no migrations under the old name without saying so. Switch to `migrations_dir = "migrations"`, or check out on macOS, Linux, or WSL.
- **Your own files in `central/migrations-legiscan/` need to move.** A checkout or fork with files of its own in that folder, committed or untracked, will see a refused pull or a git conflict, since the folder is now a link. Move them to `central/migrations/` under the same filenames, so wrangler still records them as applied and nothing runs twice.
- **A fork that sets `SMOKE_BASE_URL` inline on `smoke:legiscan`** should move that to `smoke:central`, which `deploy:central` and `npm run deploy` now run. `smoke:legiscan` runs `smoke:central`.

## Draft bills move to the Bills page

Admins create draft bills from the Bills page now. An **Add draft bill** button sits there: one click on a single-state instance, a menu of the instance's states first on a multi-state one (a two-letter state field instead, until the instance has bills). Right after creating a draft, its page shows a **Discard draft** button that removes it in one click, with no confirmation while nothing has been added to it. It only appears on arrival from that button, so a reload, a link, or an ordinary visit never shows it. Settings → Draft bills is gone, and `/admin/drafts` redirects to the Bills page with the Drafts filter on, so old links and bookmarks still land on the draft list.

Admins can also delete drafts in bulk. In the Bills page's bulk edit view, a **Delete drafts (N)** button appears when the selection holds drafts, including a select-all with the Drafts filter on. It deletes only the drafts and leaves any filed bills in the selection alone.

A draft with engagement (votes, positions, comments, or notes) can now be deleted, from the bill page's overflow menu, the bulk edit view, or **Discard draft**. A confirm first names the team's votes, comments, notes, and positions on it. Those go with the draft, along with any files attached to its comments. To keep that work, link the draft to its filed bill instead.

- **Nothing to configure.** No migration. `POST /bills/bulk-delete` is new: admin only, refused in a demo, and up to 1,000 drafts a request. `DELETE /bills/:id` deletes a draft with engagement only with `?includeEngaged=1`; without it, it still answers 409.
- **A locked demo shows these buttons disabled,** with the same "Locked in demo mode" hover as the other demo-locked controls.

## Neutral bill handles

Instances now store a central bill's handle as `bill:<n>`, not `legiscan:<n>`. The prefix always meant "central bill," not where the data came from, and central now runs providers besides LegiScan. Both forms mean the same bill, and instances and central accept either.

- **Migration `0119` rewrites stored handles.** It rewrites `bills.external_id` and the two handle columns in `bill_identical_links`, and only well-formed `legiscan:<n>` values. It leaves bill ids, child rows (notes, votes, comments, texts, calendar entries), and `text_r2_key` alone. Hearing UIDs keep the legacy form for good, so subscribed calendars don't churn. A bill held under both spellings keeps both rows, and running the migration again changes nothing.
- **Deploy in either order.** Central sends `bill:<n>` only to an instance that says it reads that form: queued messages ask the instance's `CentralApi.capabilities()` (cached for a minute), and the instance's own requests to central carry an `x-handle-form: neutral` header. Any other instance keeps receiving `legiscan:<n>`, and so does one central reaches only over HTTP, with no RPC binding. Upgrading central first is the intended order.
- **Fork code that matches a prefix needs to change.** Build and parse handles with `shared/billHandle.ts` (or `central/src/lib/billHandle.ts` in central). A query or check for `LIKE 'legiscan:%'` misses every migrated row. See `docs/internal/fork-upgrade.md`.
- **A demo instance's reset during the deploy.** `api/deploy.sh` applies migrations before the new Worker goes live. A demo reset that fires in that gap, or after a rollback to an older build, re-seeds nothing until the next reset under this build. Deploy a demo instance away from its reset times.

## A member's "Title," and no more `subtitle`

The line under a member's name is called "Title" everywhere now, on the Profile page, in the database, and in the API. It used to be "subtitle." The instance API no longer returns or accepts `subtitle` (or the `userSubtitle` and `authorSubtitle` aliases) anywhere it returned a member: sign-in, members, roles, bills, comments, the feed, notifications, and the export. It returns `title` only, and a `subtitle` sent in a profile update is ignored.

- **Migrations `0105` and `0120` move the values.** `0105` adds `users.title` and copies every `subtitle` into it. `0120` copies any `subtitle` into a `title` that's still empty. A title already set wins. The `users.subtitle` column itself stays one more release, so the previous build keeps working while a deploy is under way, and a later release drops it.
- **Fork code that reads or writes `users.subtitle` should move to `title` now.** Any query that names the column fails once the later release drops it.
- **Clients that read `subtitle` from the API** need to read `title`. The web app already does.

## Congress from GovInfo (optional)

Central can now sync Congress (`US`) from GovInfo's public Bill Status data, with roll calls from the House Clerk and the Senate, in place of LegiScan. Nothing changes until an operator claims or cuts over `US`. Bills and votes need no key. An optional Congress.gov API key, `CONGRESS_API_KEY`, adds committee meetings. The steps are on the new operator page, **Congress from GovInfo** (`docs/content/self-hosting/congress.md`).

- **Cut over before January 3, 2027,** if you track Congress through LegiScan now. After that date, a cutover matches only the 120th Congress's bills, and GovInfo's 120th session loses the plain slug.
- **Wait for the follow-ups before confirming a cutover.** A cutover today leaves a second legislator row for anyone who sponsors none of the bills it reads (#912), and it can't fill the committee-meeting cache before the switch (#913). The dry run (`POST /api/admin/state-providers/US/cutover`, without `confirm`) is safe to run now.

## One feed, with a daily row for bills with no priority

The Feed is one view now. Its scope dropdown, with the "All analyzed bills" scope, is gone. Legislative activity on analyzed bills with no priority gets one row a day instead: "Updates on 9 bills with no priority," then the two most relevant bills as chips and a count of the rest. Opening the row lists every bill that moved, most relevant first, with that day's changes. Admins can set a priority from the row, which takes the bill out of it and gives the bill a card of its own from then on. A day when only one such bill moved shows that bill as a regular card, with "Set priority" at its top right for admins. Team activity keeps its full cards, as before.

- **Instance migration only.** Instance migration 0121 adds the row's event type, `no_priority_updates`, to `feed_events`. Central doesn't change. `GET /feed` reads no `scope` any more, so an old client or bookmark that sends `scope=analyzed` gets the one feed.
- **The row starts with the deploy.** The queue processor writes it as legislative changes land, so days before the deploy have no row, and the movement on them isn't listed anywhere on the Feed. The bills' own pages still show it.
- **Notifications don't change.** The row and the one-bill card never light the Feed dot, raise the "New activity" banner, or appear in the digest email.

## The engagement pull runs at 06:15 UTC

Central's daily engagement pull now runs on its own cron, `15 6 * * *`, instead of on the 06:00 hourly tick. On that tick it shared Workers' per-invocation limit on outbound calls with the hourly sync, which held its calls to the instances back for up to a minute, so the "slow or failing" email named every instance as slow when none was.

- **Add the cron to your central's config:** `crons = ["0 * * * *", "15 6 * * *"]` under `[env.legiscan.triggers]`, as in `wrangler.example.toml`.
- **Without it, the pull still runs**, from the 07:00 hourly tick, with the sync's calls competing for the same limit as before.

## Sync alerts: every four hours, LegiScan states, and a resolved email

Central's sync failure emails change in three ways.

- **Fewer repeats, on a clock.** A session that keeps failing emails once its failed passes have lasted four hours (the time from the first failed pass to the current one), then at most once every four hours while it goes on, not on every pass from the 4th on. A session that passes hourly emails at about 4, 8, and 12 hours of an outage instead of every hour. One that passes daily emails on its 2nd failed pass, about a day in, and on each later one.
- **LegiScan states alert now.** A LegiScan pass that failed used to be logged only to the Worker's console. It now writes a failed row to the sync log, shows as failed on the States and Sync pages, and alerts by the same rule, with every state on an alerting pass in one `cron failed: ls-sync` email. On LegiScan's default hours, the first alert comes six to ten hours into an outage. A session with no bills, or a light check that finds no changes, never counts as a failure.
- **A resolved email.** A session that alerted gets one `resolved: <job>` email on the pass that finishes, naming the sessions that recovered, how long they failed, and since when. If other sessions in the same job are still failing, the email lists them under "Still failing" and never says the whole job is syncing again. A failure that clears before it alerted sends nothing.

**Nothing to configure.** The emails go to `ALERT_EMAILS`, as every job alert does, and there's no migration. The cadence is measured in hours, so it is the same however often a session passes.
