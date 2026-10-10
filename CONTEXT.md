# FloorVote Glossary

**Draft bill**: a bill a team tracks before it is officially filed; tenant-local, created by an admin, with no legislative data until linked.

**Link**: the admin action that folds a draft bill's engagement (votes, positions, comments, notes, custom fields, calendar events) into its filed bill and deletes the draft. Where both carry the same engagement, the filed bill's wins. Avoid: "merge" as the name of the action.

**Instance**: one organization's own FloorVote deployment, with its own data, people, and settings. Avoid: "tenant" in product copy; "site"; "workspace."

**Member**: anyone with a login in an instance, whatever their permission level. Avoid: "user" in product copy; "group member."

**Permission level**: what a member may do in the instance: Owner, Admin, or Standard member. Avoid: "role," which means a named group (below).

**Owner**: the permission level that can do everything an Admin can, plus manage admins and owner-only settings.

**Admin**: the permission level that manages members, roles, notifications, and instance settings.

**Standard member**: the default permission level: follows bills, comments, and can be mentioned, with no administrative access. Avoid: plain "member" when contrasting with Admin.

**Role**: a named group of members that an admin defines, which can be @-mentioned together. Avoid: "group"; "team" when meaning a subset of members.

**Invite**: the email that brings a new member into an instance. Avoid: "invitation link" as the name of the email.

**Pending invite**: a member who was invited and hasn't signed in yet.

**Bounced invite**: a pending invite whose latest invite or sign-in email couldn't be delivered. Shown as "Email bounced." Avoid: "failed invite" (the email failed, not the invite); "undeliverable."

**Previously bounced address**: an address whose most recent delivery outcome from this instance was a bounce (a later delivery clears it), or that the email provider refuses to send to. Shown as "previously bounced." Avoid: "suppressed" in product copy.

**Provider**: where central gets a state's legislative data (LegiScan by default, or a legislature's own feed), and the adapter in `central/src/providers/` that reads it and maps it into central's shapes. Unrelated to the email provider. Avoid: "source" in code and copy, since it already means a calendar event's source and a bill's page on the legislature's site; "data source."

**State ownership**: which provider a state's legislative data comes from, one row per state in central's `state_providers` table, changed by an operator's claim. A state with no row is LegiScan's. A claim is refused while the state's current provider has tracked bills there, and only a cutover moves those. In central code and the admin API, a state's provider is its "owner," unrelated to the Owner permission level.

**Bill handle**: a central bill's stable id as instances store it, in a tenant bill's `external_id` (for example `legiscan:123`, where `123` is central's bill row id). The `legiscan:` prefix is legacy and means "central bill," not where the data came from: a bill's provider belongs on the bill itself, and a bill keeps its handle when its state changes provider. Build and parse handles only through the helpers (`shared/billHandle.ts` for the instance API and web app, `central/src/lib/billHandle.ts` in central). Avoid: "LegiScan id" for a handle; reading provenance from the prefix.
