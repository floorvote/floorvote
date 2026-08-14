import type { DemoSeed, DemoSeedComment, DemoSeedMention, DemoSeedReaction } from '../types'

/**
 * Comments, reactions, mentions, votes, and notes for all 20 Lake Michigan bills.
 *
 * Each thread's register follows the bill's real posture. Live bills with a
 * scheduled hearing (Michigan's HB4427, HB5308, and HB5674; Illinois HB1175;
 * Indiana HB1124; federal HB8876) get near-term, working-the-bill chatter —
 * testimony, who covers the room, what the ask is. Enacted bills get
 * outcome-and-implementation threads. The two Wisconsin bills that died at the
 * end-of-biennium deadline, and Indiana's withdrawn beach-parking bill, get short
 * post-mortems about what to reintroduce. The federal bills are appropriations-
 * and-programs bills, so their register is funding and timing, not statutory text.
 *
 * Comments stay short and plain — one idea, a sentence or three, under the
 * 120-character feed preview cap — because the point of the demo is to show the
 * feature surface (comments, reactions, mentions, votes, notes), not to
 * relitigate the bills in memo form.
 */

// ---------------------------------------------------------------------------
// MI HB4427 — legiscan:2029026 (sewage/E. coli "brown alert")
// ---------------------------------------------------------------------------
const hb4427: DemoSeedComment[] = [
  { id: 'lm-c-1', externalId: 'legiscan:2029026', userId: 'lm-user-la1',
    content: "<p>Senate Local Government has us on its agenda. I'll have written testimony ready the day before.</p>", daysAgo: 33 },
  { id: 'lm-c-2', externalId: 'legiscan:2029026', userId: 'lm-user-wq',
    content: '<p>Beach closures were up along our stretch last summer. This would tell people the same day, not two days later.</p>', daysAgo: 33 },
  { id: 'lm-c-3', externalId: 'legiscan:2029026', userId: 'lm-user-comms',
    content: '<p>If this passes the Senate, the brown alert name makes a clean, simple press release. People will get it immediately.</p>', daysAgo: 32 },
  { id: 'lm-c-4', externalId: 'legiscan:2029026', userId: 'lm-user-ed',
    content: '<p><span data-type="mention" data-id="user:lm-user-la1" data-label="Devon Brook">@Devon Brook</span> can you cover the hearing in person? I\'m traveling that day.</p>', daysAgo: 32 },
  { id: 'lm-c-5', externalId: 'legiscan:2029026', userId: 'lm-user-la1',
    content: "<p>I've got it, I'll be there.</p>", daysAgo: 32 },
  // The mention sits mid-sentence on purpose: stripHtml() replaces the span with a
  // space, so a mention immediately before a period renders "…@Devon Brook ." on
  // the feed card.
  { id: 'lm-c-6', externalId: 'legiscan:2029026', userId: 'demo-user',
    content: '<p>Testimony is submitted. Thanks to <span data-type="mention" data-id="user:lm-user-la1" data-label="Devon Brook">@Devon Brook</span> for the fast turnaround.</p>', daysAgo: 31 },
]

// The two stacked pills the demo needs: four people on 👍 for lm-c-6 (the newest
// card in the feed) and three on 👍 for lm-c-2, so the reaction row shows a real
// count badge rather than a line of lone 1s.
const hb4427Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-1', commentId: 'lm-c-2', userId: 'demo-user', emoji: '👍', daysAgo: 32 },
  { id: 'lm-r-38', commentId: 'lm-c-2', userId: 'lm-user-la1', emoji: '👍', daysAgo: 32 },
  { id: 'lm-r-39', commentId: 'lm-c-2', userId: 'lm-user-comms', emoji: '👍', daysAgo: 32 },
  { id: 'lm-r-2', commentId: 'lm-c-6', userId: 'lm-user-ed', emoji: '👍', daysAgo: 31 },
  { id: 'lm-r-35', commentId: 'lm-c-6', userId: 'lm-user-comms', emoji: '👍', daysAgo: 31 },
  { id: 'lm-r-36', commentId: 'lm-c-6', userId: 'lm-user-wq', emoji: '👍', daysAgo: 31 },
  { id: 'lm-r-37', commentId: 'lm-c-6', userId: 'lm-user-dep', emoji: '👍', daysAgo: 31 },
  { id: 'lm-r-50', commentId: 'lm-c-5', userId: 'lm-user-ed', emoji: '❤️', daysAgo: 32 },
]

// Karen asks by name the analyst who volunteered the written testimony in
// lm-c-1, and he answers in lm-c-5. This was a @Michigan Team fan-out,
// which put a 32-day-old sewage bill in the demo visitor's bell — see the
// recency test in demoSeeds.lakeMichigan.test.ts. Person-to-person is also the
// truer read: lm-c-1 already has Devon on the testimony.
const hb4427Mentions: DemoSeedMention[] = [
  { id: 'lm-m-1', commentId: 'lm-c-4', userId: 'lm-user-la1', sourceType: 'user', sourceId: 'lm-user-la1', daysAgo: 32 },
  { id: 'lm-m-4', commentId: 'lm-c-6', userId: 'lm-user-la1', sourceType: 'user', sourceId: 'lm-user-la1', daysAgo: 31 },
]

const hb4427Votes: DemoSeed['votes'] = [
  { id: 'lm-v-1', externalId: 'legiscan:2029026', userId: 'demo-user', position: 'support', daysAgo: 45 },
  { id: 'lm-v-2', externalId: 'legiscan:2029026', userId: 'lm-user-la1', position: 'support', daysAgo: 44 },
  { id: 'lm-v-3', externalId: 'legiscan:2029026', userId: 'lm-user-comms', position: 'support', daysAgo: 43 },
  { id: 'lm-v-4', externalId: 'legiscan:2029026', userId: 'lm-user-wq', position: 'support', daysAgo: 42 },
  { id: 'lm-v-5', externalId: 'legiscan:2029026', userId: 'lm-user-ed', position: 'support', daysAgo: 41 },
]

// ---------------------------------------------------------------------------
// MI HB5308 — legiscan:2055958 (invasive species watercraft decal)
// ---------------------------------------------------------------------------
const hb5308: DemoSeedComment[] = [
  // The 105-to-1 roll call was April 29, months before this comment — so it reads
  // as the reason the Senate committee ask is easy, not as fresh news.
  { id: 'lm-c-7', externalId: 'legiscan:2055958', userId: 'demo-user',
    content: '<p>It cleared the House 105 to 1 back in April. That margin is our best argument in the Senate committee.</p>', daysAgo: 5 },
  { id: 'lm-c-8', externalId: 'legiscan:2055958', userId: 'lm-user-la1',
    content: "<p>Testimony deadline is on the calendar now. I can have a draft to you two days ahead of it.</p>", daysAgo: 4 },
  { id: 'lm-c-9', externalId: 'legiscan:2055958', userId: 'lm-user-gov',
    content: '<p>Boaters associations are going to like this one—a decal fee that actually funds prevention work.</p>', daysAgo: 4 },
  { id: 'lm-c-10', externalId: 'legiscan:2055958', userId: 'lm-user-res',
    content: "<p>Michigan's invasive mussel counts are still climbing on the west shoreline. Good timing for this.</p>", daysAgo: 3 },
  { id: 'lm-c-11', externalId: 'legiscan:2055958', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-habitat" data-label="Habitat">@Habitat</span> should we flag this decal fee model to the other states we track?</p>', daysAgo: 3 },
  { id: 'lm-c-12', externalId: 'legiscan:2055958', userId: 'lm-user-res',
    content: '<p>Good idea <span data-type="mention" data-id="user:demo-user" data-label="Josh Marsh">@Josh Marsh</span> — I\'ll draft a quick comparison for the coalition call.</p>', daysAgo: 3 },
]

const hb5308Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-3', commentId: 'lm-c-7', userId: 'lm-user-ed', emoji: '👍', daysAgo: 5 },
  { id: 'lm-r-4', commentId: 'lm-c-10', userId: 'demo-user', emoji: '🤔', daysAgo: 3 },
  { id: 'lm-r-51', commentId: 'lm-c-7', userId: 'lm-user-la1', emoji: '💯', daysAgo: 5 },
]

