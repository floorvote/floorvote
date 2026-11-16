---
title: "Bill tracking features for policy teams"
description: "AI bill summaries with member voting, comments, official team positions, email digests, and hearing calendars for teams tracking state and federal legislation."
---

# What can FloorVote do?

FloorVote is an open, self-hostable bill tracker for any team that tracks legislation—automatic bill summaries, member voting, email notifications, and hearing calendars, all for about $5-7/month in infrastructure.

FloorVote monitors state and federal legislation and surfaces the bills that matter to your team—filtered by your keywords and summarized and tagged by AI according to your instructions. Your team can comment and vote on the bills, and your team can set an official position.

FloorVote can be used by individuals or teams, but it's especially powerful for teams, whether big or small. Instead of everyone on a team monitoring bills on their own and comparing notes over email or in meetings, FloorVote gives the whole team one shared place to watch, discuss, and respond to the bills that matter to them.

Each team gets a private, isolated deployment with its own database, member roster, bill list, activity feed, and calendar.

## Set keywords for the topics you care about

Point FloorVote at the states you track—and Congress, if federal legislation matters to you—and you get access to every bill introduced there.

From that full pool, you set keywords for the issues your team actually cares about. Whenever a bill's title, description, or bill number matches one of your keywords, FloorVote pulls it out for a closer look—summarizing, tagging, and everything else below—so nobody on your team has to track the whole legislative session by hand. Bills that don't match stay on the Bills page with their status, but without AI analysis.

## Custom AI summaries, relevance scores, tags

Once a bill matches, AI reads it and produces a plain-language summary, a relevance score, and tags—so your team can tell at a glance what a bill does and whether it's worth their attention. Individual sentences in the bill summary link directly to the passages of the bill that it is summarizing, so you can easily find a specific provision buried in a huge bill.

You control how the analysis works: write your own directions for what "relevant" means to your team, and the AI scores bills and pulls tags from your own taxonomy accordingly. The full bill text, fiscal notes, and amendments are all accessible right there next to the summary.

## Voting

Team members record how they feel about a bill by voting support, oppose, or neutral.

Admins can make prioritized bills show up in each member's sidebar as a standing reminder to vote on them.

## Commenting

Team members discuss each bill on its page with comments and reactions, file attachments, and personal notes. The page also shows who changed the bill's priority, position, or custom fields, and when.

## Set positions

Once the team has talked a bill through, admins can set the team's official position. That's the position your team might point to publicly or share with a coalition.

## Notifications

Admins decide whether FloorVote emails members at all, and each person chooses which emails they get.

**Admins:** in the **Emails** box on the Config page, **Send email to members** is the one switch. Turn it off and FloorVote stops the email digest, the week ahead email, and mention and reply emails for everyone, after asking you to confirm. Sign-in links, invites, and email-change confirmations still send, and people still see mentions and replies in FloorVote. The same box sets **Week ahead email day**, the day that email goes out for everyone, so you know when events need to be on the calendar. It starts on Friday for a new instance.

**Everyone:** each person's own settings are on the **Notifications** tab, next to Account. It looks the same for every role, and each setting says what it does.

- **Email digest.** One email that sums up what changed on your bills since the last one, sent only when something changed. In the menu beside its heading, each person chooses how often: every morning, or once a week on a weekday they pick. It has three parts:
  - **Changes to bills marked as priorities by your team:** status changes, hearings, positions, and comments on them.
  - **New bills that may be relevant to your team:** bills that just matched your team's keywords.
  - **Saved views you follow:** you get what changed in each one you follow, even with the other two parts off. A saved view is a filtered list of bills; follow one by clicking the envelope beside it in the Views menu on the Bills page. They show as chips, and you can remove one there.

  A bill with a priority that's also in a view you follow appears once, under priority bills. If you've turned that part off, it appears in the view.
- **Week ahead email.** Next week's hearings on your team's priority bills and events on your team calendar. The card says which day it's sent.
- **Comments.** Mentions of you always send an email. "Someone replies on a bill you commented on" has your own switch, and covers FloorVote and email.

Everything starts on for every person, with the digest every morning. When an admin has turned off email to members, a line at the top of the tab says so, and the email settings are disabled. The replies switch still works, since it also covers FloorVote. (If your instance calls its group something else, such as a coalition, the settings on that tab use that word.) Links in emails go straight to the setting that stops them, and older links still land in the right place.

## Feed

A single feed shows everything happening across your tracked bills and your team—new bills, comments, votes, and position changes—so members can easily stay on top of the conversation.

Bills with a priority get a card for every change, and a bill with no priority gets one for any day the team comments, votes, or takes a position on it. Legislative activity on the rest of your analyzed bills gets one row a day instead: "Updates on 9 bills with no priority," followed by the two most relevant bills as chips and a count of the others. Companion bills count as one entry, and their movement shows when any of them is an analyzed match at or above your minimum relevance, even if the one that moved isn't. Open the row to see every bill that moved, most relevant first, with that day's changes. Admins can set a priority from the row, which gives the bill a card of its own from then on. On a day when only one of those bills moved, it shows as a regular card, with "Set priority" at the top right for admins. The row never lights the Feed dot and never goes in the email digest.

## Searchable bills page

Every bill in the states you are tracking is accessible on one page.

Search covers bill numbers, titles, abstracts, and AI summaries, and a comma-separated list of bill numbers pulls up a whole batch at once. Filters narrow the list by state, session, status, tag, committee (current or any referral), priority, position, and custom fields. Where a state publishes its own data, statuses group by stage, so bills compare across states.

### Triage new matches

Each newly matched bill waits for an admin to give it a priority or dismiss it, marked "New" until they do. A New matches filter lists what's waiting, a minimum relevance score keeps weak matches out, and the team's feed gets a daily row of new matches.

### Saved views

Save any combination of filters as a named view the whole team shares, such as one per committee, issue area, or member's beat. A view can be bookmarked, sent as a link, or followed: the envelope beside a view emails you what changed in it, on your digest's schedule, with one click. The envelope shows while your team sends email to members.

### Bulk edit bills

Admins can select bills and edit them together—set a priority, record the team's position, or fill in custom fields across the whole selection in one step.

## Shared calendar

Hearings on your prioritized bills land on a shared calendar as they're scheduled, alongside your own events, dates from your custom fields, and, where a state publishes one, the legislature's own calendar. Members can subscribe from Outlook or Google Calendar, and you can import a spreadsheet or .ics file of events.

## Custom fields

Track whatever else matters to your team with custom fields you define yourself: perhaps a "Testimony submitted" checkbox, a "Lead person" dropdown, or a "Draft amendment" text field.

## Roles and permissions

Not everyone on a team needs the same level of access. FloorVote has three permission levels—owner, admin, and standard member—plus roles you define yourself, like committees, so you can group members however your team actually works.

Admins can also restrict voting on a per-member basis, for cases where someone should be able to follow and discuss bills without casting an official vote.

## Companion bills

When legislators file companion bills in both chambers, FloorVote combines the pair so there's just one place for your team to discuss. Comments, votes, priority, and position are all on that one page, though each bill's status is still being tracked individually. Admins can group or split bills by hand.

## Try it

See FloorVote in action at this [demo site](https://demo.floorvote.org/).
