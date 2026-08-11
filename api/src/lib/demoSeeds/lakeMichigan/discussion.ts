import type { DemoSeed, DemoSeedComment, DemoSeedMention, DemoSeedReaction } from '../types'

/**
 * Comments, reactions, mentions, votes, and notes for the Lake Michigan seed.
 *
 * This task covers the nine Michigan and Wisconsin bills — Michigan's five are
 * all live and get near-term, working-the-bill chatter; Wisconsin's four have
 * all concluded (two enacted, two dead at the end-of-biennium deadline), so
 * their thread is about outcomes and what to reintroduce. Illinois, Indiana,
 * and federal bills are appended in Task 6.
 *
 * Comments stay short and plain — one idea, a sentence or three — because the
 * point of the demo is to show the feature surface (comments, reactions,
 * mentions, votes, notes), not to relitigate the bills in memo form.
 */

// ---------------------------------------------------------------------------
// MI HB4427 — legiscan:2029026 (sewage/E. coli "brown alert")
// ---------------------------------------------------------------------------
const hb4427: DemoSeedComment[] = [
  { id: 'lm-c-1', externalId: 'legiscan:2029026', userId: 'lm-user-la1',
    content: "<p>Local Government hearing is Thursday. I'll have written testimony ready by Wednesday.</p>", daysAgo: 3 },
  { id: 'lm-c-2', externalId: 'legiscan:2029026', userId: 'lm-user-wq',
    content: '<p>Beach closures were up along our stretch last summer. This would at least tell people same day instead of two days later.</p>', daysAgo: 3 },
  { id: 'lm-c-3', externalId: 'legiscan:2029026', userId: 'lm-user-comms',
    content: '<p>If this passes the Senate, the brown alert name makes a clean, simple press release. People will get it immediately.</p>', daysAgo: 2 },
  { id: 'lm-c-4', externalId: 'legiscan:2029026', userId: 'lm-user-ed',
    content: '<p><span data-type="mention" data-id="role:lm-role-mi" data-label="Michigan Team">@Michigan Team</span> can someone attend Thursday in person? I am traveling that day.</p>', daysAgo: 2 },
  { id: 'lm-c-5', externalId: 'legiscan:2029026', userId: 'lm-user-la1',
    content: "<p>I've got it, I'll be there.</p>", daysAgo: 2 },
  { id: 'lm-c-6', externalId: 'legiscan:2029026', userId: 'demo-user',
    content: '<p>Testimony is submitted. Thanks for the fast turnaround, <span data-type="mention" data-id="user:lm-user-la1" data-label="Devon Clarke">@Devon Clarke</span>.</p>', daysAgo: 1 },
]

const hb4427Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-1', commentId: 'lm-c-2', userId: 'demo-user', emoji: '👍', daysAgo: 2 },
  { id: 'lm-r-2', commentId: 'lm-c-6', userId: 'lm-user-ed', emoji: '✅', daysAgo: 1 },
]

const hb4427Mentions: DemoSeedMention[] = [
  { id: 'lm-m-1', commentId: 'lm-c-4', userId: 'demo-user', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 2 },
  { id: 'lm-m-2', commentId: 'lm-c-4', userId: 'lm-user-la1', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 2 },
  { id: 'lm-m-3', commentId: 'lm-c-4', userId: 'lm-user-comms', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 2 },
  { id: 'lm-m-4', commentId: 'lm-c-6', userId: 'lm-user-la1', sourceType: 'user', sourceId: 'lm-user-la1', daysAgo: 1 },
]

const hb4427Votes: DemoSeed['votes'] = [
  { id: 'lm-v-1', externalId: 'legiscan:2029026', userId: 'demo-user', position: 'support', daysAgo: 15 },
  { id: 'lm-v-2', externalId: 'legiscan:2029026', userId: 'lm-user-la1', position: 'support', daysAgo: 14 },
  { id: 'lm-v-3', externalId: 'legiscan:2029026', userId: 'lm-user-comms', position: 'support', daysAgo: 13 },
  { id: 'lm-v-4', externalId: 'legiscan:2029026', userId: 'lm-user-wq', position: 'support', daysAgo: 12 },
  { id: 'lm-v-5', externalId: 'legiscan:2029026', userId: 'lm-user-ed', position: 'support', daysAgo: 11 },
]

