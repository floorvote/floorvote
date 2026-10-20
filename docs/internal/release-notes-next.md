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

The Bills page has a Committee filter. It lists each committee with its number of bills, grouped by state, with procedural committees (Rules, Assignments, Calendars) last and tagged "Procedural." A switch chooses whether a bill counts for the committee it is pending in now ("Current committee") or for any committee it was referred to ("Any referral," the default). The filter is in the page address and saved views as `committee` and `committeeScope`.

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

- **What doesn't change.** The `legiscan` wrangler environment (`--env legiscan`), the deployed worker's name (`floorvote-central-legiscan`), your D1 database, bucket, and queue names, and the bill handle prefix all stay as they are.
- **`migrations-legiscan` is now a symlink to `migrations`.** A checkout without symlink support (Git for Windows with `core.symlinks` off) gets a plain file in its place, and wrangler then finds no migrations under the old name without saying so. Switch to `migrations_dir = "migrations"`, or check out on macOS, Linux, or WSL.
- **A fork that sets `SMOKE_BASE_URL` inline on `smoke:legiscan`** should move that to `smoke:central`, which `deploy:central` and `npm run deploy` now run. `smoke:legiscan` runs `smoke:central`.
