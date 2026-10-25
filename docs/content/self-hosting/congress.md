---
description: "How to move Congress (US) from LegiScan to GovInfo Bill Status: the claim or cutover, the optional Congress.gov key for committee meetings, the January 2027 deadline, the session slug, and the data credit."
---

# Congress from GovInfo

By default, Congress (`US`) syncs from LegiScan, like every other state. This page covers the opt-in alternative: the `govinfo` provider, which reads the official, public-domain Bill Status data that GovInfo publishes for the Government Publishing Office (GPO) and the Library of Congress. It spends no LegiScan calls on Congress, and it adds what LegiScan's Congress data lacks: Congressional Research Service summaries, the official relationship between identical House and Senate bills, member votes named by Bioguide id, and committee codes that stay the same from one Congress to the next.

Nothing here is required. A deployment that does nothing keeps syncing Congress from LegiScan, and the rest of this page doesn't apply to it. The [provider guide](/contributing/providers) explains how any provider is claimed, and `docs/internal/sync-pipeline.md` in the repository has the maintainer's detail.

## What it needs

- **Bills and votes need no key.** Bills come from GovInfo's Bill Status bulk files. Each House and Senate roll call a bill links comes from the House Clerk's and the Senate's own files, which name every member's vote.
- **Committee meetings need an optional key.** Hearings, markups, and meetings come from the Congress.gov API, which needs a free api.data.gov key. Without one, Congress's bills and votes still sync, and every calendar for Congress stays empty. Sign up at [api.congress.gov/sign-up](https://api.congress.gov/sign-up/), then set it as a secret on central, from inside `central/`:

  ```bash
  wrangler secret put CONGRESS_API_KEY --env legiscan
  ```

  Use your central's environment name if it isn't `legiscan`. Central sends the key only in an `X-Api-Key` header to `api.congress.gov`, never in an address, a log, or anything it stores. It asks for no more than 10 requests a minute.

## Turn it on when no one tracks Congress yet