const hb5308Mentions: DemoSeedMention[] = [
  { id: 'lm-m-5', commentId: 'lm-c-11', userId: 'lm-user-res', sourceType: 'role', sourceId: 'lm-role-habitat', daysAgo: 3 },
  { id: 'lm-m-6', commentId: 'lm-c-11', userId: 'lm-user-prog', sourceType: 'role', sourceId: 'lm-role-habitat', daysAgo: 3 },
  { id: 'lm-m-7', commentId: 'lm-c-11', userId: 'lm-user-data', sourceType: 'role', sourceId: 'lm-role-habitat', daysAgo: 3 },
  // Person-to-person reply mention: Grace answering the demo visitor by name.
  { id: 'lm-m-36', commentId: 'lm-c-12', userId: 'demo-user', sourceType: 'user', sourceId: 'demo-user', daysAgo: 3 },
]

const hb5308Votes: DemoSeed['votes'] = [
  { id: 'lm-v-6', externalId: 'legiscan:2055958', userId: 'demo-user', position: 'support', daysAgo: 20 },
  { id: 'lm-v-7', externalId: 'legiscan:2055958', userId: 'lm-user-la1', position: 'support', daysAgo: 19 },
  { id: 'lm-v-8', externalId: 'legiscan:2055958', userId: 'lm-user-comms', position: 'support', daysAgo: 18 },
  { id: 'lm-v-9', externalId: 'legiscan:2055958', userId: 'lm-user-wq', position: 'support', daysAgo: 17 },
]

// ---------------------------------------------------------------------------
// MI SB0771 — legiscan:2095619 (septic and onsite wastewater)
// ---------------------------------------------------------------------------
const sb0771: DemoSeedComment[] = [
  { id: 'lm-c-13', externalId: 'legiscan:2095619', userId: 'demo-user',
    content: '<p>Good news—this cleared committee this morning.</p>', daysAgo: 77 },
  { id: 'lm-c-14', externalId: 'legiscan:2095619', userId: 'lm-user-gc',
    content: '<p>Substitute language clears up the assessment cost question we flagged. Much better draft.</p>', daysAgo: 77 },
  { id: 'lm-c-15', externalId: 'legiscan:2095619', userId: 'lm-user-dep',
    content: '<p><span data-type="mention" data-id="user:lm-user-gov" data-label="Marina Okafor">@Marina Okafor</span> flagging for the tracker, this just moved to third reading.</p>', daysAgo: 72 },
  { id: 'lm-c-16', externalId: 'legiscan:2095619', userId: 'lm-user-gov',
    content: '<p>Added. The counties association is the group to watch here—they carry the evaluation cost objection.</p>', daysAgo: 71 },
  // The oppose side of the split shown by sb0771Votes below — one reason per
  // dissenter, so neither oppose vote sits there unexplained.
  { id: 'lm-c-89', externalId: 'legiscan:2095619', userId: 'lm-user-gov',
    content: "<p>I'm a no on this. My counties can't absorb the evaluation cost, and the substitute leaves it to rulemaking.</p>", daysAgo: 66 },
  { id: 'lm-c-91', externalId: 'legiscan:2095619', userId: 'lm-user-la2',
    content: '<p>No from me too. Wisconsin ran this assessment model and the county cost-share never materialized.</p>', daysAgo: 65 },
  // The bill has sat on third reading order since June 17, so the ask is about
  // the floor vote, not about reaching third reading.
  { id: 'lm-c-17', externalId: 'legiscan:2095619', userId: 'lm-user-grants',
    content: "<p>Testimony is in the record. It's been on third reading order since June, so a cost-share amendment is the ask.</p>", daysAgo: 25 },
  { id: 'lm-c-18', externalId: 'legiscan:2095619', userId: 'lm-user-wq',
    content: '<p>Third reading order is good news. This basin has needed septic oversight for years.</p>', daysAgo: 24 },
]

const sb0771Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-5', commentId: 'lm-c-13', userId: 'lm-user-dep', emoji: '👍', daysAgo: 77 },
  { id: 'lm-r-6', commentId: 'lm-c-13', userId: 'lm-user-gc', emoji: '👍', daysAgo: 77 },
]

// Varsha flags it to the one person who works the counties relationship, and
// Marina answers in lm-c-16 — so the reply reads as an answer rather than a
// coincidence. Was an @Infrastructure fan-out, which put a 72-day-old septic
// bill at the bottom of the demo visitor's bell.
const sb0771Mentions: DemoSeedMention[] = [
  { id: 'lm-m-8', commentId: 'lm-c-15', userId: 'lm-user-gov', sourceType: 'user', sourceId: 'lm-user-gov', daysAgo: 72 },
]

// A genuine internal split: the mandate is right on the merits, but the evaluation
// cost lands on counties. Marina (lm-user-gov) works that relationship directly and
// says so in lm-c-16 and lm-c-89; Sofia (lm-user-la2) is on the Infrastructure
// working group that owns this bill's theme and brings the Wisconsin precedent in
// lm-c-91. Both oppose votes have a comment behind them.
const sb0771Votes: DemoSeed['votes'] = [
  { id: 'lm-v-10', externalId: 'legiscan:2095619', userId: 'demo-user', position: 'support', daysAgo: 70 },
  { id: 'lm-v-11', externalId: 'legiscan:2095619', userId: 'lm-user-gc', position: 'neutral', daysAgo: 68 },
  { id: 'lm-v-66', externalId: 'legiscan:2095619', userId: 'lm-user-gov', position: 'oppose', daysAgo: 67 },
  { id: 'lm-v-67', externalId: 'legiscan:2095619', userId: 'lm-user-la2', position: 'oppose', daysAgo: 65 },
]

// ---------------------------------------------------------------------------
// MI HB5674 — legiscan:2129983 (clean drinking water in schools)
// ---------------------------------------------------------------------------
const hb5674: DemoSeedComment[] = [
  { id: 'lm-c-19', externalId: 'legiscan:2129983', userId: 'lm-user-res',
    content: "<p>This is the schools bill we've been waiting for. Lead testing every three years, results posted publicly.</p>", daysAgo: 5 },
  { id: 'lm-c-20', externalId: 'legiscan:2129983', userId: 'lm-user-out',
    content: '<p>Happy to get this in front of the PTA coalition once it has a committee date.</p>', daysAgo: 5 },
  { id: 'lm-c-21', externalId: 'legiscan:2129983', userId: 'lm-user-data',
    content: "<p>About 40% of Michigan school buildings pre-date 1986 plumbing codes, for what it's worth.</p>", daysAgo: 3 },
]

const hb5674Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-7', commentId: 'lm-c-19', userId: 'demo-user', emoji: '👍', daysAgo: 4 },
  { id: 'lm-r-8', commentId: 'lm-c-21', userId: 'lm-user-comms', emoji: '🤔', daysAgo: 2 },
]

