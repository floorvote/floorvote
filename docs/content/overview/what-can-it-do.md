---
title: "Bill tracking features for policy teams"
description: "AI bill summaries, member voting, comments, official team positions, email digests, and hearing calendars for teams tracking state and federal legislation."
---

# What can FloorVote do?

FloorVote is an open, self-hostable bill tracker for any team that tracks legislation—automatic bill summaries, member voting, email notifications, and hearing calendars, all for about $5-7/month in infrastructure.

FloorVote monitors state and federal legislation and surfaces the bills that matter to your team—filtered by your keywords and summarized and tagged by AI according to your instructions. Your team can comment and vote on the bills, and your team can set an official position.

FloorVote can be used by individuals or teams, but it's especially powerful for teams, whether big or small. Instead of everyone on a team monitoring bills on their own and comparing notes over email or in meetings, FloorVote gives the whole team one shared place to watch, discuss, and respond to the bills that matter to them.

Each team gets a private, isolated deployment with its own database, member roster, bill list, activity feed, and calendar.

## Set keywords for the topics you care about

Point FloorVote at the states you track—and Congress, if federal legislation matters to you—and you get access to every bill introduced there. Some legislatures also publish their own data, which adds details LegiScan doesn't carry. See [State coverage](/contributing/state-coverage) for what exists for each state.

From that full pool, you set keywords for the issues your team actually cares about. Whenever a bill's title, description, or bill number matches one of your keywords, FloorVote pulls it out for a closer look—summarizing, tagging, and everything else below—so nobody on your team has to track the whole legislative session by hand. Bills that don't match stay on the Bills page with their status, but without AI analysis.

Matching is case-insensitive, and a keyword on its own matches a whole word: `election` matches "election" but not "elections" or "selection". Add `*` to widen it. `election*` also matches "elections", and `*corporat*` matches "corporations" and "incorporated". Phrases work too (`board of canvassers`), and `#` stands for one digit, so `5.#*` matches the statute sections "5.02" and "5.35" but not "115.385".

To bring in every bill in the states you track, make `*` your only keyword. Every bill then goes through AI analysis, which costs more than a keyword list does, so FloorVote shows how many bills it would queue before you confirm.

As you type, the keywords box shows how many of the bills already in your deployment the set would match, and, once you change it, how many bills saving would newly match or unmatch. Nothing is saved, and no AI runs, until you save.

## Custom AI summaries, relevance scores, tags

Once a bill matches, AI reads it and produces a plain-language summary, a relevance score, and tags—so your team can tell at a glance what a bill does and whether it's worth their attention.

You control how that analysis works: write your own directions for what "relevant" means to your team, and the AI scores bills and pulls tags from your own taxonomy accordingly. The full bill text, fiscal notes, and amendments are all accessible right there next to the summary.

