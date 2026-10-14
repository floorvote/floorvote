---
description: "How to add a data provider to FloorVote: the provider model, the rules every provider follows, the template directory, the tests maintainers expect, and how operators turn a provider on."
---

# Adding a data provider

LegiScan supplies FloorVote's bill data for every state. A **provider** is an adapter that reads a legislature's own feed instead. DC, Maryland, and Virginia have providers today. You can add one for your state by copying a template directory, following this page, and testing the way maintainers do. You won't touch tenant, web, or pipeline code.

The [State coverage](/contributing/state-coverage) page lists the providers that exist and who maintains them. It lists what the code supports, not which provider a given deployment uses.

## What a provider is

A provider knows one API and how to map what it returns into FloorVote's shapes. Central, the shared data service, does everything else: deciding what to sync and when, writing to the database, matching keywords, and notifying instances. Two things hold that line:

- ESLint lets provider code import only its own directory and [`providers/sdk.ts`](https://github.com/floorvote/floorvote/blob/main/central/src/providers/sdk.ts), and lets the rest of central reach a provider only through the registry (`providers/index.ts`). `npm run lint` in `central/` enforces both.
- A provider's `env` holds only the keys it declares in `envKeys`, such as its API key. It never holds central's database, buckets, or queues.

Instances never call a legislative API. They read central, so a new provider changes nothing for them.

The interface and every shape that crosses the boundary are documented in [`providers/types.ts`](https://github.com/floorvote/floorvote/blob/main/central/src/providers/types.ts). Read it once, top to bottom, before you write code.

## The rules

### LegiScan is the baseline

Every provider maps into the shapes LegiScan introduced: the same bill, session, sponsor, history, vote, text, and calendar fields. If your feed has something those shapes can hold, map it there. A bill from your provider then works with search, keyword matching, notifications, and AI summaries exactly as a LegiScan bill does.

A field only your feed publishes goes in **extras**: display-only values the bill page shows under your provider's name, such as Maryland's chapter number or the statutes a bill affects. Extras are never sorted, filtered, matched, or sent to AI. If a field needs any of that, or a second provider publishes it too, it becomes a shared column instead, and that is a change to central, discussed in an issue first.

### Official feeds only

Read the legislature's own API or its published data files. Parsing HTML pages is a last resort: do it only when no API or data file has the data you need. Use an undocumented endpoint only when an error, an unexpected shape, or an empty answer from it changes nothing. Check the feed's terms before you start. Virginia's LIS API has bill text and meeting schedules, for example, but its terms are non-commercial, so that provider reads the CSV files only.

### Fail closed

When the feed is down, answers with an error, or sends a shape the mapping doesn't read, throw. Central then changes nothing from that answer, and the job fails and alerts. Never treat a bad answer as an empty one:

- A missing key is not an empty value. A key the feed renamed would otherwise strip that field from every bill on its next ingest.
- An empty list means nothing new, never that bills were removed.
- A 404 for a session file that hasn't been published yet is a normal answer. An HTTP 500 is not.

### Off by default

Adding a provider to the registry doesn't change any deployment. A state syncs from LegiScan unless an operator claims it for a provider. Your provider runs only for states the operator has claimed, and only when the deployment has what the provider needs, such as its API key.

### Official codes, never LegiScan's

Each provider writes its own status codes, in a block no other provider uses: LegiScan 0 through 12, LIMS the 100s, Maryland's MGA the 200s, Virginia's LIS the 300s. Take the next free hundred.

### Every text carries a hash

Each text a provider lists needs a non-empty `text_hash`. An instance runs AI on a bill only when the bill arrives with one, and uses it to skip a text the model already read. A provider that sends none gets no summaries, tags, or relevance scores on any of its bills, and nothing says why.

If the feed publishes a checksum for a document, send it. If it doesn't, send any stable token that names the document, such as a hash of its `doc_id`, the way LIMS and Maryland do. It then changes only when a different text becomes the bill's newest, and the model reads that text once. A provider that implements `fetchDocument` sends the MD5 of the document's bytes, which core checks the provider's copy against.

Fixing a mapping doesn't reach bills already ingested without hashes, since their change hash doesn't move. Re-ingest them (`POST /api/admin/reingest-tenant/:tenantId?provider=<id>&confirm=true`).

### Roll calls

A roll call's id must be unique to the bill. A vote the feed shares among several bills (a block vote) has one reference id in the feed, so derive the roll call's id from the bill and the reference id together, or each bill overwrites the others' roll call. Leave out a vote that has no tally (a voice vote with no count) rather than sending a 0-0 roll call that reads as failed.

By default core only upserts a bill's roll calls on ingest, so a roll call you stop sending stays. If your measure always carries every roll call the bill has, so that an empty `votes` means it has none, set `replacesRollCalls: true` on your provider: the ingest then deletes the bill's roll calls (and their member votes) that the measure doesn't name. Don't set it for a feed that can answer without a votes section, or a bad answer wipes the stored votes.

## Pick a sync style

Providers sync one of two ways:

- **Snapshot.** The feed has no modified-since filter and no cheap change list, so each pass reads a session's records whole. You implement `snapshot` and `toEntry`, and central stores each changed record, hashes it, and hands it back for the ingest. DC, Maryland, and Virginia work this way, and so does the template.
- **Listing.** The API can list changes cheaply. You implement `listMeasures` and `listChangeHashes`, as LegiScan does.

Most legislatures publish a file or an API without change filters, so start with a snapshot.

## Start from the template

Copy these three directories, rename them to your provider's id, and replace every `TEMPLATE` note:

| Copy | To |
|---|---|
| [`central/src/providers/template/`](https://github.com/floorvote/floorvote/tree/main/central/src/providers/template) | `central/src/providers/<id>/` |
| [`central/test/providers/template/`](https://github.com/floorvote/floorvote/tree/main/central/test/providers/template) | `central/test/providers/<id>/` |
| [`central/test/fixtures/template/`](https://github.com/floorvote/floorvote/tree/main/central/test/fixtures/template) | `central/test/fixtures/<id>/` |

Also copy [`central/test/cron/template-provider.test.ts`](https://github.com/floorvote/floorvote/blob/main/central/test/cron/template-provider.test.ts) to `central/test/cron/<id>-provider.test.ts`.

The template compiles and passes lint behind the import boundary, and it is deliberately not in the registry, so central never runs it. Each file has a job:

| File | What it holds |
|---|---|
| `client.ts` | The feed's URLs and response shapes, with checks that fail closed. It knows nothing about central. |
| `map.ts` | Pure mapping from the feed's records into central's shapes. No requests and no env. |
| `inventory.ts` | The field inventory. |
| `vocabulary.ts` | What your codes mean: statuses, bill types, event types, extras, and relationships. |
| `index.ts` | The `Provider` object that ties them together, including its `attribution` (below). |

### The data credit

Every instance covering one of your states shows your credit in its sidebar footer, on one "Data:" line with the other providers' credits: your name, linked to your data page. You declare it as `attribution` in `index.ts`:

- `name` and `url` credit the publisher.
- `license` (a name and URL) is optional. Add it only when the publisher's license asks for credit, as LegiScan's CC BY 4.0 does. It is linked after your name.
- `note` is optional, and only matters with a `license`: one plain sentence explaining the license, shown on hover over the license link and for screen readers. A credit with no license shows just your name, with no hover, so leave `note` out.

Central sends the credit to each instance along with the states you own for it, so a state claimed for your provider changes the footer by itself. No instance setting and no web code is involved.

## The vocabulary file

`vocabulary.ts` is where your provider says what its codes mean. Central sends a label, a common stage, and a rank with every bill, and serves your explainers to instances, so a member sees "Passed Senate" and a plain-language sentence, not a number.

- **Statuses.** Every code the mapping writes to `bills.status` needs a label, a stage from the shared status stages (or none, for a notice outside the legislative path), a rank, a terminal flag, and an explainer. Labels and ranks are unique within your provider.
- **Bill types** and **calendar event types**, each with a label. An event type also names its kind: hearing, markup, meeting, or deadline.
- **Extras**, each with a label, an optional explainer, and a display type: text, date, link, or identifier.
- **Relationships**, if your feed links bills to each other. Map each relationship label your mapping writes (the `type` of a `sasts` entry) to one of three kinds: `identical` (the same bill filed twice, usually one in each chamber), `package` (different bills the legislature moves together), or `related`. A label you leave out is `related`, so a feed that publishes nothing worth grouping needs no section. Map a label `identical` only where it names the same bill twice, since identical companions are the ones that can share a discussion. Write the label as the feed publishes it. The match is by name, never by type id, and ignores case, spacing, and hyphens. Where a label means something else in one state, give that state its own entry under `states`, as LegiScan does for Michigan's "Same As," which tie-bars different bills. Central keeps the raw relationships and attaches the kind when it serves a bill, so changing a mapping needs no re-ingest.

Explainers appear next to real bills, so keep them factual and cite the legislature's own guide to its process. Changing a status's stage or rank after launch changes how bills already in instances sort and filter, so it ships with a one-time metadata resend. [`docs/internal/sync-pipeline.md`](https://github.com/floorvote/floorvote/blob/main/docs/internal/sync-pipeline.md) explains how.

The template's `map.ts` writes status code 900 and bill type `'B'` as placeholders. In a real provider, every code the mapping writes must be declared in `vocabulary.ts`.

When your provider joins the registry, add its codes to "the codes each provider writes" in [`central/test/providers/vocabulary.test.ts`](https://github.com/floorvote/floorvote/blob/main/central/test/providers/vocabulary.test.ts). The same file then checks your vocabulary against the shared rules.

## The field inventory

`inventory.ts` lists every field your feed returns and what you do with it. Each field is one of:

- `'mapped'`: read into central's shapes
- `{ extra: key }`: shown as an extra your vocabulary declares
- `{ ignored: reason }`: dropped on purpose, and why

Reviewers read it to confirm nothing in the feed disappears silently. The mapping test fails on any field in your recorded fixtures that isn't listed, so when the feed adds a field later, someone has to decide what to do with it. Keep one inventory per response your provider reads, such as a listing and a per-bill details response.

## Recorded fixtures and the mapping test

Test against responses saved from the live feed, never against the live feed. Trim them to a handful of records that cover each case you handle, and keep nothing personal beyond what the legislature publishes. Two tests use them:

1. **The mapping test** (`test/providers/<id>/map.test.ts`) runs your mapping on the fixtures with no network and no database. It checks every fixture field against the inventory, that every extra in the vocabulary is fed by some field, and that records map to the shapes central ingests.
2. **The main-seam test** (`test/cron/<id>-provider.test.ts`) follows the same fixtures through central. It is the test that matters most, below.

## The main-seam test helper

Test external behavior, not implementation. The seam is: your provider's recorded feed in, central's bill API and the notifications queued for instances out. [`central/test/helpers/mainSeam.ts`](https://github.com/floorvote/floorvote/blob/main/central/test/helpers/mainSeam.ts) wires it up. It stubs the network at `fetch`, runs the same hourly sync and ingest that production does against a real migrated D1 database (never a mock), and gives you the pieces to check:

```ts
import { toHandle } from '../../src/lib/billHandle'
import { mainSeam, resetCentral } from '../helpers/mainSeam'

const seam = mainSeam(mga, { tenantId: 'mdteam' })

beforeEach(async () => {
  await resetCentral()
  await seam.addTenant('MD', ['tax'])
})

it('syncs Maryland once claimed', async () => {
  expect((await seam.claim('MD')).status).toBe(200)
  const { run } = await seam.syncAndIngest()
  const handle = toHandle(await seam.billIdOf('HB1'))
  expect(await seam.getJson(`/bills/${handle}`)).toMatchObject({ number: 'HB1' })
  expect(seam.sentToTenant(run)).toContainEqual(expect.objectContaining({ billId: handle }))
})
```

The LIMS, Maryland, and Virginia tests all use it, and the [template's test](https://github.com/floorvote/floorvote/blob/main/central/test/cron/template-provider.test.ts) is the smallest example. [`mga-provider.test.ts`](https://github.com/floorvote/floorvote/blob/main/central/test/cron/mga-provider.test.ts) is a full one. At a minimum, test that your provider:

- stays off until an operator claims the state
- syncs a claimed state, serves its bills through the bill API, and queues notifications for an instance that matches
- fails closed on each way the feed can break, writing nothing

A provider test mocks `rateLimitedFetch` with [`unpacedFetch`](https://github.com/floorvote/floorvote/blob/main/central/test/helpers/unpacedFetch.ts), so stubbed requests don't wait on pacing. The template's test also adds itself to the registry with a mock, since it isn't there. Remove that mock in your copy.

## Maintainers and review

Each provider declares who maintains it, as GitHub handles in `coverage.maintainers` in its `index.ts`. Everything else follows from that one declaration:

- The [State coverage](/contributing/state-coverage) page lists each provider's maintainers.
- [`.github/CODEOWNERS`](https://github.com/floorvote/floorvote/blob/main/.github/CODEOWNERS) is generated from the declarations (`npm run gen:codeowners`), so GitHub asks a provider's maintainers, and the project maintainer, to review changes to its source directory and its tests. Don't edit that file by hand. A test fails when it is out of date.
- A pull request from an outside contributor that changes a provider's directory gets one comment mentioning that provider's maintainers, other than the author and the project maintainers (the owners of the `*` line in CODEOWNERS), who merge everything and are never mentioned. A pull request opened by a project maintainer gets no comment. The comment is updated rather than repeated as the branch changes, and a draft waits until it is marked ready for review.

Maintainers review changes to their provider. The project maintainer merges.

## Before you open a pull request

Run what CI runs, from `central/`:

```bash
npx tsc --noEmit -p tsconfig.build.json
npm run lint
npm test
```

Then check the following:

- **Register it.** Add your provider to `PROVIDERS` in `central/src/providers/index.ts`, and delete the template's "stays out of the registry" test from your copy.
- **Maintainers.** Name the people who maintain the adapter in your provider's `coverage.maintainers`, then run `npm run gen:codeowners` and `npm run gen:state-coverage` and commit what they write. A provider needs a maintainer who will answer when the feed changes. A test fails when `.github/CODEOWNERS` or the State coverage page no longer matches the declarations. See [Maintainers and review](#maintainers-and-review).
- **LegiScan budget.** Don't bulk-queue central's ingestor in a test or a script without skipping the fetch. LegiScan's free tier is 10,000 calls a month, and your provider spends none of them.
- **Sign-off.** Every commit needs the `Signed-off-by` line described in [Contributing](./#licensing-and-sign-off).
- **Migrations.** Most providers need none. If yours does, add a new numbered file and never edit an existing one. Don't put a semicolon inside a comment in a migration, since the test helper splits statements on semicolons before it strips comments.

## How operators turn a provider on

Which provider a state syncs from is a row in central's state ownership table. A state with no row is LegiScan's, so a LegiScan-only deployment has none. An operator changes a state with a claim:

```bash
curl -X POST "$CENTRAL/api/admin/state-providers/MD" \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"provider":"mga"}'
```

Central refuses the claim when the provider doesn't serve that state or isn't configured, and when the state's current provider has bills that instances track. Moving those bills without orphaning anyone's links takes a cutover, a separate operation that matches bills across providers and moves each matched bill onto the new provider's data, keeping its id so instances' links stay as they are. A new deployment, or a state no instance covers yet, can switch at once. A state whose provider later loses its key goes unsynced rather than falling back to LegiScan, since a fallback would duplicate every tracked bill.

You don't write any of this as a contributor. It matters for two reasons: your provider should work for a state that is claimed at launch, and it should keep every bill's id stable across passes, since cutover and calendar subscriptions depend on that.

## Where the internals live

This page stays on the contributor's side of the boundary. The maintainers' documents cover the rest:

- [`docs/internal/sync-pipeline.md`](https://github.com/floorvote/floorvote/blob/main/docs/internal/sync-pipeline.md): the cron, the ingestor, snapshot passes, state ownership, committees, and migrations
- [`docs/internal/direct-sources.md`](https://github.com/floorvote/floorvote/blob/main/docs/internal/direct-sources.md): the reasoning and the field-by-field notes on the DC, Maryland, and Virginia feeds
