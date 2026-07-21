# Presets

A preset bundles the four AI-and-content settings — AI context, relevance question, tag taxonomy, and keywords — into one named configuration for a common use case. Applying a preset is the fast way to configure a new tenant without filling in each field by hand.

## Available presets

| Slug | Name | Use case |
|------|------|----------|
| `generic` | Generic (Policy Organization) | Any policy organization tracking legislation. Broad taxonomy (~15 policy areas), neutral framing, empty keyword list. |
| `election_officials` | Election Officials | State associations of local election officials. Election-specific keywords, taxonomy, AI framing, and relevance question. |

## Applying a preset

**During setup (`api/wrangler.toml`):** set `INSTANCE_PRESET = "election_officials"` in the tenant's vars. The worker applies that preset the first time it registers with central or serves its config. This is the recommended path for a new tenant, because bills won't run AI until a preset is in place.

**From the app (Settings → Configuration):** open the **Preset** bar at the top, pick a preset, and click **Apply**. This overwrites the current AI context, relevance question, tag taxonomy, and keywords with the preset's values; records which preset is active (so "Reset to preset" knows what to restore); syncs your keywords to central; and queues AI for any existing bills still missing a summary.

**From the API:** `POST /api/admin/apply-preset/:slug` with an admin session cookie. It returns `{ ok: true, preset: "slug", queuedForAi: 0 }`.

## "Reset to preset" buttons

When a preset is active, the **Reset to preset** button on each AI field restores just that field to the preset's value. If no preset is active, the button reverts the field to the built-in generic default (or clears it).

## Keyword sync

Your keywords are sent to central whenever you apply a preset, save keywords in the Config form (`PUT /api/admin/config`), or trigger it directly with `POST /api/admin/register-with-central`. Central filters the legislative masterlist against the combined keywords of all tenants before queuing bills. If you clear all your keywords, this tenant will only receive bills that match *other* tenants' keywords — usually not what you want, so keep at least one keyword or an applied preset.

## Adding a new preset

Presets are defined in `api/src/lib/presets.ts`. Add an entry to the `PRESETS` record — no database migration needed. They're served via `GET /api/admin/presets` and applied via `POST /api/admin/apply-preset/:slug`.