// ---------------------------------------------------------------------------
// MI HB4768 — legiscan:2041788 (microplastics testing)
// ---------------------------------------------------------------------------
const hb4768: DemoSeedComment[] = [
  { id: 'lm-c-22', externalId: 'legiscan:2041788', userId: 'lm-user-la1',
    content: "<p>Natural Resources and Tourism hasn't touched this since referral. No hearing scheduled yet.</p>", daysAgo: 184 },
  { id: 'lm-c-23', externalId: 'legiscan:2041788', userId: 'lm-user-res',
    content: "<p>Microplastics testing keeps getting introduced and rarely moves. I'd check back each session.</p>", daysAgo: 134 },
  { id: 'lm-c-24', externalId: 'legiscan:2041788', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-mi" data-label="Michigan Team">@Michigan Team</span> should we keep pushing this one, or let it sit at low priority?</p>', daysAgo: 4 },
  { id: 'lm-c-25', externalId: 'legiscan:2041788', userId: 'lm-user-la1',
    content: "<p>Let it sit. Nothing's moved in a year.</p>", daysAgo: 3 },
]

const hb4768Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-9', commentId: 'lm-c-25', userId: 'lm-user-comms', emoji: '🤔', daysAgo: 2 },
]

// demo-user is the third Michigan Team member but also wrote lm-c-24, so no row
// is emitted for them — api/src/lib/mentions.ts filters the author out of a role
// fan-out, and a self-mention row would light the demo visitor's own bell.
const hb4768Mentions: DemoSeedMention[] = [
  { id: 'lm-m-13', commentId: 'lm-c-24', userId: 'lm-user-la1', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 4 },
  { id: 'lm-m-14', commentId: 'lm-c-24', userId: 'lm-user-comms', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 4 },
]

// ---------------------------------------------------------------------------
// WI SB56 — legiscan:1979645 (lead service line funding — enacted)
// ---------------------------------------------------------------------------
const sb56: DemoSeedComment[] = [
  { id: 'lm-c-26', externalId: 'legiscan:1979645', userId: 'lm-user-la2',
    content: '<p>Signed. 2025 Wisconsin Act 8—federal capitalization grant funds can now go to lead service line replacement.</p>', daysAgo: 405 },
  { id: 'lm-c-27', externalId: 'legiscan:1979645', userId: 'lm-user-ed',
    content: '<p>Great outcome. This is the kind of win that justifies the whole Wisconsin program.</p>', daysAgo: 405 },
  { id: 'lm-c-28', externalId: 'legiscan:1979645', userId: 'lm-user-grants',
    content: "<p>Utilities can start applying for capitalization grant funds now. I'll flag this to our municipal partners.</p>", daysAgo: 400 },
]

// 🔥 is reserved for the two enacted-bill announcements a colleague would actually
// mark as a win (here and lm-c-29), which is also where a second and third person
// pile onto the same emoji.
const sb56Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-10', commentId: 'lm-c-26', userId: 'demo-user', emoji: '👍', daysAgo: 405 },
  { id: 'lm-r-42', commentId: 'lm-c-26', userId: 'lm-user-ed', emoji: '🔥', daysAgo: 405 },
  { id: 'lm-r-43', commentId: 'lm-c-26', userId: 'lm-user-grants', emoji: '🔥', daysAgo: 404 },
  { id: 'lm-r-11', commentId: 'lm-c-27', userId: 'lm-user-dep', emoji: '👍', daysAgo: 404 },
  { id: 'lm-r-12', commentId: 'lm-c-27', userId: 'lm-user-wq', emoji: '👍', daysAgo: 403 },
]

const sb56Votes: DemoSeed['votes'] = [
  { id: 'lm-v-13', externalId: 'legiscan:1979645', userId: 'lm-user-la2', position: 'support', daysAgo: 400 },
  { id: 'lm-v-14', externalId: 'legiscan:1979645', userId: 'lm-user-wq', position: 'support', daysAgo: 399 },
  { id: 'lm-v-16', externalId: 'legiscan:1979645', userId: 'lm-user-ed', position: 'support', daysAgo: 397 },
  { id: 'lm-v-17', externalId: 'legiscan:1979645', userId: 'lm-user-dep', position: 'support', daysAgo: 396 },
  { id: 'lm-v-18', externalId: 'legiscan:1979645', userId: 'demo-user', position: 'support', daysAgo: 395 },
]

// ---------------------------------------------------------------------------
// WI AB131 — legiscan:2006749 (PFAS programs — enacted)
// ---------------------------------------------------------------------------
const ab131: DemoSeedComment[] = [
  { id: 'lm-c-29', externalId: 'legiscan:2006749', userId: 'lm-user-wq',
    content: '<p>Signed into law as 2026 Wisconsin Act 201. Strongest PFAS framework we track at the state level.</p>', daysAgo: 127 },
  { id: 'lm-c-30', externalId: 'legiscan:2006749', userId: 'lm-user-gc',
    content: "<p>Curious how much of this gets left to rulemaking. The agency's implementation timeline is the thing to watch.</p>", daysAgo: 127 },
  { id: 'lm-c-31', externalId: 'legiscan:2006749', userId: 'lm-user-data',
    content: '<p>Pulling together a one-pager on what the testing requirements actually cover for the newsletter.</p>', daysAgo: 120 },
  { id: 'lm-c-32', externalId: 'legiscan:2006749', userId: 'lm-user-comms',
    content: '<p><span data-type="mention" data-id="role:lm-role-wi" data-label="Wisconsin Team">@Wisconsin Team</span> can one of you review the one-pager before it goes out Friday?</p>', daysAgo: 118 },
  { id: 'lm-c-33', externalId: 'legiscan:2006749', userId: 'lm-user-la2',
    content: '<p>On it. Will have comments back by Thursday.</p>', daysAgo: 117 },
]

const ab131Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-13', commentId: 'lm-c-29', userId: 'demo-user', emoji: '👍', daysAgo: 127 },
  { id: 'lm-r-44', commentId: 'lm-c-29', userId: 'lm-user-la2', emoji: '🔥', daysAgo: 127 },
  { id: 'lm-r-45', commentId: 'lm-c-29', userId: 'lm-user-ed', emoji: '🔥', daysAgo: 126 },
  { id: 'lm-r-14', commentId: 'lm-c-32', userId: 'lm-user-wq', emoji: '👍', daysAgo: 117 },
]

const ab131Mentions: DemoSeedMention[] = [
  { id: 'lm-m-15', commentId: 'lm-c-32', userId: 'lm-user-la2', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 118 },
  { id: 'lm-m-16', commentId: 'lm-c-32', userId: 'lm-user-wq', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 118 },
  { id: 'lm-m-17', commentId: 'lm-c-32', userId: 'lm-user-data', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 118 },
]

const ab131Votes: DemoSeed['votes'] = [
  { id: 'lm-v-19', externalId: 'legiscan:2006749', userId: 'lm-user-la2', position: 'support', daysAgo: 115 },
  { id: 'lm-v-20', externalId: 'legiscan:2006749', userId: 'lm-user-wq', position: 'support', daysAgo: 114 },
  { id: 'lm-v-22', externalId: 'legiscan:2006749', userId: 'lm-user-gc', position: 'neutral', daysAgo: 112 },
  { id: 'lm-v-23', externalId: 'legiscan:2006749', userId: 'lm-user-ed', position: 'support', daysAgo: 111 },
]

