# Release notes: next release

Releases are published as GitHub Releases (the first is `v2026.10.0`), and the repository holds no release notes file. This page holds the draft entries for the next release, so they're reviewed with the code that earns them. When the release is cut, paste the entries into the release body and clear this page.

Keep each entry to what a deployer or an admin needs: what changed, what to do, and anything that moves. Name no instance or tenant.

## Claim links

Claims in an AI summary can now link to the bill text behind them. On an HTML bill, clicking a claim opens the bill text at the passage, highlighted. On a PDF, it opens the cited page, with the quote beside the link. A claim whose quote can't be found stays plain text.

- **A per-instance setting, on by default.** Admins can turn claim links off in the instance's AI settings. Off, new analyses don't ask for claim sources, and existing links show as plain text. On again, stored links show again.
- **Links arrive on a bill's next analysis.** Existing summaries aren't backfilled.
- **A small added cost.** Each analysis returns about 490 more output tokens. The setting says it may raise AI costs slightly.
- **Relevance scores move slightly.** Any change to the analysis call moves them, and this one does: the mean score dropped by 0.07 to 0.19 points on the 10-point scale in testing. A few more bills than re-running the same analysis would move may cross the digest's relevance threshold when they are next analyzed.
- **Operators can see how well links resolve.** Central's dashboard shows, for each instance, its stored claim sources counted as exact, normalized, fuzzy, anchored, ungrounded, or unverified (PDF quotes the instance can't check), plus how many analyses asked for claim sources and stored none, and how many responses were cut off inside them and retried without them. See "Claim links" in the operating guide.

**Deploying.** Deploy central before the instances. An instance on an older central keeps working and simply doesn't ask for claim sources. An instance that hasn't been upgraded shows its claim link counts as unavailable in central's dashboard until it is. The instance migration only adds nullable columns.
