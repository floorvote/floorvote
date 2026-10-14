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

**Cutover**: moving a state that instances already track from its provider to another, run by an operator after a dry run. Each matched bill keeps its central row id, so its handle and every instance's copy of it stay as they are. Matched calendar entries keep their identities, and matched legislators their person ids. The new provider's first ingest of each bill sends no changes, and an undo puts the state back. Avoid: "migration"; "rekeying," which was #259's approach of rewriting each instance's bills.

**Bill handle**: a central bill's stable id as instances store it, in a tenant bill's `external_id` (for example `legiscan:123`, where `123` is central's bill row id). The `legiscan:` prefix is legacy and means "central bill," not where the data came from: a bill's provider belongs on the bill itself, and a bill keeps its handle when its state changes provider. Build and parse handles only through the helpers (`shared/billHandle.ts` for the instance API and web app, `central/src/lib/billHandle.ts` in central). Avoid: "LegiScan id" for a handle; reading provenance from the prefix.

**Extra**: a field only one provider publishes (a DC law number, Maryland statute citations), declared in that provider's vocabulary with a label and display type and shown on the bill page in one "Additional information from <provider>" panel. Display only: a field that needs sorting, filtering, notifications, or AI, or that a second provider publishes, becomes a shared column instead. Avoid: "custom field," which is an instance's own field that members fill in.

**Relationship kind**: how one bill relates to another, the same across legislatures: **identical** (the same bill filed twice, usually one in each chamber), **package** (different bills the legislature moves together, such as Michigan's tie-barred bills), or **related** (anything else the legislature links, and any label the provider's vocabulary doesn't map). Each provider's vocabulary maps its own relationship labels to a kind, with per-state overrides, and central attaches the kind when it serves a bill's related bills. The bill page shows them as "Identical to," "Part of a package," and "Related." Avoid: "companion" for a kind (an identical companion is a bill whose relationship is `identical`); "type" for a kind, since a relationship's type is the provider's own label.

**Companion group**: the bills in an instance linked by `identical` relationships, named by either bill, including chains (A190 identical to S1713, and S1713 to S1714, makes one group of three). The team's engagement belongs to the group, but it is never moved: comments, votes, and notes stay on the bill where they were made, and reads resolve across the group. The group's comments interleave by time on every member's page, a member's vote and note are their most recent across the group, and each team field is the one set most recently on any member. Splitting a group gives each bill back its own, with no data migration. Package and related bills are never grouped. Avoid: "merged bills," since every bill keeps its own record and page; "companion" for the group itself (a companion is one of its bills).

**Group key**: a bill's `bills.group_key`, the smallest id among the bills in its companion group, or null for a bill with no identical companion in the instance. Only `api/src/lib/companionGroups.ts` writes it, recomputing groups on each delivery of a bill from central from the identical relationships stored by handle in `bill_identical_links`. Reads find a group through `inGroupOf` there, never by comparing keys by hand.

**Team event**: a structured record of a change to a bill's team-level state, one row per bill in `team_events`, with the actor (null when FloorVote did it automatically), a type, and per-type metadata. A companion group forming (`grouped`, which also lists the team field values it replaced) or splitting (`split`), each naming the bills joined or left, and a team field changing (`field_changed`: the field, and the group's old and new value) on the bill where it was set. Kept for the bill's own history, not the feed. Avoid: "feed event," which is the activity stream's row.

**Team field**: a value the team keeps per bill rather than per member: the official position, priority, custom field values, triage, and the team summary and tags from the AI analysis. A companion group shares them. Each stays stored on the bill where it was set, and every member's page reads the one set most recently on any member (`api/src/lib/teamFields.ts`), so setting one on any member's page sets the group's, triaging any member triages the group, and splitting gives each bill back its own. Clearing one clears it on every member. When bills with different values group, the older values give way, and the grouping event lists them. Avoid: "custom field" for all of them, since a custom field is one kind of team field.

**Grouping line**: the line a bill's comment thread shows where its companion group formed or split, set between the comments posted before and after: "Grouped with S1713 as identical bills on October 11. Earlier comments from both now appear together." Where the grouping replaced a team field value, the line says so: "S1713's position, Oppose, was replaced by A190's, Support." Read from the bill's own grouping team events.

**Stage**: the common step a bill's status belongs to, the same across legislatures: Introduced, In committee, Passed one chamber, Passed legislature, Failed, Vetoed, or Enacted. Each provider's vocabulary assigns its statuses to stages, so members can filter and compare bills across states whose status names differ. Avoid: "status" for a stage, since a status is the legislature's own term (DC's "Under Mayoral Review" is in the Passed legislature stage).

**Calendar entry kind**: what a bill's calendar entry is: a hearing, a markup (a committee acting on the bill, such as a mark-up or an executive session), a meeting, or a deadline (a date set in law for the bill's next step, not a meeting). Central sets it from the provider's vocabulary and sends it with every entry. Avoid: reading an entry's kind from its identity or type id.

**Calendar entry identity**: the key central keeps a bill's calendar entry under for as long as it exists, and that instances build its calendar UID from: the provider's own event id, or else the entry's kind, date, and description, never its position. LegiScan's entries keep the identity they always had (type and description). Changing an entry's identity makes every subscriber's calendar show it cancelled and recreated.

**Body event**: an event on a legislature's own calendar (a hearing, roundtable, mark-up, or meeting, with or without bills on its agenda), from a provider that publishes one, such as DC's Council calendar. Central keeps it under the provider's own event id, and a bill's calendar entry it covers is shown as the body event, so a hearing appears once. Avoid: "council event," which names one legislature's; "hearing without a bill" as the name, since a body event can have bills and can be a meeting.

**Capability**: what a state's data can do, from the provider that owns the state, such as body events or deadlines. Instances gate features on capabilities, never on a state's name.

**Notification**: one stored item in a member's notifications panel, telling them about an event on a bill's comments, of a kind (a mention today; replies and reactions follow). Written when the event happens, marked read when the member opens the panel or the bill, and hidden once its comment is deleted. Avoid: "alert"; "mention" for a notification of another kind.
