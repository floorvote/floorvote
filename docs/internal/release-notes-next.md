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

## Summary citations

Statements in an AI summary can now link to the bill text behind them, as summary citations. On an HTML bill, clicking a statement opens the bill text at the passage, highlighted. On a PDF, it opens the cited page, with the quote beside the link. A statement whose quote can't be found stays plain text.

- **A per-instance setting, on by default.** Admins can turn summary citations off in the instance's AI settings. Off, new analyses don't ask for claim sources, and existing links show as plain text. On again, stored links show again.
- **Links arrive on a bill's next analysis.** Existing summaries aren't backfilled.
- **A small added cost.** Each analysis returns about 490 more output tokens. The setting says it may raise AI costs slightly.
- **Relevance scores move slightly.** Any change to the analysis call moves them, and this one does: the mean score dropped by 0.07 to 0.19 points on the 10-point scale in testing. A few more bills than re-running the same analysis would move may cross the digest's relevance threshold when they are next analyzed.
- **Operators can see how well links resolve.** Central's dashboard shows, for each instance, its stored claim sources counted as exact, normalized, fuzzy, anchored, ungrounded, or unverified (PDF quotes the instance can't check), plus how many analyses asked for claim sources and stored none, and how many responses were cut off inside them and retried without them. See "Summary citations" in the operating guide.

**Deploying.** Deploy central before the instances. An instance on an older central keeps working and simply doesn't ask for claim sources. An instance that hasn't been upgraded shows its claim source counts as unavailable in central's dashboard until it is. The instance migration only adds nullable columns.

## Comment attachments (server side)

The API can now hold files attached to comments: upload, check, download, and cleanup (#465). The app doesn't offer attaching yet, so members see no change in this release. The feature stays off, and nothing needs doing, until you set it up.

**To turn it on for an instance** (optional, and never on a demo instance, where it stays off regardless): create a private R2 bucket (no public access, no `r2.dev` URL), bind it as `ATTACHMENTS_BUCKET` (`api/wrangler.example.toml` has the block), and deploy as usual. Uploads stream through the instance's Worker, so the bucket needs no CORS rule and no API token. Several instances may share one bucket, since each stores its files under its `TENANT_ID`.

**Limits.** 25 MB a file, 10 files a comment, 30 uploads a member an hour, and 5 GB for the instance. Programs, scripts, web pages (HTML, SVG, JavaScript), macro-enabled Office files, and archives are refused, by name and by the file's first bytes. Files download only for a signed-in member of the instance, while their comment shows. Uploads that never finish are deleted after an hour, uploads never posted after a day, a deleted comment's files 30 days after the delete, by the hourly cron, which also removes within the hour any file whose comment was removed with its member's account. The admin data export lists the files (not their contents).

**Deploying.** Migration `0115` adds the `comment_attachments` table and touches no existing table.