// ---------------------------------------------------------------------------
// WI AB129 — legiscan:2006944 (safe drinking water in schools — died via SJR 1)
// ---------------------------------------------------------------------------
const ab129: DemoSeedComment[] = [
  { id: 'lm-c-34', externalId: 'legiscan:2006944', userId: 'demo-user',
    content: '<p>This one died at the deadline. A full year in committee and it never got a floor vote.</p>', daysAgo: 140 },
  { id: 'lm-c-35', externalId: 'legiscan:2006944', userId: 'lm-user-la2',
    content: '<p><span data-type="mention" data-id="role:lm-role-wi" data-label="Wisconsin Team">@Wisconsin Team</span> worth another run in January? Testing lead in schools polls well everywhere.</p>', daysAgo: 140 },
  { id: 'lm-c-36', externalId: 'legiscan:2006944', userId: 'lm-user-gov',
    content: '<p>Yes. Adding it to the reintroduction list.</p>', daysAgo: 139 },
  { id: 'lm-c-37', externalId: 'legiscan:2006944', userId: 'lm-user-ed',
    content: "<p>Frustrating, but not surprising given how late in session it landed. January's the right call.</p>", daysAgo: 135 },
]

// 😭 carries the two bill deaths (here and lm-c-38) — negative signal aimed at
// the outcome, which is what makes it usable where 👎 is not: on a comment, a
// thumbs-down reads as disagreeing with the colleague who reported the death
// rather than with the death. That leaves 🤔 a single meaning, "watching this".
const ab129Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-15', commentId: 'lm-c-34', userId: 'lm-user-dep', emoji: '😭', daysAgo: 140 },
  { id: 'lm-r-47', commentId: 'lm-c-34', userId: 'lm-user-la2', emoji: '😭', daysAgo: 140 },
  { id: 'lm-r-48', commentId: 'lm-c-34', userId: 'lm-user-wq', emoji: '😭', daysAgo: 139 },
  { id: 'lm-r-16', commentId: 'lm-c-36', userId: 'lm-user-la2', emoji: '👍', daysAgo: 138 },
]

// lm-user-la2 wrote lm-c-35, so the Wisconsin Team fan-out skips them — see the
// note on hb4768Mentions above.
const ab129Mentions: DemoSeedMention[] = [
  { id: 'lm-m-19', commentId: 'lm-c-35', userId: 'lm-user-wq', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 140 },
  { id: 'lm-m-20', commentId: 'lm-c-35', userId: 'lm-user-data', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 140 },
]

const ab129Votes: DemoSeed['votes'] = [
  { id: 'lm-v-24', externalId: 'legiscan:2006944', userId: 'lm-user-la2', position: 'support', daysAgo: 130 },
  { id: 'lm-v-25', externalId: 'legiscan:2006944', userId: 'lm-user-wq', position: 'support', daysAgo: 128 },
]

// ---------------------------------------------------------------------------
// WI SB628 — legiscan:2052600 (groundwater exceedance notification — died via SJR 1)
// ---------------------------------------------------------------------------
const sb628: DemoSeedComment[] = [
  { id: 'lm-c-38', externalId: 'legiscan:2052600', userId: 'lm-user-la2',
    content: '<p>This one died too. Committee had it 4 to 1 in February and it never got scheduled.</p>', daysAgo: 141 },
  { id: 'lm-c-39', externalId: 'legiscan:2052600', userId: 'lm-user-wq',
    content: '<p>Low priority for us anyway, but the notification requirement was a good idea. Someone will bring it back.</p>', daysAgo: 141 },
  { id: 'lm-c-40', externalId: 'legiscan:2052600', userId: 'demo-user',
    content: '<p>Not chasing this one in January. Bigger fights ahead. Leaving it here for now.</p>', daysAgo: 130 },
]

const sb628Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-17', commentId: 'lm-c-38', userId: 'lm-user-data', emoji: '😭', daysAgo: 140 },
  { id: 'lm-r-49', commentId: 'lm-c-38', userId: 'lm-user-gov', emoji: '😭', daysAgo: 141 },
]

// ---------------------------------------------------------------------------
// IL HB1175 — legiscan:1906052 (Great Lakes coal-ash protection, live)
// ---------------------------------------------------------------------------
const ilHb1175: DemoSeedComment[] = [
  // No countdown in the prose: the hearing's date and this comment's date both
  // slide with the demo reset, so any "in N weeks" phrasing is wrong after every reset.
  { id: 'lm-c-41', externalId: 'legiscan:1906052', userId: 'lm-user-dep',
    content: '<p>Energy and Environment hearing notice just landed. Time to lock in our written testimony.</p>', daysAgo: 15 },
  { id: 'lm-c-42', externalId: 'legiscan:1906052', userId: 'lm-user-gc',
    content: '<p>Checking whether the coal ash language tracks the federal rule or goes further. Should know in a day or two.</p>', daysAgo: 14 },
  { id: 'lm-c-43', externalId: 'legiscan:1906052', userId: 'lm-user-gov',
    content: "<p>Utility lobbyists are already working the committee. We shouldn't wait for the hearing to make our case.</p>", daysAgo: 13 },
  { id: 'lm-c-44', externalId: 'legiscan:1906052', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-il" data-label="Illinois Team">@Illinois Team</span> can we get a one-pager on the coal ash sites near the lake before the hearing?</p>', daysAgo: 13 },
  { id: 'lm-c-45', externalId: 'legiscan:1906052', userId: 'lm-user-dep',
    content: "<p>Taking that. I'll start from our shoreline survey and add the discharge permits for each site.</p>", daysAgo: 12 },
]

// The third stacked pill, on the newest Illinois card: three people on 👍.
const ilHb1175Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-18', commentId: 'lm-c-43', userId: 'demo-user', emoji: '👍', daysAgo: 13 },
  { id: 'lm-r-19', commentId: 'lm-c-45', userId: 'lm-user-gov', emoji: '👍', daysAgo: 12 },
  { id: 'lm-r-40', commentId: 'lm-c-45', userId: 'demo-user', emoji: '👍', daysAgo: 12 },
  { id: 'lm-r-41', commentId: 'lm-c-45', userId: 'lm-user-gc', emoji: '👍', daysAgo: 11 },
]

const ilHb1175Mentions: DemoSeedMention[] = [
  { id: 'lm-m-21', commentId: 'lm-c-44', userId: 'lm-user-dep', sourceType: 'role', sourceId: 'lm-role-il', daysAgo: 13 },
  { id: 'lm-m-22', commentId: 'lm-c-44', userId: 'lm-user-gov', sourceType: 'role', sourceId: 'lm-role-il', daysAgo: 13 },
  { id: 'lm-m-23', commentId: 'lm-c-44', userId: 'lm-user-gc', sourceType: 'role', sourceId: 'lm-role-il', daysAgo: 13 },
]

const ilHb1175Votes: DemoSeed['votes'] = [
  { id: 'lm-v-27', externalId: 'legiscan:1906052', userId: 'demo-user', position: 'support', daysAgo: 310 },
  { id: 'lm-v-28', externalId: 'legiscan:1906052', userId: 'lm-user-dep', position: 'support', daysAgo: 309 },
  { id: 'lm-v-29', externalId: 'legiscan:1906052', userId: 'lm-user-gov', position: 'support', daysAgo: 308 },
  { id: 'lm-v-30', externalId: 'legiscan:1906052', userId: 'lm-user-gc', position: 'neutral', daysAgo: 307 },
  { id: 'lm-v-31', externalId: 'legiscan:1906052', userId: 'lm-user-comms', position: 'support', daysAgo: 306 },
]

