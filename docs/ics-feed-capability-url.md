# ICS Calendar Feed — Capability-URL Security Model

**Status:** Accepted design (reaffirmed June 2026).

## What it is

Each tenant exposes a public, unauthenticated iCalendar feed at:

```
GET /api/calendar/feed/:slugIcs
```

`:slugIcs` is a per-tenant **capability URL**: a 128-bit cryptographically-random token (optionally suffixed `.ics`). Knowledge of the slug is the only thing required to read the feed — there is no login, cookie, or API key. This is intentional, so that standard calendar clients (Google Calendar, Apple Calendar, Outlook) and link-unfurl bots can subscribe by URL alone, none of which can complete an authenticated flow.

## Why it is unauthenticated

The same reasoning behind not enabling zone-wide Bot Fight Mode applies here: an authenticated or challenge-gated feed would break calendar-client polling and is incompatible with the ICS subscription model. The capability-URL pattern is the standard, intended way to publish a private calendar feed.

## The threat being accepted

Anyone who obtains a tenant's slug can read that organization's tracked-bill hearing schedule — event titles, dates, locations, and priority levels — with no login. The feed therefore leaks the organization's prioritization intelligence to any holder of the URL.

This is an accepted risk, mitigated by the controls below.

## Controls

- **High-entropy slug.** The slug is a 128-bit random token, so it cannot be guessed or enumerated.
- **Constant-time comparison.** The slug is compared in constant time, so it cannot be discovered by a timing side channel.
- **Rotatable.** An admin can rotate the slug at any time via `POST /api/calendar/regenerate-slug`, which immediately invalidates the old URL. Rotate it if it is believed to have leaked.
- **Never logged.** The slug is a secret and must be treated like one. As of the June 2026 review it is not written to any log line, and it must stay that way — do not add logging that includes `slugIcs` or the resolved slug. Verified: there is no `console.*` reference to the slug in `api/src/routes/calendarApi.ts`.

## Rules for maintainers

- Treat the slug as a secret in every code path: never log it, never include it in error messages, analytics, or telemetry, and never expose it to a non-admin API response.
- If you add a new feed or capability URL, follow the same model: ≥128-bit random token, constant-time compare, rotatable, never logged.
- The feed route is deliberately the only calendar route without `requireAuth` — keep it that way, and do not add other unauthenticated calendar routes.
