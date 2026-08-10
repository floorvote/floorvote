# LegiScan operational notes

> Moved out of the public self-hosting docs, which keep only the two must-know facts (the free tier is 30,000 calls/month, and UI showing LegiScan data must carry "Data provided by LegiScan" attribution). This page holds the operational and licensing detail.

- **Never bulk-queue bills to the ingestor without `skipFetch: true`.** Each ingestor message triggers a `getBill()` API call. For bulk operations use `reprocess` (zero API calls) or `seed-session` (which uses `skipFetch: true`). This is the single easiest way to blow through the quota by accident.
- **Quota tiers.** The free "Public" tier is 30,000 calls/month. The paid Pull tier (100,000/month) gives extra headroom; see [legiscan.com/pricing](https://legiscan.com/pricing).
- **Charging tenants.** If you plan to charge tenants for platform access, get written confirmation from LegiScan that a central-cache architecture is permitted under your tier's terms.
- **Cloudflare Queue quota (separate from LegiScan).** The Workers free tier allows only 10,000 queue operations/day (~3,333 messages). Bulk seeding a large session (e.g. 10,000 bills) exhausts this immediately — this is one more reason the Workers Paid plan ($5/month, 1M ops/month) is required.
- **Bulk-seed throughput: ~45 bills/min.** `scripts/seed-legiscan.ts --from-dir … --remote` batches writes through `wrangler d1 execute` over HTTP, so round-trip latency sets the pace — not local parsing, and not the dataset size on disk. Measured 43–50 bills/min across two states (IN 935 bills, MI 3,909). Practical budget: ~20 min per 1,000 bills, ~1.5 hr at 4,000, ~4 hr at 12,000; roll calls add time at a similar rate. Consequences worth planning around:
  - Anything past a couple thousand bills is an unattended job (`tmux`, or background with output to a log) rather than something to babysit.
  - Run states **sequentially**. Parallel runs contend for the same D1 write path and queue budget, and latency-bound work doesn't parallelize well anyway.
  - Track progress by counting rows in central (`SELECT COUNT(*) FROM bills WHERE session_id = …`) rather than trusting a scrollback.
  - Seeding is idempotent (`INSERT OR REPLACE`), so an interrupted run is re-runnable, not a cleanup problem.
- **Keyword match rate runs ~3–4% of a session,** so AI spend is far smaller than a bill count suggests: IL 448/12,022, IN 40/935, MI 126/3,909 against the 20-keyword elections preset. The rest arrive as no-cost monitor stubs. You can predict this before committing to a seed by matching the tenant's keyword union against `title`/`description`/`bill_number` in the extracted JSON — the same haystack `matchesUnion` uses.
- **Attribution.** Bill data is licensed CC BY 4.0. All UI displaying LegiScan data must include "Data provided by LegiScan" attribution.