// ---------------------------------------------------------------------------
// IL SB4025 — legiscan:2111275 (lead service line replacement, enacted)
// ---------------------------------------------------------------------------
const ilSb4025: DemoSeedComment[] = [
  { id: 'lm-c-46', externalId: 'legiscan:2111275', userId: 'lm-user-dep',
    content: '<p>Signed as Public Act 104-0572. Biggest lead line commitment Illinois has made yet.</p>', daysAgo: 30 },
  { id: 'lm-c-47', externalId: 'legiscan:2111275', userId: 'lm-user-gc',
    content: '<p>Odd detail: the compliance timeline runs ahead of the federal lead pipe rule. Pulling the text to be sure.</p>', daysAgo: 30 },
  { id: 'lm-c-48', externalId: 'legiscan:2111275', userId: 'lm-user-grants',
    content: "<p>Money is the easy part. Most of our municipal partners don't have crews to replace lines this fast.</p>", daysAgo: 20 },
  { id: 'lm-c-49', externalId: 'legiscan:2111275', userId: 'demo-user',
    content: '<p>Good template for other Great Lakes states still working on lead line funding. Worth sharing with Michigan and Indiana.</p>', daysAgo: 10 },
]

const ilSb4025Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-20', commentId: 'lm-c-46', userId: 'demo-user', emoji: '👍', daysAgo: 30 },
  { id: 'lm-r-46', commentId: 'lm-c-46', userId: 'lm-user-gov', emoji: '🔥', daysAgo: 30 },
  { id: 'lm-r-21', commentId: 'lm-c-47', userId: 'lm-user-dep', emoji: '👍', daysAgo: 29 },
]

const ilSb4025Votes: DemoSeed['votes'] = [
  { id: 'lm-v-32', externalId: 'legiscan:2111275', userId: 'demo-user', position: 'support', daysAgo: 25 },
  { id: 'lm-v-33', externalId: 'legiscan:2111275', userId: 'lm-user-dep', position: 'support', daysAgo: 24 },
  { id: 'lm-v-34', externalId: 'legiscan:2111275', userId: 'lm-user-gov', position: 'support', daysAgo: 23 },
  { id: 'lm-v-35', externalId: 'legiscan:2111275', userId: 'lm-user-gc', position: 'support', daysAgo: 22 },
]

// ---------------------------------------------------------------------------
// IL HB5268 — legiscan:2109237 (Lake Michigan water sale, live)
// ---------------------------------------------------------------------------
const ilHb5268: DemoSeedComment[] = [
  { id: 'lm-c-50', externalId: 'legiscan:2109237', userId: 'lm-user-dep',
    content: "<p>Re-referred to Rules three times this session already. Not sure this one's going anywhere.</p>", daysAgo: 90 },
  { id: 'lm-c-51', externalId: 'legiscan:2109237', userId: 'lm-user-gov',
    content: '<p>Water sale bills like this tend to die quietly in Rules. Keeping it on the watch list, not the priority list.</p>', daysAgo: 85 },
  { id: 'lm-c-52', externalId: 'legiscan:2109237', userId: 'lm-user-gc',
    content: "<p>No position needed yet—nothing in the amendment changes the interstate compact question we'd care about.</p>", daysAgo: 80 },
  // The reason behind the oppose votes below.
  { id: 'lm-c-90', externalId: 'legiscan:2109237', userId: 'lm-user-dep',
    content: "<p>Voting no. Even a narrow sale sets a diversion precedent under the compact, and we can't walk that back.</p>", daysAgo: 87 },
  { id: 'lm-c-53', externalId: 'legiscan:2109237', userId: 'demo-user',
    content: '<p>Still stuck in Rules. Checking back next month.</p>', daysAgo: 6 },
]

const ilHb5268Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-22', commentId: 'lm-c-50', userId: 'lm-user-gc', emoji: '🤔', daysAgo: 89 },
]

// The one bill in the set the members voted against. Paul (General Counsel) stays
// neutral, matching lm-c-52 — he sees nothing in the amendment that changes the
// compact question, so there is nothing for him to oppose yet.
const ilHb5268Votes: DemoSeed['votes'] = [
  { id: 'lm-v-68', externalId: 'legiscan:2109237', userId: 'demo-user', position: 'oppose', daysAgo: 88 },
  { id: 'lm-v-69', externalId: 'legiscan:2109237', userId: 'lm-user-dep', position: 'oppose', daysAgo: 87 },
  { id: 'lm-v-70', externalId: 'legiscan:2109237', userId: 'lm-user-gov', position: 'oppose', daysAgo: 86 },
  { id: 'lm-v-71', externalId: 'legiscan:2109237', userId: 'lm-user-gc', position: 'neutral', daysAgo: 85 },
]

// ---------------------------------------------------------------------------
// IL HB2516 — legiscan:1952725 (PFAS product ban, enacted)
// ---------------------------------------------------------------------------
const ilHb2516: DemoSeedComment[] = [
  // Effective 2025-08-15; this comment is dated 45 days before the 2026-08-11
  // reset, so the act was ten months old when it was written, not a year.
  { id: 'lm-c-54', externalId: 'legiscan:1952725', userId: 'lm-user-dep',
    content: "<p>Public Act 104-0231 has been in effect since last August. Let's pull compliance rates for the newsletter.</p>", daysAgo: 45 },
  { id: 'lm-c-55', externalId: 'legiscan:1952725', userId: 'lm-user-gc',
    content: '<p>The product categories covered are broader than I remembered. Pulling the list for our PFAS working group.</p>', daysAgo: 45 },
  { id: 'lm-c-56', externalId: 'legiscan:1952725', userId: 'lm-user-comms',
    content: '<p><span data-type="mention" data-id="role:lm-role-contam" data-label="Contaminants">@Contaminants</span> can someone confirm which retailers have flagged compliance issues?</p>', daysAgo: 40 },
  { id: 'lm-c-57', externalId: 'legiscan:1952725', userId: 'lm-user-wq',
    content: '<p><span data-type="mention" data-id="user:lm-user-comms" data-label="Renee Rains">@Renee Rains</span> two came up on our compliance calls. Let me confirm with the state first.</p>', daysAgo: 38 },
]

const ilHb2516Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-23', commentId: 'lm-c-54', userId: 'demo-user', emoji: '👍', daysAgo: 45 },
]

const ilHb2516Mentions: DemoSeedMention[] = [
  { id: 'lm-m-24', commentId: 'lm-c-56', userId: 'lm-user-dep', sourceType: 'role', sourceId: 'lm-role-contam', daysAgo: 40 },
  { id: 'lm-m-25', commentId: 'lm-c-56', userId: 'lm-user-la1', sourceType: 'role', sourceId: 'lm-role-contam', daysAgo: 40 },
  { id: 'lm-m-26', commentId: 'lm-c-56', userId: 'lm-user-wq', sourceType: 'role', sourceId: 'lm-role-contam', daysAgo: 40 },
  // Trevor answering Renee's @Contaminants ask by name.
  { id: 'lm-m-37', commentId: 'lm-c-57', userId: 'lm-user-comms', sourceType: 'user', sourceId: 'lm-user-comms', daysAgo: 38 },
]

const ilHb2516Votes: DemoSeed['votes'] = [
  { id: 'lm-v-37', externalId: 'legiscan:1952725', userId: 'demo-user', position: 'support', daysAgo: 40 },
  { id: 'lm-v-38', externalId: 'legiscan:1952725', userId: 'lm-user-dep', position: 'support', daysAgo: 39 },
  { id: 'lm-v-39', externalId: 'legiscan:1952725', userId: 'lm-user-wq', position: 'support', daysAgo: 38 },
  { id: 'lm-v-40', externalId: 'legiscan:1952725', userId: 'lm-user-gc', position: 'support', daysAgo: 37 },
]

