# LegiScan operational notes

> Moved out of the public self-hosting docs, which keep only the two must-know facts (the free tier is 30,000 calls/month, and UI showing LegiScan data must carry "Data provided by LegiScan" attribution). This page holds the operational and licensing detail.

- **Never bulk-queue bills to the ingestor without `skipFetch: true`.** Each ingestor message triggers a `getBill()` API call. For bulk operations use `reprocess` (zero API calls) or `seed-session` (which uses `skipFetch: true`). This is the single easiest way to blow through the quota by accident.
- **Quota tiers.** The free "Public" tier is 30,000 calls/month. The paid Pull tier (100,000/month) gives extra headroom; see [legiscan.com/pricing](https://legiscan.com/pricing).
- **Charging tenants.** If you plan to charge tenants for platform access, get written confirmation from LegiScan that a central-cache architecture is permitted under your tier's terms.
- **Cloudflare Queue quota (separate from LegiScan).** The Workers free tier allows only 10,000 queue operations/day (~3,333 messages). Bulk seeding a large session (e.g. 10,000 bills) exhausts this immediately — this is one more reason the Workers Paid plan ($5/month, 1M ops/month) is required.
- **Attribution.** Bill data is licensed CC BY 4.0. All UI displaying LegiScan data must include "Data provided by LegiScan" attribution.
