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