// ---------------------------------------------------------------------------
// IN HB1124 — legiscan:2061476 (lead testing in school drinking water, live)
// ---------------------------------------------------------------------------
const inHb1124: DemoSeedComment[] = [
  { id: 'lm-c-58', externalId: 'legiscan:2061476', userId: 'lm-user-res',
    content: '<p>Public Health Committee hearing is set. Good bill to push hard on early.</p>', daysAgo: 5 },
  { id: 'lm-c-59', externalId: 'legiscan:2061476', userId: 'lm-user-prog',
    content: '<p><span data-type="mention" data-id="user:lm-user-res" data-label="Grace Jiang">@Grace Jiang</span> I can line up two district facilities managers to testify. Reaching out today.</p>', daysAgo: 4 },
  { id: 'lm-c-60', externalId: 'legiscan:2061476', userId: 'lm-user-out',
    content: '<p>PTA coalition is already asking about this one. Happy to get them a fact sheet before the hearing.</p>', daysAgo: 3 },
  // Deliberately not the MI HB4427 beat again (lm-c-4/lm-c-5, "can someone cover
  // the hearing in person?" → "I've got it"). Those two threads sit within one
  // screen of each other, so this one is a calendar collision resolved by someone
  // who happens to already be in the city.
  { id: 'lm-c-61', externalId: 'legiscan:2061476', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-in" data-label="Indiana Team">@Indiana Team</span> the hearing collides with our budget call. Who can be in Indianapolis?</p>', daysAgo: 3 },
  { id: 'lm-c-62', externalId: 'legiscan:2061476', userId: 'lm-user-res',
    content: "<p>I'm in the city that morning for a school district meeting, so I can take the room.</p>", daysAgo: 2 },
]

const inHb1124Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-24', commentId: 'lm-c-59', userId: 'demo-user', emoji: '👍', daysAgo: 4 },
  { id: 'lm-r-25', commentId: 'lm-c-62', userId: 'lm-user-prog', emoji: '👍', daysAgo: 2 },
]

const inHb1124Mentions: DemoSeedMention[] = [
  // Miguel looping Grace in by name before the role fan-out below.
  { id: 'lm-m-38', commentId: 'lm-c-59', userId: 'lm-user-res', sourceType: 'user', sourceId: 'lm-user-res', daysAgo: 4 },
  { id: 'lm-m-27', commentId: 'lm-c-61', userId: 'lm-user-res', sourceType: 'role', sourceId: 'lm-role-in', daysAgo: 3 },
  { id: 'lm-m-28', commentId: 'lm-c-61', userId: 'lm-user-prog', sourceType: 'role', sourceId: 'lm-role-in', daysAgo: 3 },
  { id: 'lm-m-29', commentId: 'lm-c-61', userId: 'lm-user-out', sourceType: 'role', sourceId: 'lm-role-in', daysAgo: 3 },
]

const inHb1124Votes: DemoSeed['votes'] = [
  { id: 'lm-v-41', externalId: 'legiscan:2061476', userId: 'demo-user', position: 'support', daysAgo: 200 },
  { id: 'lm-v-42', externalId: 'legiscan:2061476', userId: 'lm-user-res', position: 'support', daysAgo: 199 },
  { id: 'lm-v-44', externalId: 'legiscan:2061476', userId: 'lm-user-ed', position: 'support', daysAgo: 197 },
  { id: 'lm-v-45', externalId: 'legiscan:2061476', userId: 'lm-user-comms', position: 'support', daysAgo: 196 },
]

// ---------------------------------------------------------------------------
// IN SB0006 — legiscan:2056216 (water/wastewater main extension, enacted)
// ---------------------------------------------------------------------------
const inSb0006: DemoSeedComment[] = [
  { id: 'lm-c-63', externalId: 'legiscan:2056216', userId: 'lm-user-res',
    content: "<p>Signed as Public Law 65. Smaller bill, but it clears up who pays for main extensions to new developments.</p>", daysAgo: 80 },
  { id: 'lm-c-64', externalId: 'legiscan:2056216', userId: 'lm-user-prog',
    content: "<p>Good for our rural utility partners. They've been asking about this cost question for years.</p>", daysAgo: 80 },
  { id: 'lm-c-65', externalId: 'legiscan:2056216', userId: 'lm-user-out',
    content: '<p>Passing this along to the county coalition newsletter.</p>', daysAgo: 75 },
  { id: 'lm-c-66', externalId: 'legiscan:2056216', userId: 'demo-user',
    content: '<p>Two counties have asked who pays when an extension crosses a township line.</p>', daysAgo: 30 },
]

const inSb0006Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-26', commentId: 'lm-c-63', userId: 'demo-user', emoji: '👍', daysAgo: 80 },
  { id: 'lm-r-27', commentId: 'lm-c-64', userId: 'lm-user-ed', emoji: '👍', daysAgo: 79 },
]

const inSb0006Votes: DemoSeed['votes'] = [
  { id: 'lm-v-46', externalId: 'legiscan:2056216', userId: 'demo-user', position: 'support', daysAgo: 70 },
  { id: 'lm-v-47', externalId: 'legiscan:2056216', userId: 'lm-user-res', position: 'support', daysAgo: 69 },
  { id: 'lm-v-48', externalId: 'legiscan:2056216', userId: 'lm-user-ed', position: 'support', daysAgo: 68 },
]

// ---------------------------------------------------------------------------
// IN SB0188 — legiscan:2065860 (parking at Lake Michigan beaches, withdrawn)
// ---------------------------------------------------------------------------
const inSb0188: DemoSeedComment[] = [
  { id: 'lm-c-67', externalId: 'legiscan:2065860', userId: 'lm-user-out',
    content: "<p>Huh, this one's gone. Withdrawn less than a week after it was filed.</p>", daysAgo: 211 },
  { id: 'lm-c-68', externalId: 'legiscan:2065860', userId: 'lm-user-res',
    content: "<p>Parking fights at the beach are usually local anyway. Not surprised it didn't have legs at the statehouse.</p>", daysAgo: 211 },
  { id: 'lm-c-69', externalId: 'legiscan:2065860', userId: 'demo-user',
    content: '<p>Low priority, so no loss. Leaving it here in case it comes back.</p>', daysAgo: 210 },
  { id: 'lm-c-70', externalId: 'legiscan:2065860', userId: 'lm-user-prog',
    content: '<p>Somebody should find out why it was pulled. If the fee cap was the problem, it comes back next session.</p>', daysAgo: 205 },
]

const inSb0188Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-28', commentId: 'lm-c-67', userId: 'lm-user-prog', emoji: '🤔', daysAgo: 211 },
]

// ---------------------------------------------------------------------------
// US HB284 — legiscan:1910159 (GLRI Act of 2025, live)
// ---------------------------------------------------------------------------
const usHb284: DemoSeedComment[] = [
  { id: 'lm-c-71', externalId: 'legiscan:1910159', userId: 'lm-user-fed',
    content: '<p>GLRI funding is the whole ballgame for us. If this stalls, three of our restoration projects stall with it.</p>', daysAgo: 8 },
  { id: 'lm-c-72', externalId: 'legiscan:1910159', userId: 'lm-user-grants',
    content: '<p>Appropriations season is coming up fast. We should get letters in before the subcommittee marks up anything else.</p>', daysAgo: 7 },
  { id: 'lm-c-73', externalId: 'legiscan:1910159', userId: 'lm-user-ed',
    content: '<p>This has been parked in the Water Resources and Environment Subcommittee since January 2025.</p>', daysAgo: 6 },
  { id: 'lm-c-74', externalId: 'legiscan:1910159', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-us" data-label="Federal Team">@Federal Team</span> any read on when this moves, or are we just watching the appropriations bill instead?</p>', daysAgo: 6 },
  { id: 'lm-c-75', externalId: 'legiscan:1910159', userId: 'lm-user-fed',
    content: '<p>Watching the appropriations bill for now. GLRI funding levels usually move there before this bill ever gets a vote.</p>', daysAgo: 5 },
]

const usHb284Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-29', commentId: 'lm-c-71', userId: 'demo-user', emoji: '👍', daysAgo: 8 },
  { id: 'lm-r-30', commentId: 'lm-c-73', userId: 'lm-user-grants', emoji: '🤔', daysAgo: 6 },
]

