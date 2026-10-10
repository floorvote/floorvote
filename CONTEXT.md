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

**Extra**: a field only one provider publishes (a DC law number, Maryland statute citations), declared in that provider's vocabulary with a label and display type and shown on the bill page in one "Additional information from <provider>" panel. Display only: a field that needs sorting, filtering, notifications, or AI, or that a second provider publishes, becomes a shared column instead. Avoid: "custom field," which is an instance's own field that members fill in.

**Stage**: the common step a bill's status belongs to, the same across legislatures: Introduced, In committee, Passed one chamber, Passed legislature, Failed, Vetoed, or Enacted. Each provider's vocabulary assigns its statuses to stages, so members can filter and compare bills across states whose status names differ. Avoid: "status" for a stage, since a status is the legislature's own term (DC's "Under Mayoral Review" is in the Passed legislature stage).

**Calendar entry kind**: what a bill's calendar entry is: a hearing, a markup (a committee acting on the bill, such as a mark-up or an executive session), a meeting, or a deadline (a date set in law for the bill's next step, not a meeting). Central sets it from the provider's vocabulary and sends it with every entry. Avoid: reading an entry's kind from its identity or type id.

**Calendar entry identity**: the key central keeps a bill's calendar entry under for as long as it exists, and that instances build its calendar UID from: the provider's own event id, or else the entry's kind, date, and description, never its position. LegiScan's entries keep the identity they always had (type and description). Changing an entry's identity makes every subscriber's calendar show it cancelled and recreated.