The AI model itself is an operator setting rather than a team one. It defaults to Google Gemini 2.5 Flash, and [Choosing the analysis model](/self-hosting/tenants#choosing-the-analysis-model) covers switching it.

## Voting

Team members record how they feel about a bill by voting support, oppose, or neutral.

Admins can make prioritized bills show up in each member's sidebar as a standing reminder to vote on them.

## Commenting

Team members can discuss any bill directly on its page with comments and reactions, so the conversation about a bill lives next to the bill itself instead of scattered across email threads. On that same page, members can also keep personal notes on the bill that are visible only to them.

## Set positions

Once the team has talked a bill through, admins can set the team's official position. That's the position your team might point to publicly or share with a coalition.

## Custom fields

Track whatever else matters to your team with custom fields you define yourself: perhaps a "Testimony submitted" checkbox, a "Lead person" dropdown, or a "Draft amendment" text field.

## Roles and permissions

Not everyone on a team needs the same level of access. FloorVote has three permission levels—owner, admin, and standard member—plus roles you define yourself, like committees, so you can group members however your team actually works.

Admins can also restrict voting on a per-member basis, for cases where someone should be able to follow and discuss bills without casting an official vote.

## Notifications

Members get notified whenever anyone @-mentions them (or a role they have) in a comment, and they always get an email for it. Any member can also mention @admins to reach everyone who is an admin or owner, such as to flag a newly matched bill that needs a priority. Who counts as an admin is worked out when the comment is posted. Commenting on a bill also makes you a participant in its comments: when someone else comments on it, you get a notification in the app and an email right away. Replies to one bill group into a single conversation in your mail client. Voting on a bill, writing a note, or being mentioned doesn't make you a participant, and editing a comment never sends new notifications. To stop hearing about a bill's comments, mute it from the bill page or from the link in any reply email. Muting works before you've commented, quiets the bill in the app and by email, and never hides a mention. When someone reacts to your comment, you get a notification in the app (never an email), and the panel groups everyone who reacted to that comment into one row. Reacting to your own comment doesn't notify you, and taking a reaction back doesn't remove the notification it already sent. Admins can turn conversation emails (mentions and replies) off for the whole instance on the Notifications settings page. In-app notifications aren't affected.

Weekly or daily email digests round up what's changed on prioritized bills, and a week-ahead email flags upcoming hearings. Each member controls both, and whether to get reply emails, from the "Your Email" section of their profile.

## Feed

A single feed shows everything happening across your tracked bills and your team—new bills, comments, votes, and position changes—so members can easily stay on top of the conversation.

## Bills page

Every bill in the states you are tracking is accessible on one page.

### Search and filter

Search covers bill numbers, titles, abstracts, and the AI summaries. Separate several terms with commas to look up a batch of bills at once—paste in a list of bill numbers and you get that whole batch in one result, with the bill-number matches at the top.

Filters narrow the list by state, session year, status, stage, tag, subject, priority, and your team's official position, plus any custom fields you've defined. Stage compares where bills are in the process across states, and appears once a state you track is read from the legislature's own data rather than LegiScan. Quick toggles show your own bills and the bills you haven't voted on yet.

### Subjects

Many legislatures label each bill with subject terms. When a bill has them, its page shows a collapsible Subjects list, open by default for a bill with no AI analysis, and clicking a subject opens the Bills page filtered to it. The Bills page also has a Subject filter.

The filter groups subjects by state, because each legislature has its own vocabulary: some use a few dozen broad terms and others thousands of fine-grained ones, so "Education" in one state isn't the same as "Education" in another. Subjects are the legislature's labels, separate from the tags your own AI instructions assign. An operator can hide them for a state or for the whole instance, as [Hiding subjects](/self-hosting/tenants#hiding-subjects) explains.

### Saved views

Any set of filters your team returns to can be saved as a named view, and views are shared—an admin sets one up with Save as view and every member sees it in the switcher. A view keeps the filters and sort order from when it was saved, and applying one puts its name in the page address, so a view can be bookmarked or sent to a teammate. That turns a filter combination into a permanent part of the team's setup: a view per committee, per issue area, or per member's beat. Admins can rename a view, replace its filters with the ones currently applied, delete it, and drag views into whatever order makes sense for the team.

### Bulk edit bills

Admins can select bills and edit them together—set a priority, record the team's position, or fill in custom fields across the whole selection in one step.

### Triage new matches

When a bill newly matches your keywords, it needs a quick decision: assign it a priority, or dismiss it if it's not actually relevant. Admins get a New matches filter that shows which bills are still waiting on that decision, and can set a minimum relevance score under Settings → Config to keep low-relevance matches out of it.

## Shared calendar

Hearings on bills your team has prioritized are added to your team's calendar automatically as they're scheduled. You can add custom events of your own (like coalition calls) alongside them. Everyone on the team can subscribe to the calendar from their own calendar app.

Where a state's data includes the legislature's own calendar (DC's Council calendar, for one), its hearings, roundtables, and meetings appear too, with or without a bill on the agenda. Admins choose which ones under Settings → Calendar events, by committee, kind of event, topic keywords, or bills the team tracks. An event with a prioritized bill on its agenda always shows, and an event the choices leave out drops out of the calendar subscription too. Where a state's data includes deadlines, such as the end of the executive's time to sign or veto, a prioritized bill's deadlines go on the calendar alongside its hearings, and every bill's next deadline shows on its bill page.

You can also import a full spreadsheet or .ics file of events at once.

## Try it

See FloorVote in action at this [demo site](https://demo.floorvote.org/).