const usHb284Mentions: DemoSeedMention[] = [
  { id: 'lm-m-30', commentId: 'lm-c-74', userId: 'lm-user-ed', sourceType: 'role', sourceId: 'lm-role-us', daysAgo: 6 },
  { id: 'lm-m-31', commentId: 'lm-c-74', userId: 'lm-user-fed', sourceType: 'role', sourceId: 'lm-role-us', daysAgo: 6 },
  { id: 'lm-m-32', commentId: 'lm-c-74', userId: 'lm-user-grants', sourceType: 'role', sourceId: 'lm-role-us', daysAgo: 6 },
]

const usHb284Votes: DemoSeed['votes'] = [
  { id: 'lm-v-50', externalId: 'legiscan:1910159', userId: 'demo-user', position: 'support', daysAgo: 500 },
  { id: 'lm-v-51', externalId: 'legiscan:1910159', userId: 'lm-user-ed', position: 'support', daysAgo: 499 },
  { id: 'lm-v-52', externalId: 'legiscan:1910159', userId: 'lm-user-fed', position: 'support', daysAgo: 498 },
  { id: 'lm-v-54', externalId: 'legiscan:1910159', userId: 'lm-user-dep', position: 'support', daysAgo: 496 },
]

// ---------------------------------------------------------------------------
// US HB8876 — legiscan:2150744 (Aquatic Invasive Species Control and
// Prevention Act of 2026, live)
// ---------------------------------------------------------------------------
// Thread order tracks the hearing notice, which fires at daysAgo 5: lm-c-76 (day 6)
// predates it and so cannot know about a next hearing, and lm-c-80 (day 4) is the
// reaction to it.
const usHb8876: DemoSeedComment[] = [
  { id: 'lm-c-76', externalId: 'legiscan:2150744', userId: 'lm-user-fed',
    content: '<p>Subcommittee held its first hearing on this last month. No word yet on whether they take it up again.</p>', daysAgo: 6 },
  { id: 'lm-c-77', externalId: 'legiscan:2150744', userId: 'lm-user-res',
    content: "<p>Invasive mussel data from Michigan would be useful testimony material here too. I'll pull the numbers.</p>", daysAgo: 5 },
  { id: 'lm-c-78', externalId: 'legiscan:2150744', userId: 'lm-user-ed',
    content: '<p>We filed an amend position on this one—good bill, but the enforcement funding needs to scale with the mandate.</p>', daysAgo: 4 },
  { id: 'lm-c-80', externalId: 'legiscan:2150744', userId: 'lm-user-fed',
    content: '<p>Hearing notice for the next one just went out. Marking the calendar.</p>', daysAgo: 4 },
  { id: 'lm-c-79', externalId: 'legiscan:2150744', userId: 'demo-user',
    content: "<p>Good sign that this got a bipartisan sponsor pair. Walberg and Elfreth don't often co-sponsor the same bill.</p>", daysAgo: 3 },
]

const usHb8876Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-31', commentId: 'lm-c-77', userId: 'lm-user-ed', emoji: '👍', daysAgo: 5 },
  { id: 'lm-r-32', commentId: 'lm-c-79', userId: 'lm-user-fed', emoji: '👍', daysAgo: 3 },
]

const usHb8876Votes: DemoSeed['votes'] = [
  { id: 'lm-v-55', externalId: 'legiscan:2150744', userId: 'demo-user', position: 'support', daysAgo: 50 },
  { id: 'lm-v-56', externalId: 'legiscan:2150744', userId: 'lm-user-ed', position: 'support', daysAgo: 49 },
  { id: 'lm-v-57', externalId: 'legiscan:2150744', userId: 'lm-user-fed', position: 'support', daysAgo: 48 },
  { id: 'lm-v-58', externalId: 'legiscan:2150744', userId: 'lm-user-res', position: 'support', daysAgo: 47 },
  { id: 'lm-v-59', externalId: 'legiscan:2150744', userId: 'lm-user-gc', position: 'neutral', daysAgo: 46 },
]

// ---------------------------------------------------------------------------
// US HB583 — legiscan:1933798 (BEACH Act of 2025, live)
// ---------------------------------------------------------------------------
const usHb583: DemoSeedComment[] = [
  { id: 'lm-c-81', externalId: 'legiscan:1933798', userId: 'lm-user-fed',
    content: '<p>BEACH Act funding is what keeps our beach monitoring grants alive. Worth a check-in with the subcommittee staff.</p>', daysAgo: 60 },
  { id: 'lm-c-82', externalId: 'legiscan:1933798', userId: 'lm-user-grants',
    content: '<p>If this moves, it would restore same-day notification funding that lapsed two cycles ago.</p>', daysAgo: 55 },
  { id: 'lm-c-83', externalId: 'legiscan:1933798', userId: 'lm-user-wq',
    content: '<p>Same-day beach notification is the single biggest ask we hear from the public. Would love to see this move.</p>', daysAgo: 50 },
  { id: 'lm-c-84', externalId: 'legiscan:1933798', userId: 'demo-user',
    content: '<p>Nothing has moved on this since the January 2025 subcommittee referral.</p>', daysAgo: 45 },
]

const usHb583Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-33', commentId: 'lm-c-83', userId: 'demo-user', emoji: '👍', daysAgo: 50 },
]

const usHb583Votes: DemoSeed['votes'] = [
  { id: 'lm-v-60', externalId: 'legiscan:1933798', userId: 'demo-user', position: 'support', daysAgo: 40 },
  { id: 'lm-v-61', externalId: 'legiscan:1933798', userId: 'lm-user-fed', position: 'support', daysAgo: 39 },
  { id: 'lm-v-62', externalId: 'legiscan:1933798', userId: 'lm-user-wq', position: 'support', daysAgo: 38 },
]

// ---------------------------------------------------------------------------
// US HB6668 — legiscan:2058690 (Clean Water Standards for PFAS Act, live)
// ---------------------------------------------------------------------------
const usHb6668: DemoSeedComment[] = [
  { id: 'lm-c-85', externalId: 'legiscan:2058690', userId: 'lm-user-fed',
    content: '<p>Bipartisan sponsor pair again—Pappas and Fitzpatrick. PFAS seems to be one of the few things that still gets that.</p>', daysAgo: 19 },
  { id: 'lm-c-86', externalId: 'legiscan:2058690', userId: 'lm-user-wq',
    content: '<p>Federal PFAS drinking water standards would finally give us a floor to point to in Michigan and Wisconsin fights too.</p>', daysAgo: 14 },
  { id: 'lm-c-87', externalId: 'legiscan:2058690', userId: 'lm-user-gc',
    content: "<p>Some of this may already be covered by the EPA's own PFAS rule. If so, part of the bill is redundant.</p>", daysAgo: 9 },
  { id: 'lm-c-88', externalId: 'legiscan:2058690', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-contam" data-label="Contaminants">@Contaminants</span> can you sort out how this interacts with the EPA\'s existing PFAS rule before we take a position?</p>', daysAgo: 4 },
]

const usHb6668Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-34', commentId: 'lm-c-86', userId: 'lm-user-fed', emoji: '🤔', daysAgo: 14 },
]

