# Date/time format convention


## Two kinds of time — don't conflate them

There are two categories of time in this system, with **opposite** rules. This convention is about the first; the second is called out so nobody "standardizes" it by mistake.

1. **Instant / event timestamps** — `created_at`, `updated_at`, `last_seen_feed`, vote/comment/feed-event times, sync timestamps. These record *an absolute moment something happened*. They are UTC and should display in each viewer's local time ("3m ago"). **The rule below applies to these.**

2. **Scheduled wall-clock times** — hearing date/time (`calendar_events.date`, `calendar_events.time`). A hearing at "10:00 AM" at the statehouse is a *floating local* time in the jurisdiction's timezone, **not** a UTC instant. The provider (LegiScan) gives these with no timezone, and that's correct: store them **verbatim** as the raw `date`/`time` strings, display them **as-is** (see `web/src/lib/hearingTime.ts`, which does pure string formatting with no conversion), and **never** run them through `datetime('now')`, `new Date()`, or UTC normalization. Converting a wall-clock hearing time to UTC and back to a viewer's clock would shift it wrongly (e.g. a DC user seeing a 10am RI hearing as some other time). The implicit assumption is that a hearing time means "local to where the hearing is" — which is exactly what users want, and is robust because we never convert it. (Single-state instances make this a non-issue anyway; the verbatim-storage rule keeps it correct even for multi-state.)

## The rule (instant/event timestamps)

**Store instant timestamps in the database as UTC in SQLite `datetime()` format: `YYYY-MM-DD HH:MM:SS`** (a space separator, no `T`, no `Z`, no fractional seconds).

This is the format produced by `datetime('now')`, which is the default on the timestamp columns across the tenant and central schemas. We standardize on it because it's already the de-facto majority; the alternative (ISO-8601 everywhere) would mean overriding every column default and rewriting every existing row in every tenant DB.

## Writing timestamps (server / Drizzle / SQL)

- **Prefer the column default.** Most timestamp columns are declared `text('...').notNull().default(sql\`(datetime('now'))\`)` — just omit the field on insert and let SQLite stamp it.
- **When you must set it explicitly**, use SQLite, not JS: `sql\`(datetime('now'))\``.
- **Do NOT write `new Date().toISOString()` into a timestamp column.** It produces `2026-06-06T14:00:00.000Z` (ISO), which is a *different string* from `datetime('now')`. Mixing the two formats in one column silently breaks `ORDER BY <col>` and `MAX(<col>)`, because lexically `' '` (0x20) sorts before `'T'` (0x54) — so a same-day space-format row sorts *below* an ISO row regardless of the actual time.
- `new Date().toISOString()` is fine for things that are **not** stored timestamp columns: computing relative time windows for comparisons (e.g. `datetime('now','-5 days')` is preferred there too, but ISO literals compared via `datetime(...)` also work), JSON metadata blobs, log lines, email bodies, etc.
- In app code where a `SQL` expression won't do (a plain string is needed), use the `nowDb()` helper (`api/src/lib/dbTime.ts`, `central/src/lib/dbTime.ts`) — it returns the SQLite space format computed in JS.

### Guard (CI / nightly)

`scripts/verify-timestamp-writes.ts` fails if `new Date().toISOString()` is used where it
would land in a stored timestamp column. Run it in the nightly repo-health routine. Non-stored
uses (response `meta`, date-only `.slice(0, 10)`, log lines, email bodies) are exempt via
same-line markers or an explicit `// ts-write-ok: <reason>` comment.

### Comparing timestamps in SQL

Wrap both sides in `datetime(...)` so the comparison is value-based, not string-based — this is robust even if a column still has mixed formats:

```sql
WHERE datetime(created_at) > datetime(:since)
```

(`api/src/lib/digest.ts` already does this correctly.)

### Sorting timestamps in SQL

The same applies to `ORDER BY` and `MAX()` over a column that may still hold mixed formats —
wrap the column in `datetime(...)` so the sort is value-based:

```ts
.orderBy(desc(sql`datetime(${feedEvents.createdAt})`))
sql`max(datetime(${feedEvents.createdAt}))`
```

(`api/src/routes/feed.ts` does this for the Pulse feed page order and the nav-dot signal.)

## Reading timestamps (frontend / JS)

The space format is UTC, but **`new Date("2026-06-06 14:00:00")` parses it as *local* time** in V8 — a footgun that shifts every timestamp by the viewer's UTC offset.

- **Never** pass a raw DB timestamp to `new Date(...)`, `Date.parse(...)`, or `.getTime()` directly.
- Normalize first. `shared/time.ts` exports the canonical parser `dbTsToEpoch(ts)`, which
  accepts both the space format and ISO-8601 and returns a correct UTC epoch. It is the
  single source of truth for both web and api. `web/src/lib/time.ts` re-exports it aliased
  as `feedTsToEpoch` for historical importers.

  ```ts
  export function dbTsToEpoch(ts: string): number {
    const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z'
    return Date.parse(iso)
  }
  ```

- `relativeTime`/`absoluteTime` (`web/src/lib/time.ts`) and the feed day-group sort
  (`shared/feedUtils.ts`) route through it.
- **Day bucketing / "Today"–"Yesterday" labels must use the *local* calendar day, not a UTC `.slice(0, 10)`.** Slicing the UTC string buckets a 7pm-EDT event into the next UTC day, so it shows as "Yesterday" to evening users west of UTC while `relativeTime` still says "54m ago". Use `epochToLocalDay(ms)` / `dbTsToLocalDay(ts)` from `shared/time.ts` (the feed day-group key and `formatDayLabel` do). This applies only to **viewer-facing** day labels — backend UTC-day aggregation (central analytics) and floating wall-clock dates (hearings, see §2) are deliberately *not* localized.
- Any new display/comparison helper (relative-time labels, sorting, "is this newer than X") must route through this normalization.

## Why this matters

Mixed formats in a column silently break `ORDER BY`, `MAX`, and string comparisons — hence this convention.