// ---------------------------------------------------------------------------
// MI HB5308 — legiscan:2055958 (invasive species watercraft decal)
// ---------------------------------------------------------------------------
const hb5308: DemoSeedComment[] = [
  { id: 'lm-c-7', externalId: 'legiscan:2055958', userId: 'demo-user',
    content: '<p>Passed the House 105 to 1. About as close to unanimous as we get.</p>', daysAgo: 5 },
  { id: 'lm-c-8', externalId: 'legiscan:2055958', userId: 'lm-user-la1',
    content: "<p>Testimony deadline is Friday. I can have a draft to you by Wednesday.</p>", daysAgo: 4 },
  { id: 'lm-c-9', externalId: 'legiscan:2055958', userId: 'lm-user-gov',
    content: '<p>Boaters associations are going to like this one—a decal fee that actually funds prevention work.</p>', daysAgo: 4 },
  { id: 'lm-c-10', externalId: 'legiscan:2055958', userId: 'lm-user-res',
    content: "<p>Michigan's invasive mussel counts are still climbing on the west shoreline. Good timing for this.</p>", daysAgo: 3 },
  { id: 'lm-c-11', externalId: 'legiscan:2055958', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-habitat" data-label="Habitat">@Habitat</span> should we flag this decal fee model to the other states we track?</p>', daysAgo: 3 },
  { id: 'lm-c-12', externalId: 'legiscan:2055958', userId: 'lm-user-res',
    content: "<p>Good idea, I'll draft a quick comparison for the coalition call.</p>", daysAgo: 3 },
]

const hb5308Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-3', commentId: 'lm-c-7', userId: 'lm-user-ed', emoji: '✅', daysAgo: 5 },
  { id: 'lm-r-4', commentId: 'lm-c-10', userId: 'demo-user', emoji: '👀', daysAgo: 3 },
]

const hb5308Mentions: DemoSeedMention[] = [
  { id: 'lm-m-5', commentId: 'lm-c-11', userId: 'lm-user-res', sourceType: 'role', sourceId: 'lm-role-habitat', daysAgo: 3 },
  { id: 'lm-m-6', commentId: 'lm-c-11', userId: 'lm-user-prog', sourceType: 'role', sourceId: 'lm-role-habitat', daysAgo: 3 },
  { id: 'lm-m-7', commentId: 'lm-c-11', userId: 'lm-user-data', sourceType: 'role', sourceId: 'lm-role-habitat', daysAgo: 3 },
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
    content: '<p>Good news—this cleared committee this morning.</p>', daysAgo: 55 },
  { id: 'lm-c-14', externalId: 'legiscan:2095619', userId: 'lm-user-gc',
    content: '<p>Substitute language clears up the assessment cost question we flagged. Much better draft.</p>', daysAgo: 55 },
  { id: 'lm-c-15', externalId: 'legiscan:2095619', userId: 'lm-user-dep',
    content: '<p><span data-type="mention" data-id="role:lm-role-infra" data-label="Infrastructure">@Infrastructure</span> flagging for the tracker, this just moved to third reading.</p>', daysAgo: 50 },
  { id: 'lm-c-16', externalId: 'legiscan:2095619', userId: 'lm-user-gov',
    content: '<p>Got it, added to the tracker.</p>', daysAgo: 49 },
  { id: 'lm-c-17', externalId: 'legiscan:2095619', userId: 'lm-user-grants',
    content: "<p>Testimony's filed. If this reaches third reading next month, we should ask about a cost-share amendment.</p>", daysAgo: 3 },
  { id: 'lm-c-18', externalId: 'legiscan:2095619', userId: 'lm-user-wq',
    content: '<p>Third reading order is good news. This basin has needed septic oversight for years.</p>', daysAgo: 2 },
]

const sb0771Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-5', commentId: 'lm-c-13', userId: 'lm-user-dep', emoji: '✅', daysAgo: 55 },
  { id: 'lm-r-6', commentId: 'lm-c-13', userId: 'lm-user-gc', emoji: '👍', daysAgo: 55 },
]

const sb0771Mentions: DemoSeedMention[] = [
  { id: 'lm-m-8', commentId: 'lm-c-15', userId: 'demo-user', sourceType: 'role', sourceId: 'lm-role-infra', daysAgo: 50 },
  { id: 'lm-m-9', commentId: 'lm-c-15', userId: 'lm-user-la2', sourceType: 'role', sourceId: 'lm-role-infra', daysAgo: 50 },
  { id: 'lm-m-10', commentId: 'lm-c-15', userId: 'lm-user-gov', sourceType: 'role', sourceId: 'lm-role-infra', daysAgo: 50 },
  { id: 'lm-m-11', commentId: 'lm-c-15', userId: 'lm-user-grants', sourceType: 'role', sourceId: 'lm-role-infra', daysAgo: 50 },
]

const sb0771Votes: DemoSeed['votes'] = [
  { id: 'lm-v-10', externalId: 'legiscan:2095619', userId: 'demo-user', position: 'support', daysAgo: 48 },
  { id: 'lm-v-11', externalId: 'legiscan:2095619', userId: 'lm-user-gc', position: 'neutral', daysAgo: 46 },
  { id: 'lm-v-12', externalId: 'legiscan:2095619', userId: 'lm-user-grants', position: 'support', daysAgo: 44 },
]