const usHb6668Mentions: DemoSeedMention[] = [
  { id: 'lm-m-33', commentId: 'lm-c-88', userId: 'lm-user-dep', sourceType: 'role', sourceId: 'lm-role-contam', daysAgo: 4 },
  { id: 'lm-m-34', commentId: 'lm-c-88', userId: 'lm-user-la1', sourceType: 'role', sourceId: 'lm-role-contam', daysAgo: 4 },
  { id: 'lm-m-35', commentId: 'lm-c-88', userId: 'lm-user-wq', sourceType: 'role', sourceId: 'lm-role-contam', daysAgo: 4 },
]

const usHb6668Votes: DemoSeed['votes'] = [
  { id: 'lm-v-63', externalId: 'legiscan:2058690', userId: 'demo-user', position: 'support', daysAgo: 1 },
  { id: 'lm-v-64', externalId: 'legiscan:2058690', userId: 'lm-user-wq', position: 'support', daysAgo: 1 },
  { id: 'lm-v-65', externalId: 'legiscan:2058690', userId: 'lm-user-fed', position: 'support', daysAgo: 1 },
]

// ---------------------------------------------------------------------------
// Combined exports
// ---------------------------------------------------------------------------
// Hearing coordination, deliberately not status narration.
//
// A comment about who is covering a hearing demonstrates what the product is
// for — a team dividing work — and stays true no matter what the bill does next.
// A comment about where the bill has got to duplicates the feed and the actions
// tab, and goes stale the moment either moves. That distinction is why the three
// replies added on 2026-08-12 were removed: each narrated an invented procedural
// step, and one contradicted its bill outright.
//
// Each sits a day after the hearing notice it answers (lm-fe-h-mi-hb5308 at
// daysAgo 4, lm-fe-h-mi-hb5674 at 3), so the feed reads notice-then-response.
const hearingCoordination: DemoSeedComment[] = [
  { id: 'lm-c-hc1', externalId: 'legiscan:2055958', userId: 'lm-user-la1',
    content: '<p><span data-type="mention" data-id="role:lm-role-mi" data-label="Michigan Team">@Michigan Team</span> who can cover the Lansing hearing? I am double-booked with the county call that morning.</p>', daysAgo: 3 },
  { id: 'lm-c-hc2', externalId: 'legiscan:2055958', userId: 'lm-user-la2',
    content: '<p>I can take it. I will bring the decal cost sheet from last session.</p>', daysAgo: 2 },
  { id: 'lm-c-hc3', externalId: 'legiscan:2129983', userId: 'lm-user-wq',
    content: '<p><span data-type="mention" data-id="role:lm-role-mi" data-label="Michigan Team">@Michigan Team</span> I will draft testimony for this one — first pass by Friday if anyone wants to review it.</p>', daysAgo: 2 },
  { id: 'lm-c-hc4', externalId: 'legiscan:2129983', userId: 'lm-user-res',
    content: '<p>Happy to review. I have the school lead-testing numbers ready to fold in.</p>', daysAgo: 1 },
]

// The hearing-coordination thread is the newest content in the seed and carried
// no mentions at all, so none of it reached the bell. These two comments are the
// asks — cover the hearing, review the testimony — which is what a mention is
// for; hc2 and hc4 are the answers to them, and answering in thread needs no
// @-tag. Michigan Team is demo-user, lm-user-la1, and lm-user-comms: hc1's
// author (lm-user-la1) is filtered out of its own fan-out, hc3's author
// (lm-user-wq, Wisconsin) is not a member, so it reaches all three.
const hearingCoordinationMentions: DemoSeedMention[] = [
  { id: 'lm-m-39', commentId: 'lm-c-hc1', userId: 'demo-user',     sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 3 },
  { id: 'lm-m-40', commentId: 'lm-c-hc1', userId: 'lm-user-comms', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 3 },
  { id: 'lm-m-41', commentId: 'lm-c-hc3', userId: 'demo-user',     sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 2 },
  { id: 'lm-m-42', commentId: 'lm-c-hc3', userId: 'lm-user-la1',   sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 2 },
  { id: 'lm-m-43', commentId: 'lm-c-hc3', userId: 'lm-user-comms', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 2 },
]

export const LM_COMMENTS: DemoSeedComment[] = [
  ...hb4427, ...hb5308, ...sb0771, ...hb5674, ...hb4768, ...sb56, ...ab131, ...ab129, ...sb628,
  ...ilHb1175, ...ilSb4025, ...ilHb5268, ...ilHb2516,
  ...inHb1124, ...inSb0006, ...inSb0188,
  ...usHb284, ...usHb8876, ...usHb583, ...usHb6668,
  ...hearingCoordination,
]

export const LM_REACTIONS: DemoSeedReaction[] = [
  ...hb4427Reactions, ...hb5308Reactions, ...sb0771Reactions, ...hb5674Reactions, ...hb4768Reactions,
  ...sb56Reactions, ...ab131Reactions, ...ab129Reactions, ...sb628Reactions,
  ...ilHb1175Reactions, ...ilSb4025Reactions, ...ilHb5268Reactions, ...ilHb2516Reactions,
  ...inHb1124Reactions, ...inSb0006Reactions, ...inSb0188Reactions,
  ...usHb284Reactions, ...usHb8876Reactions, ...usHb583Reactions, ...usHb6668Reactions,
]

export const LM_MENTIONS: DemoSeedMention[] = [
  ...hb4427Mentions, ...hb5308Mentions, ...sb0771Mentions, ...hb4768Mentions,
  ...ab131Mentions, ...ab129Mentions,
  ...ilHb1175Mentions, ...ilHb2516Mentions, ...inHb1124Mentions, ...usHb284Mentions, ...usHb6668Mentions,
  ...hearingCoordinationMentions,
]

export const LM_VOTES: DemoSeed['votes'] = [
  ...hb4427Votes, ...hb5308Votes, ...sb0771Votes, ...sb56Votes, ...ab131Votes, ...ab129Votes,
  ...ilHb1175Votes, ...ilSb4025Votes, ...ilHb5268Votes, ...ilHb2516Votes,
  ...inHb1124Votes, ...inSb0006Votes,
  ...usHb284Votes, ...usHb8876Votes, ...usHb583Votes, ...usHb6668Votes,
]

// Personal notes, all owned by demo-user (demoReset.ts hardcodes the note
// owner, hence no userId field on DemoSeedNote).
export const LM_NOTES: DemoSeed['notes'] = [
  { id: 'lm-n-1', externalId: 'legiscan:2029026', daysAgo: 3,
    content: '<p>Ask committee staff whether the E. coli threshold will be set by rule or in statute.</p>' },
  { id: 'lm-n-2', externalId: 'legiscan:2095619', daysAgo: 45,
    content: '<p>Follow up with the counties association on the assessment cost-share question before third reading.</p>' },
  { id: 'lm-n-3', externalId: 'legiscan:1979645', daysAgo: 390,
    content: '<p>Good template for a Michigan lead service line bill next session.</p>' },
  { id: 'lm-n-4', externalId: 'legiscan:2006944', daysAgo: 130,
    content: '<p>Reintroduction target is the January 2027 session start.</p>' },
  { id: 'lm-n-5', externalId: 'legiscan:1906052', daysAgo: 4,
    content: '<p>Ask Energy and Environment staff whether the coal ash standard cross-references the federal EPA rule directly.</p>' },
  { id: 'lm-n-6', externalId: 'legiscan:2150744', daysAgo: 5,
    content: "<p>Follow up with Grace on whether Michigan's mussel data can strengthen the record for the next subcommittee hearing.</p>" },
]
