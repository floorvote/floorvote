# Presets

Presets bundle the four AI/content settings (AI context, relevance question, tag taxonomy, and keywords) into named configurations for specific use cases. They make it fast to set up a new instance without manually configuring each field.

## Available presets

| Slug | Name | Use case |
|------|------|----------|
| `generic` | Generic (Policy Organization) | Any policy org tracking legislation. Broad taxonomy (~15 policy areas), neutral framing, empty keyword list. |
| `election_officials` | Election Officials | State associations of local election officials. Election-specific keywords, taxonomy, AI framing, and relevance question. |

## Applying a preset

**Via setup (`api/wrangler.toml`):**

Set:

```toml
INSTANCE_PRESET = "election_officials"
```

When present, the worker auto-applies that preset into `association_config` the first time it registers with central or serves config. This is the recommended path for new tenant setup because bills will not run AI until a preset is configured.

**Via the UI (Settings → Config):**

1. Open **Settings → Configuration**.
2. In the **Preset** bar at the top, select a preset from the dropdown.
3. Click **Apply**.

This overwrites the current AI context, relevance question, tag taxonomy, and keywords with the preset values. It also sets `instance_preset` in config (so "Reset to preset" knows what to restore to), immediately syncs keywords to central, and queues AI for any existing bills that are still missing summaries.

**Via the API:**

```
POST /api/admin/apply-preset/:slug
```

Requires an admin session cookie. Returns `{ ok: true, preset: "slug", queuedForAi: 0 }`.

## "Reset to preset" buttons

When an `instance_preset` is set, the **Reset to preset** button on each AI field (AI context, relevance question, tag taxonomy, keywords) restores that field to the preset's value. If no preset is active, the button reverts to the code-level generic default (or clears the field).

## Keyword sync

Keywords are synced to central automatically when:
- A preset is applied (`POST /api/admin/apply-preset/:slug`)
- Keywords are saved in the Config form (`PUT /api/admin/config` with a `keywords` field)
- Manually via `POST /api/admin/register-with-central`

Central uses the union of all tenant keywords to filter the legislative masterlist before queuing bills. If you clear all keywords, this tenant's bills will come only from the keyword union of other tenants — which is probably not what you want. Apply a preset or set keywords explicitly.

## Adding a new preset

Presets are defined in [`api/src/lib/presets.ts`](../../../api/src/lib/presets.ts). Add a new entry to the `PRESETS` record:

```ts
my_preset: {
  slug: 'my_preset',
  name: 'My Preset',
  description: 'Short description shown in the UI.',
  aiContext: '...',
  relevanceQuestion: '...',
  taxonomy: [{ name: 'Tag A' }, { name: 'Tag B' }],
  keywords: ['keyword one', 'keyword two'],
},
```

Presets are code-only — no database migration needed. They're served via `GET /api/admin/presets` and applied via `POST /api/admin/apply-preset/:slug`.

## Spinning up a new election officials instance

After completing the steps in `docs/spinning-up-instances.md`, either set `INSTANCE_PRESET = "election_officials"` in `api/wrangler.toml` before deploy, or apply the election officials preset afterward:

```bash
curl -X POST https://<worker-url>/api/admin/apply-preset/election_officials \
  -H "Cookie: session=<admin-session>"
```

Or apply it through the Settings → Config page once the first admin user is logged in. This seeds keywords, taxonomy, AI context, and relevance question in one step and pushes keywords to central immediately.