// ---------------------------------------------------------------------------
// MI HB5674 — legiscan:2129983 (clean drinking water in schools)
// ---------------------------------------------------------------------------
const hb5674: DemoSeedComment[] = [
  { id: 'lm-c-19', externalId: 'legiscan:2129983', userId: 'lm-user-res',
    content: "<p>This is the schools bill we've been waiting for. Lead testing every three years, results posted publicly.</p>", daysAgo: 12 },
  { id: 'lm-c-20', externalId: 'legiscan:2129983', userId: 'lm-user-out',
    content: '<p>Happy to get this in front of the PTA coalition once it has a committee date.</p>', daysAgo: 12 },
  { id: 'lm-c-21', externalId: 'legiscan:2129983', userId: 'lm-user-data',
    content: "<p>About 40% of Michigan school buildings pre-date 1986 plumbing codes, for what it's worth.</p>", daysAgo: 10 },
]

const hb5674Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-7', commentId: 'lm-c-19', userId: 'demo-user', emoji: '👍', daysAgo: 11 },
  { id: 'lm-r-8', commentId: 'lm-c-21', userId: 'lm-user-comms', emoji: '👀', daysAgo: 9 },
]

// ---------------------------------------------------------------------------
// MI HB4768 — legiscan:2041788 (microplastics testing)
// ---------------------------------------------------------------------------
const hb4768: DemoSeedComment[] = [
  { id: 'lm-c-22', externalId: 'legiscan:2041788', userId: 'lm-user-la1',
    content: '<p>Still sitting in Natural Resources and Tourism. No hearing scheduled yet.</p>', daysAgo: 200 },
  { id: 'lm-c-23', externalId: 'legiscan:2041788', userId: 'lm-user-res',
    content: '<p>Worth checking back on this each session. Microplastics testing keeps getting introduced but rarely moves.</p>', daysAgo: 150 },
  { id: 'lm-c-24', externalId: 'legiscan:2041788', userId: 'demo-user',
    content: '<p><span data-type="mention" data-id="role:lm-role-mi" data-label="Michigan Team">@Michigan Team</span> should we keep pushing this one, or let it sit at low priority?</p>', daysAgo: 20 },
  { id: 'lm-c-25', externalId: 'legiscan:2041788', userId: 'lm-user-la1',
    content: "<p>Let it sit. Nothing's moved in a year.</p>", daysAgo: 19 },
]

const hb4768Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-9', commentId: 'lm-c-25', userId: 'lm-user-comms', emoji: '👀', daysAgo: 18 },
]

const hb4768Mentions: DemoSeedMention[] = [
  { id: 'lm-m-12', commentId: 'lm-c-24', userId: 'demo-user', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 20 },
  { id: 'lm-m-13', commentId: 'lm-c-24', userId: 'lm-user-la1', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 20 },
  { id: 'lm-m-14', commentId: 'lm-c-24', userId: 'lm-user-comms', sourceType: 'role', sourceId: 'lm-role-mi', daysAgo: 20 },
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

const sb56Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-10', commentId: 'lm-c-26', userId: 'demo-user', emoji: '✅', daysAgo: 405 },
  { id: 'lm-r-11', commentId: 'lm-c-27', userId: 'lm-user-dep', emoji: '✅', daysAgo: 404 },
  { id: 'lm-r-12', commentId: 'lm-c-27', userId: 'lm-user-wq', emoji: '👍', daysAgo: 403 },
]

const sb56Votes: DemoSeed['votes'] = [
  { id: 'lm-v-13', externalId: 'legiscan:1979645', userId: 'lm-user-la2', position: 'support', daysAgo: 400 },
  { id: 'lm-v-14', externalId: 'legiscan:1979645', userId: 'lm-user-wq', position: 'support', daysAgo: 399 },
  { id: 'lm-v-15', externalId: 'legiscan:1979645', userId: 'lm-user-data', position: 'support', daysAgo: 398 },
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
    content: "<p>Curious how much of this gets left to rulemaking. Worth watching the agency's implementation timeline.</p>", daysAgo: 127 },
  { id: 'lm-c-31', externalId: 'legiscan:2006749', userId: 'lm-user-data',
    content: '<p>Pulling together a one-pager on what the testing requirements actually cover for the newsletter.</p>', daysAgo: 120 },
  { id: 'lm-c-32', externalId: 'legiscan:2006749', userId: 'lm-user-comms',
    content: '<p><span data-type="mention" data-id="role:lm-role-wi" data-label="Wisconsin Team">@Wisconsin Team</span> can one of you review the one-pager before it goes out Friday?</p>', daysAgo: 118 },
  { id: 'lm-c-33', externalId: 'legiscan:2006749', userId: 'lm-user-la2',
    content: '<p>On it. Will have comments back by Thursday.</p>', daysAgo: 117 },
]

