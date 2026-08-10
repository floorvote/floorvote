import { NJ_COUNTY_CLERKS } from '../../config/associations/nj-county-clerks'
import type { DemoSeed } from './types'

// The elections demo at demo.floor.vote: an association of New Jersey county
// clerks. Fictional personas and fictional county names, attached to real NJ
// bills from the 2026-2027 session.
//
// Bills (LegiScan external_id format is "legiscan:{bill_id}"):
//   legiscan:2099974 = A1129  ballot drop boxes for fire district elections
//   legiscan:2100182 = A1195  Voter Convenience Act — vote at any polling place
//   legiscan:2098535 = A1680  voter registration up to 14 days before election
//   legiscan:2098113 = A1715  John R. Lewis Voter Empowerment Act
//   legiscan:2098630 = A1698  same-day voter registration at polling place / early voting
//   legiscan:2096183 = A251   new voting machines with paper audit trail
//   legiscan:2099056 = A2670  county board of elections canvassing early votes
//   legiscan:2096553 = A548   county clerk death filing + voter registration
//
// Everything here is inert data. All SQL lives in demoReset.ts.

/** One entry in a bill_updated event's `changes` array, matching ChangeRecord. */
const chg = (changeType: string, f: { oldValue?: string; newValue?: string; detail?: string } = {}) =>
  ({ changeType, oldValue: f.oldValue ?? null, newValue: f.newValue ?? null, detail: f.detail ?? null })

