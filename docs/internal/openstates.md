# OpenStates (removed)

FloorVote once had a second central worker that read bills from the [OpenStates API v3](https://v3.openstates.org/). It was removed in #285. The last commit that contains it is tagged `openstates-final`:

```bash
git show openstates-final:central/src/providers/openstates.ts
git ls-tree -r --name-only openstates-final -- central scripts/openstates
```

## What the code knew

The useful knowledge lives in `central/src/providers/openstates.ts` at the tag.

- **Requests.** Base URL `https://v3.openstates.org`, API key in the `X-API-KEY` header. A state is addressed as the jurisdiction `ocd-jurisdiction/country:us/state:<xx>/government`. Bill ids are `ocd-bill/<uuid>`.
- **Sessions.** `GET /jurisdictions/<jurisdiction>?include=legislative_sessions`.
- **Updated bills.** `GET /bills` with `jurisdiction`, `session`, `updated_since` (a `YYYY-MM-DD` date), `sort=updated_asc`, `per_page=20`, and `page`, paging until `pagination.max_page`. `include` was repeated once per value: `sponsorships`, `versions`, `actions`, `sources`, and `abstracts`.
- **Bill detail.** `GET /bills/ocd-bill/<uuid>` with the list above plus `votes`, `documents`, and `related_bills`.
- **Keyword search.** `GET /bills` with `q=<keyword>` and `created_since` in place of `updated_since`. A daily sweep used it to catch bills whose keyword appeared only in the body text.
- **Rate limiting.** On HTTP 429 the client waited for `Retry-After` seconds when present, and otherwise 2, 5, then 10 seconds, giving up after the third retry. Other non-2xx responses threw. `central/src/lib/rateLimitedFetch.ts` keeps the same retry schedule for LegiScan.
- **Status.** OpenStates has no single status field, so `deriveStatus()` walked the actions newest-first by `order`. The newest action classified `became-law` or `executive-signature` (enacted), `executive-veto*` (vetoed), or `failure` (failed) decided the status. Otherwise `passage` actions were collected per chamber (`organization.classification` of `upper` or `lower`): both chambers meant passed, one meant passed_upper or passed_lower. Then `committee-passage` or `committee-referral` meant in_committee, and `introduction` or `filing` meant introduced. Anything else was unknown.

`scripts/openstates/` at the tag also holds a bulk-JSON seeder and the scripts used to compare OpenStates against LegiScan.

## Why it was removed

OpenStates is a valuable public resource, but it didn't fit FloorVote's needs at the time:

- **Rate limits.** The API's rate limits constrained how often, and across how many states, central could sync.
- **API pulls didn't match the bulk seeds.** Bills pulled from the API didn't match the same bills loaded from the bulk data downloads, so seeding a state from bulk data and keeping it current through the API was unreliable.
- **Fewer fields than LegiScan.** The OpenStates path stored no hearing calendar, subjects, committee referrals, or amendments, all of which LegiScan's bill records include.

The LegiScan central became the maintained path, and the OpenStates central fell behind it and went unmaintained. A future provider should follow the provider model in #283 rather than revive this code as-is.