const ab131Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-13', commentId: 'lm-c-29', userId: 'demo-user', emoji: '✅', daysAgo: 127 },
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
  { id: 'lm-v-21', externalId: 'legiscan:2006749', userId: 'lm-user-data', position: 'support', daysAgo: 113 },
  { id: 'lm-v-22', externalId: 'legiscan:2006749', userId: 'lm-user-gc', position: 'neutral', daysAgo: 112 },
  { id: 'lm-v-23', externalId: 'legiscan:2006749', userId: 'lm-user-ed', position: 'support', daysAgo: 111 },
]

// ---------------------------------------------------------------------------
// WI AB129 — legiscan:2006944 (safe drinking water in schools — died via SJR 1)
// ---------------------------------------------------------------------------
const ab129: DemoSeedComment[] = [
  { id: 'lm-c-34', externalId: 'legiscan:2006944', userId: 'demo-user',
    content: '<p>This one died at the deadline. Two years of work and it never got a floor vote.</p>', daysAgo: 140 },
  { id: 'lm-c-35', externalId: 'legiscan:2006944', userId: 'lm-user-la2',
    content: '<p><span data-type="mention" data-id="role:lm-role-wi" data-label="Wisconsin Team">@Wisconsin Team</span> worth another run in January? Testing lead in schools polls well everywhere.</p>', daysAgo: 140 },
  { id: 'lm-c-36', externalId: 'legiscan:2006944', userId: 'lm-user-gov',
    content: '<p>Yes. Adding it to the reintroduction list.</p>', daysAgo: 139 },
  { id: 'lm-c-37', externalId: 'legiscan:2006944', userId: 'lm-user-ed',
    content: "<p>Frustrating, but not surprising given how late in session it landed. January's the right call.</p>", daysAgo: 135 },
]

const ab129Reactions: DemoSeedReaction[] = [
  { id: 'lm-r-15', commentId: 'lm-c-34', userId: 'lm-user-dep', emoji: '👀', daysAgo: 140 },
  { id: 'lm-r-16', commentId: 'lm-c-36', userId: 'lm-user-la2', emoji: '👍', daysAgo: 138 },
]

const ab129Mentions: DemoSeedMention[] = [
  { id: 'lm-m-18', commentId: 'lm-c-35', userId: 'lm-user-la2', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 140 },
  { id: 'lm-m-19', commentId: 'lm-c-35', userId: 'lm-user-wq', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 140 },
  { id: 'lm-m-20', commentId: 'lm-c-35', userId: 'lm-user-data', sourceType: 'role', sourceId: 'lm-role-wi', daysAgo: 140 },
]

const ab129Votes: DemoSeed['votes'] = [
  { id: 'lm-v-24', externalId: 'legiscan:2006944', userId: 'lm-user-la2', position: 'support', daysAgo: 130 },
  { id: 'lm-v-25', externalId: 'legiscan:2006944', userId: 'lm-user-wq', position: 'support', daysAgo: 128 },
  { id: 'lm-v-26', externalId: 'legiscan:2006944', userId: 'lm-user-data', position: 'neutral', daysAgo: 125 },
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
  { id: 'lm-r-17', commentId: 'lm-c-38', userId: 'lm-user-data', emoji: '👀', daysAgo: 140 },
]

// ---------------------------------------------------------------------------
// Combined exports
// ---------------------------------------------------------------------------
export const LM_COMMENTS: DemoSeedComment[] = [
  ...hb4427, ...hb5308, ...sb0771, ...hb5674, ...hb4768, ...sb56, ...ab131, ...ab129, ...sb628,
]

export const LM_REACTIONS: DemoSeedReaction[] = [
  ...hb4427Reactions, ...hb5308Reactions, ...sb0771Reactions, ...hb5674Reactions, ...hb4768Reactions,
  ...sb56Reactions, ...ab131Reactions, ...ab129Reactions, ...sb628Reactions,
]

export const LM_MENTIONS: DemoSeedMention[] = [
  ...hb4427Mentions, ...hb5308Mentions, ...sb0771Mentions, ...hb4768Mentions,
  ...ab131Mentions, ...ab129Mentions,
]

export const LM_VOTES: DemoSeed['votes'] = [
  ...hb4427Votes, ...hb5308Votes, ...sb0771Votes, ...sb56Votes, ...ab131Votes, ...ab129Votes,
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
]