export const NJ_COUNTY_CLERKS_SEED: DemoSeed = {
  slug: 'nj-county-clerks',
  associationName: NJ_COUNTY_CLERKS.name,
  bannerText: "You're exploring a demo instance — data resets nightly. The bills are real New Jersey legislation, but the people, county names, and hearing dates are fictional.",
  orgNoun: 'association',
  aiContext: NJ_COUNTY_CLERKS.aiContext,
  relevanceQuestion: NJ_COUNTY_CLERKS.relevanceQuestion,
  tagTaxonomy: NJ_COUNTY_CLERKS.tagTaxonomy,
  keywords: NJ_COUNTY_CLERKS.keywords,
  positionVocabulary: ['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'],

  // Start the demo with optional widgets OFF so visitors can experience enabling
  // them in Settings → Modules (toggling modules is allowed in demo mode; all
  // other config stays locked). Nightly reset returns them to off. email-digest is
  // shown ON but read-only (the toggle is disabled in demo and runDigest hard-stops
  // before sending), so demo visitors see the configured state without any email
  // actually going out.
  modules: {
    'waiting-for-vote': false,
    'upcoming-hearings': false,
    'calendar': true,
    'email-digest': { enabled: true, settings: { frequency: 'daily', weeklyDay: '1' } },
  },
  sessions: {
    data: [
      { identifier: '2250', name: '2026-2027 Regular Session', classification: 'primary', startDate: '2026-01-01', endDate: '2027-12-31' },
    ],
  },
  // This tenant is STATE = "NJ", so it carries no multi-state coverage list.
  stateCoverage: null,

  // Canonical seed users — NJ county/municipal clerks (fictional names, real NJ
  // county names). lastActiveDaysAgo is staggered to give a realistic active
  // curve: 11 personas active within 7 days, the rest within 30.
  users: [
    { id: 'demo-user', email: 'demo@example.com',      name: 'Demo Admin',      role: 'admin',  subtitle: 'County Clerk · Harborview County, NJ',        createdDaysAgo: 90, canVote: true,  lastActiveDaysAgo: 0 },
    { id: 'demo-dir',  email: 'maria@demo.example',    name: 'Maria Santos',    role: 'admin',  subtitle: 'Director of Elections · Stonegate County, NJ', createdDaysAgo: 90, canVote: true,  lastActiveDaysAgo: 0 },
    { id: 'demo-dep',  email: 'james@demo.example',    name: 'James Chen',      role: 'admin',  subtitle: 'Deputy Clerk · Cedarbrook County, NJ',        createdDaysAgo: 85, canVote: true,  lastActiveDaysAgo: 1 },
    { id: 'demo-m1',   email: 'sarah@demo.example',    name: 'Sarah Mitchell',  role: 'member', subtitle: 'County Clerk · Millbrook County, NJ',         createdDaysAgo: 80, canVote: true,  lastActiveDaysAgo: 1 },
    { id: 'demo-m2',   email: 'david@demo.example',    name: 'David Park',      role: 'member', subtitle: 'County Clerk · Clearwater County, NJ',        createdDaysAgo: 75, canVote: true,  lastActiveDaysAgo: 2 },
    { id: 'demo-m3',   email: 'rachel@demo.example',   name: 'Rachel Torres',   role: 'member', subtitle: 'County Clerk · Ridgecrest County, NJ',        createdDaysAgo: 70, canVote: true,  lastActiveDaysAgo: 2 },
    { id: 'demo-m4',   email: 'michael@demo.example',  name: 'Michael Brown',   role: 'member', subtitle: 'County Clerk · Elmhurst County, NJ',          createdDaysAgo: 65, canVote: true,  lastActiveDaysAgo: 3 },
    { id: 'demo-m5',   email: 'lisa@demo.example',     name: 'Lisa Nguyen',     role: 'member', subtitle: 'County Clerk · Brookfield County, NJ',        createdDaysAgo: 60, canVote: true,  lastActiveDaysAgo: 4 },
    { id: 'demo-m6',   email: 'robert@demo.example',   name: 'Robert Kim',      role: 'member', subtitle: 'County Clerk · Northhaven County, NJ',        createdDaysAgo: 55, canVote: true,  lastActiveDaysAgo: 5 },
    { id: 'demo-m7',   email: 'amanda@demo.example',   name: 'Amanda Foster',   role: 'member', subtitle: 'County Clerk · Fairhaven County, NJ',         createdDaysAgo: 50, canVote: false, lastActiveDaysAgo: 6 },
    { id: 'demo-m8',   email: 'thomas@demo.example',   name: 'Thomas Wright',   role: 'member', subtitle: 'County Clerk · Lakeshire County, NJ',         createdDaysAgo: 45, canVote: true,  lastActiveDaysAgo: 6 },
    { id: 'demo-m9',   email: 'jennifer@demo.example', name: 'Jennifer Adams',  role: 'member', subtitle: 'County Clerk · Maplewood County, NJ',         createdDaysAgo: 40, canVote: true,  lastActiveDaysAgo: 10 },
    { id: 'demo-m10',  email: 'kevin@demo.example',    name: "Kevin O'Brien",   role: 'member', subtitle: 'County Clerk · Pinecrest County, NJ',         createdDaysAgo: 35, canVote: true,  lastActiveDaysAgo: 14 },
    { id: 'demo-m11',  email: 'patricia@demo.example', name: 'Patricia Reeves', role: 'member', subtitle: 'County Clerk · Ashwood County, NJ',           createdDaysAgo: 30, canVote: true,  lastActiveDaysAgo: 20 },
    { id: 'demo-m12',  email: 'daniel@demo.example',   name: 'Daniel Vega',     role: 'member', subtitle: 'County Clerk · Willowbrook County, NJ',       createdDaysAgo: 25, canVote: true,  lastActiveDaysAgo: 28 },
  ],

  roles: [
    { id: 'demo-role-1', name: 'County Elections Director' },
    { id: 'demo-role-2', name: 'Deputy/Assistant Director' },
    { id: 'demo-role-3', name: 'Technology & Modernization' },
    { id: 'demo-role-4', name: 'Voter Access & Outreach' },
    { id: 'demo-role-5', name: 'Training & Certification' },
  ],

  userRoles: [
    { userId: 'demo-dir', roleId: 'demo-role-1' },
    { userId: 'demo-m2',  roleId: 'demo-role-1' },
    { userId: 'demo-m8',  roleId: 'demo-role-1' },
    { userId: 'demo-dep', roleId: 'demo-role-2' },
    { userId: 'demo-m3',  roleId: 'demo-role-2' },
    { userId: 'demo-m5',  roleId: 'demo-role-2' },
    { userId: 'demo-m1',  roleId: 'demo-role-3' },
    { userId: 'demo-m6',  roleId: 'demo-role-3' },
    { userId: 'demo-m10', roleId: 'demo-role-3' },
    { userId: 'demo-m4',  roleId: 'demo-role-4' },
    { userId: 'demo-m7',  roleId: 'demo-role-4' },
    { userId: 'demo-m12', roleId: 'demo-role-4' },
    { userId: 'demo-m9',  roleId: 'demo-role-5' },
    { userId: 'demo-m11', roleId: 'demo-role-5' },
    { userId: 'demo-m4',  roleId: 'demo-role-5' },
  ],

  customFields: [
    { id: 'demo-cf-1', name: 'Fiscal Impact',           slug: 'fiscal-impact',         type: 'dropdown', options: ['No Impact', 'Minimal (<$10K)', 'Moderate ($10K-$100K)', 'Significant (>$100K)', 'Unknown'], displayOrder: 1 },
    { id: 'demo-cf-2', name: 'Committee Assignment',    slug: 'committee',             type: 'dropdown', options: ['Voter Access', 'Technology', 'Training', 'Legislative Affairs', 'Budget'], displayOrder: 2 },
    { id: 'demo-cf-3', name: 'Association Concerns',    slug: 'association-concerns',  type: 'text',     options: null, displayOrder: 3, pinned: true },
    { id: 'demo-cf-4', name: 'Implementation Deadline', slug: 'impl-deadline',         type: 'date',     options: null, displayOrder: 4 },
    { id: 'demo-cf-5', name: 'Testimony Submitted',     slug: 'testimony',             type: 'binary',   options: null, displayOrder: 5 },
  ],

  priorities: [
    { externalId: 'legiscan:2099974', priority: 'high' },    // A1129 — ballot drop boxes
    { externalId: 'legiscan:2100182', priority: 'high' },    // A1195 — Voter Convenience Act
    { externalId: 'legiscan:2098535', priority: 'high' },    // A1680 — voter registration 14 days
    { externalId: 'legiscan:2098113', priority: 'high' },    // A1715 — John R. Lewis Voter Empowerment Act
    { externalId: 'legiscan:2098630', priority: 'medium' },  // A1698 — same-day voter registration
    { externalId: 'legiscan:2096183', priority: 'medium' },  // A251  — voting machines
    { externalId: 'legiscan:2099056', priority: 'medium' },  // A2670 — canvassing early votes
    { externalId: 'legiscan:2096553', priority: 'low' },     // A548  — county clerk death filing
  ],

  positions: [
    { id: 'demo-pos-1', externalId: 'legiscan:2099974', position: 'Support', setBy: 'demo-dir', daysAgo: 60 }, // A1129 — drop boxes
    { id: 'demo-pos-2', externalId: 'legiscan:2100182', position: 'Support', setBy: 'demo-dir', daysAgo: 60 }, // A1195 — Voter Convenience Act
    { id: 'demo-pos-3', externalId: 'legiscan:2098535', position: 'Amend',   setBy: 'demo-dir', daysAgo: 30 }, // A1680 — voter reg 14 days
    { id: 'demo-pos-4', externalId: 'legiscan:2098630', position: 'Monitor', setBy: 'demo-dep', daysAgo: 21 }, // A1698 — same-day reg
    { id: 'demo-pos-5', externalId: 'legiscan:2096183', position: 'Support', setBy: 'demo-dep', daysAgo: 21 }, // A251  — voting machines
    { id: 'demo-pos-6', externalId: 'legiscan:2098113', position: 'Support', setBy: 'demo-dir', daysAgo: 60 }, // A1715 — John R. Lewis Act
  ],

  votes: [
    // A1129 — ballot drop boxes: broad member engagement
    { id: 'demo-vote-1',  externalId: 'legiscan:2099974', userId: 'demo-user', position: 'support', daysAgo: 60 },
    { id: 'demo-vote-2',  externalId: 'legiscan:2099974', userId: 'demo-m1',   position: 'support', daysAgo: 60 },
    { id: 'demo-vote-3',  externalId: 'legiscan:2099974', userId: 'demo-m2',   position: 'support', daysAgo: 60 },
    { id: 'demo-vote-4',  externalId: 'legiscan:2099974', userId: 'demo-m3',   position: 'support', daysAgo: 30 },
    { id: 'demo-vote-5',  externalId: 'legiscan:2099974', userId: 'demo-m4',   position: 'neutral', daysAgo: 30 },
    { id: 'demo-vote-6',  externalId: 'legiscan:2099974', userId: 'demo-m5',   position: 'support', daysAgo: 14 },
    { id: 'demo-vote-7',  externalId: 'legiscan:2099974', userId: 'demo-m6',   position: 'support', daysAgo: 14 },
    // A1195 — Voter Convenience Act
    { id: 'demo-vote-8',  externalId: 'legiscan:2100182', userId: 'demo-user', position: 'support', daysAgo: 30 },
    { id: 'demo-vote-9',  externalId: 'legiscan:2100182', userId: 'demo-m6',   position: 'oppose',  daysAgo: 30 },
    { id: 'demo-vote-10', externalId: 'legiscan:2100182', userId: 'demo-m7',   position: 'neutral', daysAgo: 21 },
    { id: 'demo-vote-11', externalId: 'legiscan:2100182', userId: 'demo-m8',   position: 'support', daysAgo: 14 },
    { id: 'demo-vote-12', externalId: 'legiscan:2100182', userId: 'demo-m9',   position: 'support', daysAgo: 14 },
    // A1680 — voter registration 14 days
    { id: 'demo-vote-13', externalId: 'legiscan:2098535', userId: 'demo-user', position: 'support', daysAgo: 21 },
    { id: 'demo-vote-14', externalId: 'legiscan:2098535', userId: 'demo-m10',  position: 'neutral', daysAgo: 21 },
    { id: 'demo-vote-15', externalId: 'legiscan:2098535', userId: 'demo-m11',  position: 'support', daysAgo: 14 },
    { id: 'demo-vote-16', externalId: 'legiscan:2098535', userId: 'demo-m12',  position: 'support', daysAgo: 14 },
    // A251 — voting machines
    { id: 'demo-vote-17', externalId: 'legiscan:2096183', userId: 'demo-user', position: 'support', daysAgo: 30 },
    { id: 'demo-vote-18', externalId: 'legiscan:2096183', userId: 'demo-m1',   position: 'support', daysAgo: 30 },
    { id: 'demo-vote-19', externalId: 'legiscan:2096183', userId: 'demo-m3',   position: 'neutral', daysAgo: 14 },
    // A1715 — John R. Lewis Voter Empowerment Act
    { id: 'demo-vote-20', externalId: 'legiscan:2098113', userId: 'demo-user', position: 'support', daysAgo: 60 },
    { id: 'demo-vote-21', externalId: 'legiscan:2098113', userId: 'demo-m2',   position: 'support', daysAgo: 30 },
    { id: 'demo-vote-22', externalId: 'legiscan:2098113', userId: 'demo-m7',   position: 'support', daysAgo: 30 },
    { id: 'demo-vote-23', externalId: 'legiscan:2098113', userId: 'demo-m11',  position: 'neutral', daysAgo: 21 },
    // A1698 — same-day voter registration
    { id: 'demo-vote-24', externalId: 'legiscan:2098630', userId: 'demo-user', position: 'support', daysAgo: 21 },
    { id: 'demo-vote-25', externalId: 'legiscan:2098630', userId: 'demo-m4',   position: 'neutral', daysAgo: 14 },
    { id: 'demo-vote-26', externalId: 'legiscan:2098630', userId: 'demo-m9',   position: 'support', daysAgo: 14 },
  ],

  // Some comments include @mentions (span[data-type=mention] format).
  comments: [
    // A1129 — ballot drop boxes for fire district elections
    { id: 'demo-comment-1', externalId: 'legiscan:2099974', userId: 'demo-dir', daysAgo: 60,
      content: '<p>This closes a real gap. Fire district elections have been operating without drop box access while municipal elections have had it. Key provisions:</p><ul><li><p><strong>Security requirements</strong> in Section 3 align with existing municipal drop box rules — 24-hour video surveillance, chain of custody log</p></li><li><p><strong>Retrieval schedule</strong> requires at least daily collection during the 10-day voting window</p></li><li><p>County board of elections remains the custodian, which keeps oversight consolidated</p></li></ul><p>Recommend supporting at committee. No implementation burden beyond extending existing protocols.</p>' },
    { id: 'demo-comment-2', externalId: 'legiscan:2099974', userId: 'demo-m1', daysAgo: 30,
      content: '<p>Strong support. We already manage drop boxes for general elections — adding fire district elections is straightforward operationally. The video monitoring infrastructure is already in place.</p>' },
    { id: 'demo-comment-3', externalId: 'legiscan:2099974', userId: 'demo-m4', daysAgo: 14,
      content: '<p>One question: does "county board of elections" in Section 3 include situations where the municipality administers the fire district election? We need clarity on who bears the cost of extended drop box hours.</p>' },
    { id: 'demo-comment-4', externalId: 'legiscan:2099974', userId: 'demo-dep', daysAgo: 14,
      content: '<p><span data-type="mention" data-id="user:demo-m4" data-label="Michael Brown">@Michael Brown</span> — good catch. The bill is ambiguous on that. I\'d suggest we request a clarifying amendment: "county board of elections or its designee" to allow delegation to municipal clerks where the fire district election is locally administered.</p>' },

    // A1195 — Voter Convenience Act (any-polling-place voting)
    { id: 'demo-comment-5', externalId: 'legiscan:2100182', userId: 'demo-m6', daysAgo: 30,
      content: '<p>The any-polling-place provision is the most significant operational change I\'ve seen in years. What it means in practice:</p><ul><li><p>Every polling place becomes a provisional ballot site for out-of-precinct voters</p></li><li><p>Poll workers need to process provisional ballots from <em>any</em> registered voter in the county, not just their precinct</p></li><li><p>Adjudication timelines get compressed — we\'d need to process a larger provisional pool in the same post-election window</p></li></ul><p>The concept is voter-friendly, but the operational lift is real. We should request a pilot in 2–3 counties before statewide rollout.</p>' },
    { id: 'demo-comment-6', externalId: 'legiscan:2100182', userId: 'demo-dir', daysAgo: 30,
      content: '<p>Good catch. <span data-type="mention" data-id="role:demo-role-2" data-label="Deputy/Assistant Director">@Deputy/Assistant Director</span> can you model the provisional ballot volume increase based on our 2024 general election data? We need a number before the committee hearing.</p>' },

    // A1680 — voter registration 14 days before election
    { id: 'demo-comment-7', externalId: 'legiscan:2098535', userId: 'demo-m8', daysAgo: 42,
      content: '<p>The 14-day window is an improvement over the current 21-day deadline, but it still leaves a gap compared to the handful of states with same-day registration. Main operational impact:</p><ul><li><p>Processing volume spike in the final two weeks — we\'d need temporary staffing</p></li><li><p>Duplicate detection becomes more time-sensitive with less runway before election day</p></li></ul><p>Support with an amendment requesting a phased implementation and fiscal note for county election offices.</p>' },
    { id: 'demo-comment-8', externalId: 'legiscan:2098535', userId: 'demo-m11', daysAgo: 21,
      content: '<p>The current 21-day deadline was designed around paper processing. With our electronic registration system, 14 days is operationally fine. I\'d support this as written.</p>' },
    { id: 'demo-comment-9', externalId: 'legiscan:2098535', userId: 'demo-m7', daysAgo: 21,
      content: '<p>Agree with Thomas on the electronic processing point. The bigger concern is voter list accuracy — tighter deadlines mean less time to catch duplicate registrations or address discrepancies before election day.</p>' },
    { id: 'demo-comment-10', externalId: 'legiscan:2098535', userId: 'demo-m8', daysAgo: 14,
      content: '<p><span data-type="mention" data-id="role:demo-role-3" data-label="Technology &amp; Modernization">@Technology &amp; Modernization</span> — can you pull our average registration processing time for the last 30 days of the 2024 cycle? We need data to assess whether 14 days is workable without overtime.</p>' },

    // A251 — new voting machines with paper audit trail
    { id: 'demo-comment-11', externalId: 'legiscan:2096183', userId: 'demo-m1', daysAgo: 30,
      content: '<p>Paper audit trail requirement is long overdue. Two things worth watching closely:</p><ul><li><p><strong>Procurement timeline</strong> — the bill requires certified machines by the 2028 general election. Given state procurement timelines, counties need to begin RFP processes in 2026.</p></li><li><p><strong>Storage requirements</strong> for paper records — the bill is silent on retention period and secure storage standards.</p></li></ul><p>We should push for an amendment specifying a minimum 22-month retention period to cover post-election audit windows.</p>' },
    { id: 'demo-comment-12', externalId: 'legiscan:2096183', userId: 'demo-m3', daysAgo: 14,
      content: '<p>The 2028 timeline is aggressive given state procurement rules. Realistically, a competitive bid takes 12–18 months, then delivery and training adds another 6. We need to flag this to sponsors.</p>' },
    { id: 'demo-comment-13', externalId: 'legiscan:2096183', userId: 'demo-dir', daysAgo: 7,
      content: '<p><span data-type="mention" data-id="user:demo-dep" data-label="James Chen">@James Chen</span> — can you reach out to the Division of Elections to clarify whether county procurement falls under the state contract or requires independent bidding? The answer changes our timeline significantly.</p>' },

    // A2670 — canvassing early votes before election day
    { id: 'demo-comment-14', externalId: 'legiscan:2099056', userId: 'demo-m10', daysAgo: 21,
      content: '<p>Allowing canvassing before election day is a significant efficiency gain. Three sections worth close review:</p><ul><li><p><strong>Section 2</strong> — prohibits releasing any results before polls close. Enforcement mechanism is unclear.</p></li><li><p><strong>Section 4</strong> — chain of custody requirements during the pre-canvass period add procedural complexity.</p></li><li><p><strong>Section 6</strong> — dispute resolution for pre-canvass period is new territory — no existing case law.</p></li></ul><p>I\'d recommend we support with an amendment strengthening the results-embargo enforcement in Section 2.</p>' },
    { id: 'demo-comment-15', externalId: 'legiscan:2099056', userId: 'demo-m4', daysAgo: 14,
      content: '<p>The operational upside is real — finishing the canvass post-election currently takes our office 3–4 days. Pre-canvassing early votes would cut that significantly. But the chain of custody requirements in Section 4 need to be more specific about who can be present during pre-canvass and what documentation is required.</p>' },

    // A548 — county clerk death filing + voter registration
    { id: 'demo-comment-16', externalId: 'legiscan:2096553', userId: 'demo-m9', daysAgo: 30,
      content: '<p>Requiring the county clerk to file death information for voter list maintenance is straightforward. We already receive vital records data — this just adds a formal obligation and timeline.</p>' },
    { id: 'demo-comment-17', externalId: 'legiscan:2096553', userId: 'demo-dir', daysAgo: 14,
      content: '<p>Low operational impact for us, but meaningful for list accuracy. I\'d suggest we support.</p>' },

    // A1715 — John R. Lewis Voter Empowerment Act
    { id: 'demo-comment-18', externalId: 'legiscan:2098113', userId: 'demo-dir', daysAgo: 60,
      content: '<p>The John R. Lewis Voter Empowerment Act is the most comprehensive voting rights bill this session. Key provisions affecting county operations:</p><ul><li><strong>Automatic voter registration</strong> — triggers at any state agency interaction. County boards will receive daily electronic transmissions from DMV; volume will increase significantly.</li><li><strong>Pre-registration for 16–17 year olds</strong> — requires a new processing workflow for conditional registrants who become eligible before the election.</li><li><strong>Expanded early voting hours</strong> — adds Saturday and Sunday early voting; counties will need to budget for additional poll worker hours and facility costs.</li><li><strong>Voting rights restoration post-incarceration</strong> — county clerks are the re-registration point of contact for returning citizens; clear notification guidance from the state is needed.</li></ul><p>Recommend we formally support and engage the sponsor early on implementation guidance.</p>' },
    { id: 'demo-comment-19', externalId: 'legiscan:2098113', userId: 'demo-m5', daysAgo: 30,
      content: '<p>The automatic registration provision will be the heaviest lift. In 2024 our county processed about 4,000 DMV-initiated registrations — under this bill that number could double or triple. We need to confirm that SVRS can handle the volume without manual staff intervention for each record.</p>' },

    // A1698 — same-day voter registration
    { id: 'demo-comment-20', externalId: 'legiscan:2098630', userId: 'demo-m2', daysAgo: 21,
      content: '<p>Same-day registration at polling places is more complex than moving the registration deadline (A1680). At-precinct same-day reg means every poll worker needs to accept and process a new registration on election day — that\'s a separate workflow from anything in current poll worker training.</p>' },
    { id: 'demo-comment-21', externalId: 'legiscan:2098630', userId: 'demo-dep', daysAgo: 14,
      content: '<p>Worth noting that A1680 and A1698 are both in play this session. If both advance, we should push for unified implementation guidance — running two different "late registration" workflows depending on timing would create real confusion at the polls. <span data-type="mention" data-id="role:demo-role-1" data-label="County Elections Director">@County Elections Director</span> — should we request a joint hearing?</p>' },

    // A2670 — canvassing early votes (follow-up)
    { id: 'demo-comment-22', externalId: 'legiscan:2099056', userId: 'demo-m8', daysAgo: 7,
      content: '<p>Following up on the results-embargo concern: I spoke with the sponsor\'s office and they\'re open to an amendment. Recommend we propose specific penalty language — that any county employee who discloses pre-canvass results is subject to the same penalty as early ballot disclosure under existing law.</p>' },

    // A548 — county clerk death filing (follow-up)
    { id: 'demo-comment-23', externalId: 'legiscan:2096553', userId: 'demo-m12', daysAgo: 21,
      content: '<p>This aligns with the NVRA data-matching process we already run with the Department of Health. Main question is whether the 30-day reporting timeline in Section 1 is stricter than our current vital records exchange schedule — if so, we\'d need to adjust our data pull frequency.</p>' },

    // A1195 — Voter Convenience Act (follow-up with data)
    { id: 'demo-comment-24', externalId: 'legiscan:2100182', userId: 'demo-m3', daysAgo: 7,
      content: '<p>We pulled our 2024 general election numbers: roughly 8% of voters who showed up at our polling locations were registered in a different precinct. If those voters cast provisional ballots instead of being turned away, that\'s approximately 2,200 additional provisional ballots to adjudicate — a 40% increase over our 2024 provisional total. Real but manageable with adequate staffing.</p>' },

    // Reactions to recent committee action — co-dated with each bill's freshest
    // bill_updated event (below) so the top-of-feed cards show a mix of legislative
    // activity AND member discussion in the same card, not activity alone.
    { id: 'demo-comment-25', externalId: 'legiscan:2098113', userId: 'demo-dir', daysAgo: 2,
      content: '<p>The ACS cleared Appropriations 7-4 this morning. The committee adopted our requested amendment phasing in the automatic registration data feeds — that directly addresses the volume concern Lisa flagged. Next stop is the Assembly floor; recommend we send a formal support letter before second reading.</p>' },
    { id: 'demo-comment-26', externalId: 'legiscan:2099974', userId: 'demo-m1', daysAgo: 4,
      content: '<p>Reported out of State &amp; Local Government 5-1 — strong bipartisan signal. The "or its designee" clarification we asked for made it into the committee version, so the cost-allocation ambiguity on fire district retrieval is resolved. No further amendments needed from our side.</p>' },
    { id: 'demo-comment-27', externalId: 'legiscan:2100182', userId: 'demo-dep', daysAgo: 6,
      content: '<p>The committee substitute narrows the any-polling-place provision to a 3-county pilot for 2026 — exactly the phased rollout we pushed for. <span data-type="mention" data-id="user:demo-dir" data-label="Maria Santos">@Maria Santos</span> this changes our position analysis; the provisional-volume risk is now contained to the pilot counties rather than statewide.</p>' },
    { id: 'demo-comment-28', externalId: 'legiscan:2098535', userId: 'demo-m8', daysAgo: 9,
      content: '<p>Advanced to Appropriations on a 6-2 vote. The fiscal note request we submitted is referenced in the committee statement. If Appropriations funds the temporary staffing line for the final two weeks, our amendment ask is effectively satisfied.</p>' },
  ],

  // Emoji reactions on comments, weighted toward the most recent
  // committee-reaction comments (25-28) so the freshest feed cards show
  // engagement. daysAgo is always at least 1 day after the comment's own
  // daysAgo (a reaction can't precede the comment it's on).
  reactions: [
    // demo-comment-25 (A1715, daysAgo 2) — freshest comment
    { id: 'demo-reaction-1', commentId: 'demo-comment-25', userId: 'demo-dep', emoji: '👍', daysAgo: 1 },
    { id: 'demo-reaction-2', commentId: 'demo-comment-25', userId: 'demo-m5',  emoji: '✅', daysAgo: 1 },
    { id: 'demo-reaction-3', commentId: 'demo-comment-25', userId: 'demo-m1',  emoji: '👀', daysAgo: 1 },
    // demo-comment-26 (A1129, daysAgo 4)
    { id: 'demo-reaction-4', commentId: 'demo-comment-26', userId: 'demo-dir', emoji: '👍', daysAgo: 3 },
    { id: 'demo-reaction-5', commentId: 'demo-comment-26', userId: 'demo-m6',  emoji: '✅', daysAgo: 3 },
    // demo-comment-27 (A1195, daysAgo 6)
    { id: 'demo-reaction-6', commentId: 'demo-comment-27', userId: 'demo-dir', emoji: '👍', daysAgo: 5 },
    { id: 'demo-reaction-7', commentId: 'demo-comment-27', userId: 'demo-m3',  emoji: '👀', daysAgo: 5 },
    // demo-comment-28 (A1680, daysAgo 9)
    { id: 'demo-reaction-8', commentId: 'demo-comment-28', userId: 'demo-m11', emoji: '👍', daysAgo: 8 },
    { id: 'demo-reaction-9', commentId: 'demo-comment-28', userId: 'demo-dep', emoji: '✅', daysAgo: 8 },
    // Older comments — lighter engagement, for realism.
    { id: 'demo-reaction-10', commentId: 'demo-comment-1',  userId: 'demo-m1', emoji: '👍', daysAgo: 59 },
    { id: 'demo-reaction-11', commentId: 'demo-comment-5',  userId: 'demo-dir', emoji: '👍', daysAgo: 29 },
    { id: 'demo-reaction-12', commentId: 'demo-comment-11', userId: 'demo-m3', emoji: '✅', daysAgo: 29 },
    { id: 'demo-reaction-13', commentId: 'demo-comment-14', userId: 'demo-m4', emoji: '👍', daysAgo: 20 },
    { id: 'demo-reaction-14', commentId: 'demo-comment-18', userId: 'demo-m5', emoji: '👍', daysAgo: 59 },
    { id: 'demo-reaction-15', commentId: 'demo-comment-18', userId: 'demo-m7', emoji: '✅', daysAgo: 59 },
    { id: 'demo-reaction-16', commentId: 'demo-comment-24', userId: 'demo-dep', emoji: '👀', daysAgo: 6 },
  ],

  // One row per (comment, notified user).
  //   demo-role-1 members: demo-dir, demo-m2, demo-m8
  //   demo-role-2 members: demo-dep, demo-m3, demo-m5
  //   demo-role-3 members: demo-m1, demo-m6, demo-m10
  mentions: [
    // demo-comment-4: @Michael Brown (demo-m4) mentioned by demo-dep
    { id: 'demo-mention-1', commentId: 'demo-comment-4', userId: 'demo-m4', sourceType: 'user', sourceId: 'demo-m4', daysAgo: 14 },
    // demo-comment-6: @Deputy/Assistant Director (demo-role-2) → demo-dep
    { id: 'demo-mention-2', commentId: 'demo-comment-6', userId: 'demo-dep', sourceType: 'role', sourceId: 'demo-role-2', daysAgo: 30 },
    // demo-comment-10: @Technology & Modernization (demo-role-3) → demo-m1, demo-m6, demo-m10
    { id: 'demo-mention-3', commentId: 'demo-comment-10', userId: 'demo-m1',  sourceType: 'role', sourceId: 'demo-role-3', daysAgo: 14 },
    { id: 'demo-mention-4', commentId: 'demo-comment-10', userId: 'demo-m6',  sourceType: 'role', sourceId: 'demo-role-3', daysAgo: 14 },
    { id: 'demo-mention-5', commentId: 'demo-comment-10', userId: 'demo-m10', sourceType: 'role', sourceId: 'demo-role-3', daysAgo: 14 },
    // demo-comment-13: @James Chen (demo-dep) mentioned by demo-dir
    { id: 'demo-mention-6', commentId: 'demo-comment-13', userId: 'demo-dep', sourceType: 'user', sourceId: 'demo-dep', daysAgo: 7 },
    // demo-comment-21: @County Elections Director (demo-role-1) → demo-dir, demo-m2, demo-m8
    { id: 'demo-mention-7', commentId: 'demo-comment-21', userId: 'demo-dir', sourceType: 'role', sourceId: 'demo-role-1', daysAgo: 14 },
    { id: 'demo-mention-8', commentId: 'demo-comment-21', userId: 'demo-m2',  sourceType: 'role', sourceId: 'demo-role-1', daysAgo: 14 },
    { id: 'demo-mention-9', commentId: 'demo-comment-21', userId: 'demo-m8',  sourceType: 'role', sourceId: 'demo-role-1', daysAgo: 14 },
    // demo-comment-27: @Maria Santos (demo-dir) mentioned by demo-dep
    { id: 'demo-mention-10', commentId: 'demo-comment-27', userId: 'demo-dir', sourceType: 'user', sourceId: 'demo-dir', daysAgo: 6 },
  ],

  // priority_set: { priority }
  // position_set: { position }
  // comment_added: { preview, commentId, mentionedUserIds? }
  // vote_milestone: { message }
  // bill_updated: { changes: ChangeRecord[] } — legislative activity (status changes,
  //   actions, committee votes, amendments). Passive event type, but surfaces in the
  //   feed because every demo bill above carries a priority. Time-offset like the
  //   calendar hearings so fresh legislative activity tops the feed instead of the
  //   feed being all comments. `userId` is 'system' to mirror the real ingestor.
  feedEvents: [
    // Priority set events
    { id: 'demo-fe-p1', type: 'priority_set', externalId: 'legiscan:2099974', userId: 'demo-dir', metadata: { priority: 'high' },   daysAgo: 60 },
    { id: 'demo-fe-p2', type: 'priority_set', externalId: 'legiscan:2100182', userId: 'demo-dir', metadata: { priority: 'high' },   daysAgo: 60 },
    { id: 'demo-fe-p3', type: 'priority_set', externalId: 'legiscan:2098535', userId: 'demo-dir', metadata: { priority: 'high' },   daysAgo: 30 },
    { id: 'demo-fe-p4', type: 'priority_set', externalId: 'legiscan:2096553', userId: 'demo-dir', metadata: { priority: 'low' },    daysAgo: 30 },
    { id: 'demo-fe-p5', type: 'priority_set', externalId: 'legiscan:2096183', userId: 'demo-dep', metadata: { priority: 'medium' }, daysAgo: 21 },
    { id: 'demo-fe-p6', type: 'priority_set', externalId: 'legiscan:2098630', userId: 'demo-dep', metadata: { priority: 'medium' }, daysAgo: 21 },
    { id: 'demo-fe-p7', type: 'priority_set', externalId: 'legiscan:2099056', userId: 'demo-dep', metadata: { priority: 'medium' }, daysAgo: 21 },
    { id: 'demo-fe-p8', type: 'priority_set', externalId: 'legiscan:2098113', userId: 'demo-dir', metadata: { priority: 'high' },   daysAgo: 60 },

    // Official position set events
    { id: 'demo-fe-o1', type: 'position_set', externalId: 'legiscan:2099974', userId: 'demo-dir', metadata: { position: 'Support' }, daysAgo: 60 },
    { id: 'demo-fe-o2', type: 'position_set', externalId: 'legiscan:2100182', userId: 'demo-dir', metadata: { position: 'Support' }, daysAgo: 60 },
    { id: 'demo-fe-o3', type: 'position_set', externalId: 'legiscan:2098535', userId: 'demo-dir', metadata: { position: 'Amend' },   daysAgo: 30 },
    { id: 'demo-fe-o4', type: 'position_set', externalId: 'legiscan:2098630', userId: 'demo-dep', metadata: { position: 'Monitor' }, daysAgo: 21 },
    { id: 'demo-fe-o5', type: 'position_set', externalId: 'legiscan:2096183', userId: 'demo-dep', metadata: { position: 'Support' }, daysAgo: 21 },
    { id: 'demo-fe-o6', type: 'position_set', externalId: 'legiscan:2098113', userId: 'demo-dir', metadata: { position: 'Support' }, daysAgo: 60 },

    // Vote milestones
    { id: 'demo-fe-v1', type: 'vote_milestone', externalId: 'legiscan:2099974', userId: 'demo-m6',  metadata: { message: '7 members have voted on this bill' }, daysAgo: 14 },
    { id: 'demo-fe-v2', type: 'vote_milestone', externalId: 'legiscan:2100182', userId: 'demo-m9',  metadata: { message: '5 members have voted on this bill' }, daysAgo: 14 },
    { id: 'demo-fe-v3', type: 'vote_milestone', externalId: 'legiscan:2098113', userId: 'demo-m11', metadata: { message: '4 members have voted on this bill' }, daysAgo: 21 },
    { id: 'demo-fe-v4', type: 'vote_milestone', externalId: 'legiscan:2098630', userId: 'demo-m9',  metadata: { message: '3 members have voted on this bill' }, daysAgo: 14 },

    // Comment added — most recent comment per bill
    { id: 'demo-fe-c1', type: 'comment_added', externalId: 'legiscan:2099974', userId: 'demo-dep', daysAgo: 14,
      metadata: { preview: 'Michael Brown — good catch. I\'d suggest we request a clarifying amendment: "county board of elections or its designee."', commentId: 'demo-comment-4', mentionedUserIds: ['demo-m4'] } },
    { id: 'demo-fe-c2', type: 'comment_added', externalId: 'legiscan:2100182', userId: 'demo-dir', daysAgo: 30,
      metadata: { preview: 'Good catch. Deputy/Assistant Director can you model the provisional ballot volume increase based on our 2024 general election data?', commentId: 'demo-comment-6', mentionedUserIds: ['demo-dep'] } },
    { id: 'demo-fe-c3', type: 'comment_added', externalId: 'legiscan:2098535', userId: 'demo-m8', daysAgo: 14,
      metadata: { preview: 'Technology & Modernization — can you pull our average registration processing time for the last 30 days of the 2024 cycle?', commentId: 'demo-comment-10', mentionedUserIds: ['demo-m1', 'demo-m6', 'demo-m10'] } },
    { id: 'demo-fe-c4', type: 'comment_added', externalId: 'legiscan:2096183', userId: 'demo-dir', daysAgo: 7,
      metadata: { preview: 'James Chen — can you reach out to the Division of Elections to clarify whether county procurement falls under the state contract?', commentId: 'demo-comment-13', mentionedUserIds: ['demo-dep'] } },
    { id: 'demo-fe-c5', type: 'comment_added', externalId: 'legiscan:2099056', userId: 'demo-m4', daysAgo: 14,
      metadata: { preview: 'The operational upside is real — finishing the canvass post-election currently takes our office 3–4 days. Pre-canvassing early votes would cut that significantly.', commentId: 'demo-comment-15' } },
    { id: 'demo-fe-c6', type: 'comment_added', externalId: 'legiscan:2096553', userId: 'demo-dir', daysAgo: 14,
      metadata: { preview: 'Low operational impact for us, but meaningful for list accuracy. I\'d suggest we support.', commentId: 'demo-comment-17' } },
    { id: 'demo-fe-c7', type: 'comment_added', externalId: 'legiscan:2098113', userId: 'demo-m5', daysAgo: 30,
      metadata: { preview: 'The automatic registration provision will be the heaviest lift. In 2024 our county processed about 4,000 DMV-initiated registrations — under this bill that could double or triple.', commentId: 'demo-comment-19' } },
    { id: 'demo-fe-c8', type: 'comment_added', externalId: 'legiscan:2098630', userId: 'demo-dep', daysAgo: 14,
      metadata: { preview: 'A1680 and A1698 are both in play this session. If both advance, we should push for unified implementation guidance.', commentId: 'demo-comment-21', mentionedUserIds: ['demo-dir', 'demo-m2', 'demo-m8'] } },
    { id: 'demo-fe-c9', type: 'comment_added', externalId: 'legiscan:2099056', userId: 'demo-m8', daysAgo: 7,
      metadata: { preview: 'The sponsor\'s office is open to an amendment — recommend we propose specific penalty language for the results-embargo enforcement.', commentId: 'demo-comment-22' } },
    { id: 'demo-fe-c10', type: 'comment_added', externalId: 'legiscan:2100182', userId: 'demo-m3', daysAgo: 7,
      metadata: { preview: 'We pulled our 2024 numbers: roughly 8% of voters were registered in a different precinct — approximately 2,200 additional provisional ballots, a 40% increase over 2024.', commentId: 'demo-comment-24' } },
    // Recent committee-reaction comments, co-dated with the freshest bill_updated
    // events below so the top feed cards mix activity with discussion.
    { id: 'demo-fe-c11', type: 'comment_added', externalId: 'legiscan:2098113', userId: 'demo-dir', daysAgo: 2,
      metadata: { preview: 'The ACS cleared Appropriations 7-4 this morning. The committee adopted our requested amendment phasing in the automatic registration data feeds.', commentId: 'demo-comment-25' } },
    { id: 'demo-fe-c12', type: 'comment_added', externalId: 'legiscan:2099974', userId: 'demo-m1', daysAgo: 4,
      metadata: { preview: 'Reported out of State & Local Government 5-1 — the "or its designee" clarification we asked for made it into the committee version.', commentId: 'demo-comment-26' } },
    { id: 'demo-fe-c13', type: 'comment_added', externalId: 'legiscan:2100182', userId: 'demo-dep', daysAgo: 6,
      metadata: { preview: 'The committee substitute narrows the any-polling-place provision to a 3-county pilot for 2026 — exactly the phased rollout we pushed for.', commentId: 'demo-comment-27', mentionedUserIds: ['demo-dir'] } },
    { id: 'demo-fe-c14', type: 'comment_added', externalId: 'legiscan:2098535', userId: 'demo-m8', daysAgo: 9,
      metadata: { preview: 'Advanced to Appropriations on a 6-2 vote. If Appropriations funds the temporary staffing line, our amendment ask is effectively satisfied.', commentId: 'demo-comment-28' } },

    // Bill activity (bill_updated) — legislative lifecycle spread across the recent
    // window. Recent updates on the high/medium-priority bills keep the top of the
    // feed showing legislative movement, not just comments.
    // A1715 — John R. Lewis Act (flagship, most active)
    { id: 'demo-fe-u1', type: 'bill_updated', externalId: 'legiscan:2098113', userId: 'system', daysAgo: 2, metadata: { changes: [
      chg('status_change', { oldValue: 'In Committee', newValue: 'Reported - Assembly Floor' }),
      chg('action_added', { newValue: 'Reported out of Assembly Appropriations Committee with amendments, 2nd Reading' }),
      chg('vote_added', { detail: 'Assembly Appropriations Cmte: 7-4' }),
      chg('amendment_added', { detail: 'Assembly Committee Substitute (ACS) adopted' }),
    ] } },
    { id: 'demo-fe-u2', type: 'bill_updated', externalId: 'legiscan:2098113', userId: 'system', daysAgo: 14, metadata: { changes: [
      chg('action_added', { newValue: 'Public hearing held — Assembly Appropriations Committee' }),
    ] } },
    { id: 'demo-fe-u3', type: 'bill_updated', externalId: 'legiscan:2098113', userId: 'system', daysAgo: 30, metadata: { changes: [
      chg('status_change', { oldValue: 'Introduced', newValue: 'In Committee' }),
      chg('action_added', { newValue: 'Referred to Assembly Appropriations Committee' }),
    ] } },

    // A1129 — ballot drop boxes
    { id: 'demo-fe-u4', type: 'bill_updated', externalId: 'legiscan:2099974', userId: 'system', daysAgo: 4, metadata: { changes: [
      chg('status_change', { oldValue: 'In Committee', newValue: 'Reported - Assembly Floor' }),
      chg('action_added', { newValue: 'Reported out of Assembly State & Local Government Committee, 2nd Reading' }),
      chg('vote_added', { detail: 'Assembly State & Local Gov Cmte: 5-1' }),
    ] } },
    { id: 'demo-fe-u5', type: 'bill_updated', externalId: 'legiscan:2099974', userId: 'system', daysAgo: 21, metadata: { changes: [
      chg('action_added', { newValue: 'Hearing held in Assembly State & Local Government Committee' }),
    ] } },

    // A1195 — Voter Convenience Act
    { id: 'demo-fe-u6', type: 'bill_updated', externalId: 'legiscan:2100182', userId: 'system', daysAgo: 6, metadata: { changes: [
      chg('amendment_added', { detail: 'Assembly Committee Substitute (ACS) reported' }),
      chg('action_added', { newValue: 'Substituted by Assembly Committee Substitute' }),
    ] } },
    { id: 'demo-fe-u7', type: 'bill_updated', externalId: 'legiscan:2100182', userId: 'system', daysAgo: 14, metadata: { changes: [
      chg('action_added', { newValue: 'Referred to Assembly Judiciary Committee' }),
    ] } },

    // A1680 — voter registration 14 days
    { id: 'demo-fe-u8', type: 'bill_updated', externalId: 'legiscan:2098535', userId: 'system', daysAgo: 9, metadata: { changes: [
      chg('action_added', { newValue: 'Reported and referred to Assembly Appropriations Committee' }),
      chg('vote_added', { detail: 'Assembly State Government Cmte: 6-2' }),
    ] } },
    { id: 'demo-fe-u9', type: 'bill_updated', externalId: 'legiscan:2098535', userId: 'system', daysAgo: 30, metadata: { changes: [
      chg('status_change', { oldValue: 'Introduced', newValue: 'In Committee' }),
    ] } },

    // A251 — voting machines
    { id: 'demo-fe-u10', type: 'bill_updated', externalId: 'legiscan:2096183', userId: 'system', daysAgo: 11, metadata: { changes: [
      chg('action_added', { newValue: 'Reported out of committee, 2nd Reading' }),
      chg('vote_added', { detail: 'Assembly State & Local Gov Cmte: 4-3' }),
    ] } },
    { id: 'demo-fe-u11', type: 'bill_updated', externalId: 'legiscan:2096183', userId: 'system', daysAgo: 30, metadata: { changes: [
      chg('action_added', { newValue: 'Introduced, referred to Assembly State & Local Government Committee' }),
    ] } },

    // A2670 — canvassing early votes
    { id: 'demo-fe-u12', type: 'bill_updated', externalId: 'legiscan:2099056', userId: 'system', daysAgo: 14, metadata: { changes: [
      chg('action_added', { newValue: 'Reported from Assembly Judiciary Committee with amendments' }),
      chg('amendment_added', { detail: 'Committee amendments adopted' }),
    ] } },
    { id: 'demo-fe-u13', type: 'bill_updated', externalId: 'legiscan:2099056', userId: 'system', daysAgo: 21, metadata: { changes: [
      chg('action_added', { newValue: 'Referred to Assembly Judiciary Committee' }),
    ] } },

    // A1698 — same-day voter registration
    { id: 'demo-fe-u14', type: 'bill_updated', externalId: 'legiscan:2098630', userId: 'system', daysAgo: 14, metadata: { changes: [
      chg('status_change', { oldValue: 'Introduced', newValue: 'In Committee' }),
      chg('action_added', { newValue: 'Hearing scheduled — Assembly State & Local Government Committee' }),
    ] } },

    // A548 — county clerk death filing
    { id: 'demo-fe-u15', type: 'bill_updated', externalId: 'legiscan:2096553', userId: 'system', daysAgo: 21, metadata: { changes: [
      chg('action_added', { newValue: 'Introduced, referred to Assembly State & Local Government Committee' }),
    ] } },
  ],

  // Spread across bills so filtering produces results.
  customFieldValues: [
    // Fiscal Impact (demo-cf-1) on 5 bills
    { externalId: 'legiscan:2099974', fieldId: 'demo-cf-1', value: 'Minimal (<$10K)',        setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2100182', fieldId: 'demo-cf-1', value: 'Significant (>$100K)',   setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2098535', fieldId: 'demo-cf-1', value: 'Minimal (<$10K)',        setBy: 'demo-dir', daysAgo: 30 },
    { externalId: 'legiscan:2096183', fieldId: 'demo-cf-1', value: 'Significant (>$100K)',   setBy: 'demo-dep', daysAgo: 21 },
    { externalId: 'legiscan:2099056', fieldId: 'demo-cf-1', value: 'Moderate ($10K-$100K)',  setBy: 'demo-dep', daysAgo: 21 },
    // Committee Assignment (demo-cf-2) on 5 bills
    { externalId: 'legiscan:2099974', fieldId: 'demo-cf-2', value: 'Voter Access',        setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2100182', fieldId: 'demo-cf-2', value: 'Voter Access',        setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2098535', fieldId: 'demo-cf-2', value: 'Legislative Affairs', setBy: 'demo-m6',  daysAgo: 30 },
    { externalId: 'legiscan:2096183', fieldId: 'demo-cf-2', value: 'Technology',          setBy: 'demo-dep', daysAgo: 21 },
    { externalId: 'legiscan:2099056', fieldId: 'demo-cf-2', value: 'Legislative Affairs', setBy: 'demo-dep', daysAgo: 30 },
    // Association Concerns (demo-cf-3, pinned) — rich text on 3 bills
    { externalId: 'legiscan:2099974', fieldId: 'demo-cf-3', setBy: 'demo-dir', daysAgo: 60,
      value: '<p><strong>Key concern: cost allocation for fire district elections.</strong> Section 3 requires county boards to maintain drop boxes, but is silent on which entity bears retrieval costs when a municipality administers the fire district election. We\'ve requested a clarifying amendment — "county board of elections or its designee" — to allow cost delegation to municipal clerks.</p><ul><li>Chain of custody requirements align with existing municipal protocols — no new infrastructure needed</li><li>Amendment request submitted to sponsor\'s office; response pending</li></ul>' },
    { externalId: 'legiscan:2100182', fieldId: 'demo-cf-3', setBy: 'demo-dir', daysAgo: 60,
      value: '<p><strong>Significant operational lift — position pending impact analysis.</strong> Any-polling-place voting converts every polling site into a provisional ballot processing center for the full county.</p><ul><li>Provisional ballot volume modeling underway based on 2024 general election data</li><li>Poll worker training will need to be redesigned before rollout</li><li>Post-election adjudication window tightens with a larger provisional pool</li></ul>' },
    { externalId: 'legiscan:2096183', fieldId: 'demo-cf-3', setBy: 'demo-dir', daysAgo: 30,
      value: '<p><strong>Support the paper audit trail requirement; procurement timeline is the critical risk.</strong> State procurement realistically takes 18–24 months from RFP to delivery. Counties need authorization to begin in 2026 to meet the 2028 deadline.</p><ul><li>Amendment needed: authorize counties to initiate procurement in 2026, not contingent on bill enactment date</li><li>Paper record retention period unspecified — recommend 22-month minimum to cover post-election audit windows</li></ul>' },
    // Implementation Deadline (demo-cf-4) on 3 bills
    { externalId: 'legiscan:2099974', fieldId: 'demo-cf-4', value: '2026-11-01', setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2096183', fieldId: 'demo-cf-4', value: '2028-01-01', setBy: 'demo-m6',  daysAgo: 30 },
    { externalId: 'legiscan:2098535', fieldId: 'demo-cf-4', value: '2026-09-01', setBy: 'demo-dep', daysAgo: 21 },
    // Fiscal Impact + Committee for A1715 and A1698
    { externalId: 'legiscan:2098113', fieldId: 'demo-cf-1', value: 'Significant (>$100K)',  setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2098113', fieldId: 'demo-cf-2', value: 'Legislative Affairs',   setBy: 'demo-dir', daysAgo: 60 },
    { externalId: 'legiscan:2098630', fieldId: 'demo-cf-1', value: 'Moderate ($10K-$100K)', setBy: 'demo-dep', daysAgo: 21 },
    { externalId: 'legiscan:2098630', fieldId: 'demo-cf-2', value: 'Voter Access',          setBy: 'demo-dep', daysAgo: 21 },
    // Testimony Submitted (demo-cf-5) on 2 bills — binary fields store '1' for checked, no row for unchecked
    { externalId: 'legiscan:2099974', fieldId: 'demo-cf-5', value: '1', setBy: 'demo-dir', daysAgo: 30 },
    { externalId: 'legiscan:2100182', fieldId: 'demo-cf-5', value: '1', setBy: 'demo-dir', daysAgo: 30 },
  ],

  // Personal notes for demo-user.
  notes: [
    { id: 'demo-note-1', externalId: 'legiscan:2099974', daysAgo: 60, content: 'Review chain of custody language in Section 3 before committee hearing — clarify who bears cost for fire district drop box retrieval' },
    { id: 'demo-note-2', externalId: 'legiscan:2100182', daysAgo: 30, content: 'Get provisional ballot volume estimate from James before Senate committee hearing' },
    { id: 'demo-note-3', externalId: 'legiscan:2098535', daysAgo: 21, content: 'Pull 2024 cycle registration data for the final 30 days — needed to assess 14-day window feasibility' },
    { id: 'demo-note-4', externalId: 'legiscan:2096183', daysAgo: 14, content: 'Confirm with Division of Elections whether county procurement is under state contract or independent bid — changes the 2028 timeline analysis' },
    { id: 'demo-note-5', externalId: 'legiscan:2099056', daysAgo: 7,  content: 'Request sponsor briefing — focus on results-embargo enforcement mechanism in Section 2 and chain of custody during pre-canvass period' },
    { id: 'demo-note-6', externalId: 'legiscan:2096553', daysAgo: 30, content: 'Low impact operationally — flag for county counsel to review the death-reporting timeline in Section 1' },
    { id: 'demo-note-7', externalId: 'legiscan:2098113', daysAgo: 60, content: 'Monitor committee hearings — highest-profile bill this session. Sponsor briefing requested; coordinate with Maria on implementation working group.' },
    { id: 'demo-note-8', externalId: 'legiscan:2098630', daysAgo: 21, content: 'Compare with A1680 — both touch late registration; may need coordinated testimony if both advance. Ask James to map the workflow differences.' },
  ],

  // Hearings tie to the priority bills above (the calendar only renders hearing rows
  // whose bill has a priority). Custom events are team-created flavor; some
  // bill-linked, some not.
  calendarEvents: [
    { id: 'demo-hearing-1', externalId: 'legiscan:2099974', source: 'hearing', offsetDays: 2,  time: '10:00:00', location: 'State House Annex, Committee Room 11, Trenton', description: 'Assembly State & Local Government Committee — hearing' },
    { id: 'demo-hearing-2', externalId: 'legiscan:2100182', source: 'hearing', offsetDays: 6,  time: '13:30:00', location: 'State House Annex, Committee Room 9, Trenton',  description: 'Assembly Judiciary Committee — hearing' },
    { id: 'demo-hearing-3', externalId: 'legiscan:2098535', source: 'hearing', offsetDays: 13, time: '10:00:00', location: 'State House Annex, Committee Room 4, Trenton',  description: 'Senate State Government Committee — hearing' },
    { id: 'demo-hearing-4', externalId: 'legiscan:2098113', source: 'hearing', offsetDays: 18, time: '14:00:00', location: 'State House, Committee Room 6, Trenton',        description: 'Assembly Appropriations Committee — hearing' },
    { id: 'demo-hearing-5', externalId: 'legiscan:2096183', source: 'hearing', offsetDays: 27, time: '11:00:00', location: 'State House Annex, Committee Room 11, Trenton', description: 'Assembly State & Local Government Committee — hearing' },

    { id: 'demo-event-1', externalId: null,               source: 'custom', offsetDays: -4, time: null,       location: 'Zoom',             description: 'Monthly membership call' },
    { id: 'demo-event-2', externalId: 'legiscan:2099974', source: 'custom', offsetDays: 4,  time: '17:00:00', location: null,               description: 'Testimony deadline — A1129 (drop boxes)' },
    { id: 'demo-event-3', externalId: 'legiscan:2100182', source: 'custom', offsetDays: 11, time: '17:00:00', location: null,               description: 'Comment period closes — A1195 rules' },
    { id: 'demo-event-4', externalId: null,               source: 'custom', offsetDays: 20, time: '09:00:00', location: 'Trenton Marriott', description: 'NJ County Clerks Association — spring conference' },
    { id: 'demo-event-5', externalId: null,               source: 'custom', offsetDays: 25, time: '14:00:00', location: 'Zoom',             description: 'Legislative strategy working group' },
  ],
}