If no instance has Congress bills linked, a claim is enough. Set the key first if you want the calendar (see [Committee meetings](#committee-meetings-and-the-first-read)), then claim `US` with the admin secret:

```bash
curl -X POST "$CENTRAL/api/admin/state-providers/US" \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"provider":"govinfo"}'
```

Central answers 200, and the state starts syncing from GovInfo once at least one active instance covers `US`. The hourly job does its first full read at its next full pass (5, 13, and 23 Eastern), or you can start it now with `POST /api/admin/providers/govinfo/sync`, which reads in full. A full read of the 119th Congress downloads eight zip files, 54 MB in all, and takes a few seconds of CPU, so no `cpu_ms` limit needs to change.

If an instance does track Congress bills from LegiScan, central answers 409 and names the instances and how many bills they track. The row doesn't change. Only a cutover moves those bills.

## Move a deployment that already tracks Congress

A cutover moves Congress's bills and legislators to GovInfo without writing to any instance's database. Each matched bill keeps its row and its handle, so every instance's copy and every link to it stay as they are. There is no dashboard control for it: the claim and the cutover are admin routes, called with `x-admin-secret`, and the States page on the dashboard shows the result ("Claimed" or "Cut over", with the date).

1. **Set `CONGRESS_API_KEY` first, and wait for the `warm/119` row before you confirm,** if you want committee meetings. Once the key is set and an instance covers `US`, central's hourly job reads Congress's committee meetings into its cache while LegiScan still owns `US`. It shows them nowhere and changes no bill until the switch. The first read takes one to two days. [Committee meetings](#committee-meetings-and-the-first-read) explains how to check for the row and why the wait matters.
2. **Run the dry run.** It reads GovInfo's files for the current Congress and matches them to the bills and legislators central holds, and it writes nothing but the API call log:

   ```bash
   curl -X POST "$CENTRAL/api/admin/state-providers/US/cutover" \
     -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
     -d '{"provider":"govinfo"}' > us-cutover-dry-run.json
   ```

3. **Read the report.** It lists the bills that matched and the ones that didn't on each side, the legislators matched by Bioguide id and by name (name matches are weak when chamber and district don't both confirm), any ambiguous or conflicting matches, the tracked bills whose keywords the new titles won't match, and, once the `warm/119` row exists, the calendar entries that keep their identity, are cancelled, or are added. Before the row exists, the calendar part counts no bills. Every legislator LegiScan holds a Bioguide id for who sponsored or voted on a bill in a session the cutover moves is matched on it, whether or not they sponsor a bill the plan reads, and keeps their person id, so no member ends up with a second `people` row. Those GovInfo names on no bill read show LegiScan's name. A legislator with no Bioguide id is matched by name against the sponsors of the tracked bills. Members of earlier Congresses only, which GovInfo never reads, don't move: they keep their LegiScan row and their profile link on their old bills. A legislator who moves loses LegiScan's profile link, since GovInfo has none.
4. **Confirm.** The same request with `?confirm=true` carries out the cutover and starts GovInfo's first sync. The response says how many bills and legislators moved, and whether that sync worked. If it reports an error, the cutover stands, and the hourly sync tries again. That sync covers bills only. Congress's committee meetings reach instances' calendars with the next hourly body-event job, or at once if you run `POST /api/admin/providers/govinfo/sync` right after you confirm.
5. **Undo it if needed.** `POST /api/admin/state-providers/US/undo-cutover` is a dry run too, and `?confirm=true` puts Congress back on LegiScan.

The first sync queues a first ingest for every moved bill. GovInfo has no ingest queue of its own, so those ingests share central's queue with LegiScan's bills and take a while to drain. They make no LegiScan calls. After a cutover, ask the admin of each instance that covers Congress to re-pick the committees in their event rules, because GovInfo mints its own committee ids. The [sync pipeline notes](https://github.com/floorvote/floorvote/blob/main/docs/internal/sync-pipeline.md) cover what a cutover does to calendars, ids, and queues in full.

## Committee meetings and the first read

Once `CONGRESS_API_KEY` is set and at least one active instance covers `US`, central reads committee meetings every hour and keeps them in its `provider_cache` table, so it never reads a meeting twice. It does this whether GovInfo or LegiScan owns `US`. While LegiScan owns it, the meetings only fill that cache: central shows them on no calendar and attaches them to no bill until you switch. The 119th Congress had 2,767 meetings in October 2026. A pass reads at most 60 meeting details an hour, paced at 10 requests a minute, so the first full read takes about one to two days after the key is set. To start the first pass now rather than at the next hour, run `POST /api/admin/providers/govinfo/sync` with the admin secret. While LegiScan owns `US` it syncs no bills, and it answers when the pass ends, up to about eight minutes later. Its answer's `warmed` list says how the pass went: `{"state":"US","ok":true,"warm":false}` while meetings remain to be read, `"warm":true` once the row is written, and `"ok":false` with the error when the pass failed (an `HTTP 403` means the key was refused). If warming keeps failing, the hourly job emails the addresses in `ALERT_EMAILS` once it has failed for four hours (`cron failed: govinfo-body-events`, naming the Congress and the error), again every four hours while it goes on, and once more (`resolved: govinfo-body-events`) when a pass works again. Without a key, nothing warms and nothing alerts.

Until that read finishes, GovInfo can't say a bill has no meeting, because the meeting may be one not read yet. Central marks the read as finished by writing a `warm/<congress>` row for `govinfo` into `provider_cache`: `warm/119` for the 119th Congress, which is the row a cutover before January 3, 2027 needs. **When you cut over, wait for that row before you confirm.** A cutover on or after January 3, 2027 plans against the 120th Congress and needs `warm/120` instead. `warm/119` stays in the table until March, so finding it then says nothing about the 120th. If GovInfo owns `US` before the row exists:

- Bills sync with no calendar at all, which central treats as no word on the entries a bill already has.
- A bill that moved in a cutover keeps the hearings it carried from LegiScan, but only for so long. After three ingests with no calendar, central stops waiting and cancels them, so a busy bill that is ingested that often before the read finishes loses its LegiScan hearings. The meetings the read finds are added to its calendar afterward.

Check for the row with:

```bash
npx wrangler d1 execute central-bills-ls --remote --env legiscan \
  --command "SELECT key, updated_at FROM provider_cache WHERE provider = 'govinfo' AND key = 'warm/119'"
```

Use your central's database and environment names. A switch made after the row exists gives each moved bill its calendar on its first ingest. If you switched first, every record changes once when the row appears, so tracked bills are ingested again, now with their calendars. A meeting that can't be read three passes in a row is set aside and the operators get one email, and it counts as read for this purpose, so one broken meeting can't hold every calendar back.

## The deadline

Do the cutover before January 3, 2027. Two things happen around then:

- **The 120th Congress begins at noon on January 3, 2027.** From that day GovInfo lists the 120th Congress and no longer the 119th, so a cutover plans against 120th bills only. LegiScan's 119th bills would stay with LegiScan, frozen. Finish before the new Congress begins.
- **LegiScan creates its 120th Congress session around the same day.** Each session gets a URL slug that is unique within its state, and a slug never changes once assigned. Whichever session is created first takes the plain slug, `120th-congress`, and the other gets `120th-congress-2`. Once GovInfo owns `US`, LegiScan no longer syncs it, so a cutover that lands before LegiScan creates the 120th leaves the 120th Congress the plain slug. If LegiScan has already created its session, that frozen session holds the plain slug, and every 120th Congress link ends in `-2`.

## The session slug

A cutover doesn't hand LegiScan's session slug to GovInfo. LegiScan's 119th Congress session keeps `119th-congress`, and GovInfo's 119th Congress session becomes `119th-congress-2`, so a moved bill's URL changes to `/US/119th-congress-2/HB1` the next time it reaches an instance. Old links keep working: each instance falls back to the slug the session's name asks for, as long as no other bill answers to the same address. The same happens on a claim if LegiScan has synced Congress here, since its session already holds the plain slug. A deployment that never did gives GovInfo's session `119th-congress`.

## The credit

An instance whose coverage includes `US` shows this credit in its footer's "Data:" line once `US` is claimed, beside the credits for its other states' providers:

> GovInfo Bill Status (GPO and Library of Congress), public domain; roll calls from the House Clerk and the Senate

The name links to GovInfo's Bill Status bulk data. It names the sources and doesn't imply that FloorVote publishes official data. Until `US` is claimed, the instance credits LegiScan for Congress instead.
