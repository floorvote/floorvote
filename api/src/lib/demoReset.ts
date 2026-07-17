import { NJ_COUNTY_CLERKS } from '../config/associations/nj-county-clerks'

export async function runDemoReset(db: D1Database): Promise<void> {
  // Step 1: Truncate engagement tables (order respects FK constraints)
  await db.batch([
    db.prepare('DELETE FROM comment_reactions'),
    db.prepare('DELETE FROM comment_mentions'),  // must come before comments (no FK cascade on this table)
    db.prepare('DELETE FROM comments'),
    db.prepare('DELETE FROM member_votes'),
    db.prepare('DELETE FROM official_positions'),
    db.prepare('DELETE FROM notes'),
    db.prepare('DELETE FROM feed_events'),
    db.prepare('DELETE FROM bill_custom_field_values'),
    // calendar_event_bills.event_id REFERENCES calendar_events(id) with NO
    // cascade (migration 0045), so the join rows must be cleared BEFORE the
    // events they point at — otherwise DELETE FROM calendar_events fails the FK
    // and rolls back the whole reset (the bug that froze demo data 2026-06-04).
    db.prepare('DELETE FROM calendar_event_bills'),
    db.prepare('DELETE FROM calendar_events'),
  ])

  // Step 2: Reset static data — users, roles, user_roles, custom fields
  // Runs with FK checks disabled so INSERT OR REPLACE on parent tables is safe
  await db.prepare('PRAGMA foreign_keys = OFF').run()

  // Canonical seed users — NJ county/municipal clerks (fictional names, real NJ county names)
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-user','demo@example.com','Demo Admin','admin','County Clerk · Harborview County, NJ',datetime('now','-90 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-dir','maria@demo.example','Maria Santos','admin','Director of Elections · Stonegate County, NJ',datetime('now','-90 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-dep','james@demo.example','James Chen','admin','Deputy Clerk · Cedarbrook County, NJ',datetime('now','-85 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m1','sarah@demo.example','Sarah Mitchell','member','County Clerk · Millbrook County, NJ',datetime('now','-80 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m2','david@demo.example','David Park','member','County Clerk · Clearwater County, NJ',datetime('now','-75 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m3','rachel@demo.example','Rachel Torres','member','County Clerk · Ridgecrest County, NJ',datetime('now','-70 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m4','michael@demo.example','Michael Brown','member','County Clerk · Elmhurst County, NJ',datetime('now','-65 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m5','lisa@demo.example','Lisa Nguyen','member','County Clerk · Brookfield County, NJ',datetime('now','-60 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m6','robert@demo.example','Robert Kim','member','County Clerk · Northhaven County, NJ',datetime('now','-55 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m7','amanda@demo.example','Amanda Foster','member','County Clerk · Fairhaven County, NJ',datetime('now','-50 days'),0)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m8','thomas@demo.example','Thomas Wright','member','County Clerk · Lakeshire County, NJ',datetime('now','-45 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m9','jennifer@demo.example','Jennifer Adams','member','County Clerk · Maplewood County, NJ',datetime('now','-40 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m10','kevin@demo.example','Kevin O''Brien','member','County Clerk · Pinecrest County, NJ',datetime('now','-35 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m11','patricia@demo.example','Patricia Reeves','member','County Clerk · Ashwood County, NJ',datetime('now','-30 days'),1)`),
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES ('demo-m12','daniel@demo.example','Daniel Vega','member','County Clerk · Willowbrook County, NJ',datetime('now','-25 days'),1)`),
  ])

  // Canonical roles
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO roles (id, name) VALUES ('demo-role-1','County Elections Director')`),
    db.prepare(`INSERT OR REPLACE INTO roles (id, name) VALUES ('demo-role-2','Deputy/Assistant Director')`),
    db.prepare(`INSERT OR REPLACE INTO roles (id, name) VALUES ('demo-role-3','Technology & Modernization')`),
    db.prepare(`INSERT OR REPLACE INTO roles (id, name) VALUES ('demo-role-4','Voter Access & Outreach')`),
    db.prepare(`INSERT OR REPLACE INTO roles (id, name) VALUES ('demo-role-5','Training & Certification')`),
  ])

  // Delete any non-seed roles added during demo
  await db.prepare(`DELETE FROM roles WHERE id NOT IN ('demo-role-1','demo-role-2','demo-role-3','demo-role-4','demo-role-5')`).run()

  // Reset user_roles to canonical assignments (wipe and re-insert)
  await db.prepare('DELETE FROM user_roles').run()
  await db.batch([
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-dir','demo-role-1')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m2','demo-role-1')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m8','demo-role-1')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-dep','demo-role-2')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m3','demo-role-2')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m5','demo-role-2')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m1','demo-role-3')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m6','demo-role-3')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m10','demo-role-3')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m4','demo-role-4')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m7','demo-role-4')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m12','demo-role-4')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m9','demo-role-5')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m11','demo-role-5')`),
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES ('demo-m4','demo-role-5')`),
  ])

  // Canonical custom field definitions
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO custom_field_definitions (id, name, slug, type, options, display_order) VALUES ('demo-cf-1','Fiscal Impact','fiscal-impact','dropdown','["No Impact","Minimal (<$10K)","Moderate ($10K-$100K)","Significant (>$100K)","Unknown"]',1)`),
    db.prepare(`INSERT OR REPLACE INTO custom_field_definitions (id, name, slug, type, options, display_order) VALUES ('demo-cf-2','Committee Assignment','committee','dropdown','["Voter Access","Technology","Training","Legislative Affairs","Budget"]',2)`),
    db.prepare(`INSERT OR REPLACE INTO custom_field_definitions (id, name, slug, type, options, display_order, pinned) VALUES ('demo-cf-3','Association Concerns','association-concerns','text',NULL,3,1)`),
    db.prepare(`INSERT OR REPLACE INTO custom_field_definitions (id, name, slug, type, options, display_order) VALUES ('demo-cf-4','Implementation Deadline','impl-deadline','date',NULL,4)`),
    db.prepare(`INSERT OR REPLACE INTO custom_field_definitions (id, name, slug, type, options, display_order) VALUES ('demo-cf-5','Testimony Submitted','testimony','binary',NULL,5)`),
  ])
  // Remove any custom fields added during demo
  await db.prepare(`DELETE FROM custom_field_definitions WHERE id NOT IN ('demo-cf-1','demo-cf-2','demo-cf-3','demo-cf-4','demo-cf-5')`).run()

  // Canonical association config — pulled from NJ_COUNTY_CLERKS config object
  const tagTaxonomy = JSON.stringify(NJ_COUNTY_CLERKS.tagTaxonomy)
  const keywords = JSON.stringify(NJ_COUNTY_CLERKS.keywords)
  const aiContext = NJ_COUNTY_CLERKS.aiContext
  const positionVocabulary = JSON.stringify(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
  await db.batch([
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('association_name', ?)`).bind(JSON.stringify(`Demo — ${NJ_COUNTY_CLERKS.name}`)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('instance_preset', 'election_officials')`),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('ai_context', ?)`).bind(aiContext),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('relevance_question', ?)`).bind(NJ_COUNTY_CLERKS.relevanceQuestion),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('tag_taxonomy', ?)`).bind(tagTaxonomy),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('keywords', ?)`).bind(keywords),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('position_vocabulary', ?)`).bind(positionVocabulary),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('org_noun', ?)`).bind(JSON.stringify('association')),
    // Start the demo with optional widgets OFF so visitors can experience
    // enabling them in Settings → Modules (toggling modules is allowed in demo
    // mode; all other config stays locked). Nightly reset returns them to off.
    // email-digest is shown ON but read-only (the toggle is disabled in demo and
    // runDigest hard-stops before sending), so demo visitors see the configured
    // state without any email actually going out.
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('modules', ?)`).bind(JSON.stringify({ 'waiting-for-vote': false, 'upcoming-hearings': false, 'calendar': true, 'email-digest': { enabled: true, settings: { frequency: 'daily', weeklyDay: '1' } } })),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('sessions', ?)`).bind(JSON.stringify({
      data: [
        { identifier: '2250', name: '2026-2027 Regular Session', classification: 'primary', startDate: '2026-01-01', endDate: '2027-12-31' },
      ],
      cachedAt: new Date().toISOString(), // ts-write-ok: cache metadata inside a JSON config blob, never SQL-sorted
    })),
  ])

  await db.prepare('PRAGMA foreign_keys = ON').run()

  // Step 3: Delete non-seed users and their sessions
  const seedUserIds = [
    'demo-user', 'demo-dir', 'demo-dep',
    'demo-m1', 'demo-m2', 'demo-m3', 'demo-m4', 'demo-m5',
    'demo-m6', 'demo-m7', 'demo-m8', 'demo-m9', 'demo-m10',
    'demo-m11', 'demo-m12',
  ]
  const placeholders = seedUserIds.map(() => '?').join(',')
  await db.batch([
    db.prepare(`DELETE FROM sessions WHERE user_id NOT IN (${placeholders})`).bind(...seedUserIds),
    db.prepare(`DELETE FROM users WHERE id NOT IN (${placeholders})`).bind(...seedUserIds),
  ])

  // Step 4: Re-seed engagement data
  // Bills (NJ 2026-2027 session — LegiScan external_id format is "legiscan:{bill_id}"):
  //   legiscan:2099974 = A1129  ballot drop boxes for fire district elections
  //   legiscan:2100182 = A1195  Voter Convenience Act — vote at any polling place
  //   legiscan:2098535 = A1680  voter registration up to 14 days before election
  //   legiscan:2098630 = A1698  same-day voter registration at polling place / early voting
  //   legiscan:2096183 = A251   new voting machines with paper audit trail
  //   legiscan:2099056 = A2670  county board of elections canvassing early votes
  //   legiscan:2096553 = A548   county clerk death filing + voter registration
  // These feed stored created_at/updated_at columns (official_positions,
  // member_votes, comments, feed_events), so they must be SQLite space format.
  const toDbTs = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
  const now = toDbTs(Date.now())
  const sixWeeksAgo = toDbTs(Date.now() - 42 * 24 * 60 * 60 * 1000)
  const twoMonthsAgo = toDbTs(Date.now() - 60 * 24 * 60 * 60 * 1000)
  const oneMonthAgo = toDbTs(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const threeWeeksAgo = toDbTs(Date.now() - 21 * 24 * 60 * 60 * 1000)
  const twoWeeksAgo = toDbTs(Date.now() - 14 * 24 * 60 * 60 * 1000)
  const oneWeekAgo = toDbTs(Date.now() - 7 * 24 * 60 * 60 * 1000)

  // Step 3b: Seed an active login session for every demo persona.
  // The sidebar member count and the @everyone/@role mention lists only count
  // users that have a session row (the "exclude invite-pending users" rule in
  // stats.ts / users.ts), and the admin dashboard's active_members_7d/_30d are
  // derived from sessions.last_active. Demo personas never sign in via magic
  // link, so without these rows the app reports "1 member" despite the full
  // seeded roster. Staggered last_active values give a realistic active curve:
  // 11 personas active within 7 days, the rest within 30.
  const daysAgo = (n: number) => toDbTs(Date.now() - n * 24 * 60 * 60 * 1000)
  const sessionExpires = toDbTs(Date.now() + 30 * 24 * 60 * 60 * 1000)
  const personaLastActive: Array<[string, string]> = [
    ['demo-user', now], ['demo-dir', now], ['demo-dep', daysAgo(1)],
    ['demo-m1', daysAgo(1)], ['demo-m2', daysAgo(2)], ['demo-m3', daysAgo(2)],
    ['demo-m4', daysAgo(3)], ['demo-m5', daysAgo(4)], ['demo-m6', daysAgo(5)],
    ['demo-m7', daysAgo(6)], ['demo-m8', daysAgo(6)],
    ['demo-m9', daysAgo(10)], ['demo-m10', daysAgo(14)],
    ['demo-m11', daysAgo(20)], ['demo-m12', daysAgo(28)],
  ]
  await db.batch(
    personaLastActive.map(([uid, lastActive]) =>
      db.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, token_hash, expires_at, last_active) VALUES (?, ?, ?, ?, ?)`)
        .bind(`demo-sess-${uid}`, uid, `demo-token-${uid}`, sessionExpires, lastActive),
    ),
  )

  // Step 3c: Seed a *used* magic link per persona so they count as accepted
  // members. The sidebar member count (stats.ts) counts users who accepted their
  // invite — `magic_links.used_at IS NOT NULL` — not users with a live session
  // row. Demo personas never run the magic-link flow, so without these rows the
  // sidebar reports "0 members" even though the Members page lists the full
  // roster. used_at is set to each persona's last_active for a realistic curve.
  await db.batch(
    personaLastActive.map(([uid, lastActive]) =>
      db.prepare(`INSERT OR REPLACE INTO magic_links (id, user_id, token_hash, expires_at, used_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(`demo-ml-${uid}`, uid, `demo-mltoken-${uid}`, sessionExpires, lastActive),
    ),
  )

  // Bill priorities
  const priorities: Array<[string, string]> = [
    ['legiscan:2099974', 'high'],    // A1129 — ballot drop boxes
    ['legiscan:2100182', 'high'],    // A1195 — Voter Convenience Act
    ['legiscan:2098535', 'high'],    // A1680 — voter registration 14 days
    ['legiscan:2098113', 'high'],    // A1715 — John R. Lewis Voter Empowerment Act
    ['legiscan:2098630', 'medium'],  // A1698 — same-day voter registration
    ['legiscan:2096183', 'medium'],  // A251  — voting machines
    ['legiscan:2099056', 'medium'],  // A2670 — canvassing early votes
    ['legiscan:2096553', 'low'],     // A548  — county clerk death filing
  ]
  const priorityExtIds = priorities.map(([extId]) => extId)
  const priorityPlaceholders = priorityExtIds.map(() => '?').join(',')
  await db.batch([
    ...priorities.map(([extId, priority]) =>
      db.prepare(`UPDATE bills SET priority = ? WHERE external_id = ?`).bind(priority, extId),
    ),
    db.prepare(`UPDATE bills SET priority = NULL WHERE external_id NOT IN (${priorityPlaceholders})`).bind(...priorityExtIds),
  ])

  // Official positions
  // [id, extId, position, set_by, createdAt]
  const positions: Array<[string, string, string, string, string]> = [
    ['demo-pos-1', 'legiscan:2099974', 'Support', 'demo-dir', twoMonthsAgo],  // A1129 — drop boxes
    ['demo-pos-2', 'legiscan:2100182', 'Support', 'demo-dir', twoMonthsAgo],  // A1195 — Voter Convenience Act
    ['demo-pos-3', 'legiscan:2098535', 'Amend',   'demo-dir', oneMonthAgo],   // A1680 — voter reg 14 days
    ['demo-pos-4', 'legiscan:2098630', 'Monitor', 'demo-dep', threeWeeksAgo], // A1698 — same-day reg
    ['demo-pos-5', 'legiscan:2096183', 'Support', 'demo-dep', threeWeeksAgo], // A251  — voting machines
    ['demo-pos-6', 'legiscan:2098113', 'Support', 'demo-dir', twoMonthsAgo],  // A1715 — John R. Lewis Act
  ]
  await db.batch(positions.map(([id, extId, position, setBy, createdAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO official_positions (id, bill_id, position, set_by, created_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(id, extId, position, setBy, createdAt, extId),
  ))

  // Member votes spread across several bills
  // [id, extId, userId, position, createdAt]
  const votes: Array<[string, string, string, string, string]> = [
    // A1129 — ballot drop boxes: broad member engagement
    ['demo-vote-1',  'legiscan:2099974', 'demo-user', 'support',  twoMonthsAgo],
    ['demo-vote-2',  'legiscan:2099974', 'demo-m1',   'support',  twoMonthsAgo],
    ['demo-vote-3',  'legiscan:2099974', 'demo-m2',   'support',  twoMonthsAgo],
    ['demo-vote-4',  'legiscan:2099974', 'demo-m3',   'support',  oneMonthAgo],
    ['demo-vote-5',  'legiscan:2099974', 'demo-m4',   'neutral',  oneMonthAgo],
    ['demo-vote-6',  'legiscan:2099974', 'demo-m5',   'support',  twoWeeksAgo],
    ['demo-vote-7',  'legiscan:2099974', 'demo-m6',   'support',  twoWeeksAgo],
    // A1195 — Voter Convenience Act
    ['demo-vote-8',  'legiscan:2100182', 'demo-user', 'support',  oneMonthAgo],
    ['demo-vote-9',  'legiscan:2100182', 'demo-m6',   'oppose',   oneMonthAgo],
    ['demo-vote-10', 'legiscan:2100182', 'demo-m7',   'neutral',  threeWeeksAgo],
    ['demo-vote-11', 'legiscan:2100182', 'demo-m8',   'support',  twoWeeksAgo],
    ['demo-vote-12', 'legiscan:2100182', 'demo-m9',   'support',  twoWeeksAgo],
    // A1680 — voter registration 14 days
    ['demo-vote-13', 'legiscan:2098535', 'demo-user', 'support',  threeWeeksAgo],
    ['demo-vote-14', 'legiscan:2098535', 'demo-m10',  'neutral',  threeWeeksAgo],
    ['demo-vote-15', 'legiscan:2098535', 'demo-m11',  'support',  twoWeeksAgo],
    ['demo-vote-16', 'legiscan:2098535', 'demo-m12',  'support',  twoWeeksAgo],
    // A251 — voting machines
    ['demo-vote-17', 'legiscan:2096183', 'demo-user', 'support',  oneMonthAgo],
    ['demo-vote-18', 'legiscan:2096183', 'demo-m1',   'support',  oneMonthAgo],
    ['demo-vote-19', 'legiscan:2096183', 'demo-m3',   'neutral',  twoWeeksAgo],
    // A1715 — John R. Lewis Voter Empowerment Act
    ['demo-vote-20', 'legiscan:2098113', 'demo-user', 'support',  twoMonthsAgo],
    ['demo-vote-21', 'legiscan:2098113', 'demo-m2',   'support',  oneMonthAgo],
    ['demo-vote-22', 'legiscan:2098113', 'demo-m7',   'support',  oneMonthAgo],
    ['demo-vote-23', 'legiscan:2098113', 'demo-m11',  'neutral',  threeWeeksAgo],
    // A1698 — same-day voter registration
    ['demo-vote-24', 'legiscan:2098630', 'demo-user', 'support',  threeWeeksAgo],
    ['demo-vote-25', 'legiscan:2098630', 'demo-m4',   'neutral',  twoWeeksAgo],
    ['demo-vote-26', 'legiscan:2098630', 'demo-m9',   'support',  twoWeeksAgo],
  ]
  await db.batch(votes.map(([id, extId, userId, position, createdAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO member_votes (id, bill_id, user_id, position, created_at, updated_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(id, extId, userId, position, createdAt, createdAt, extId),
  ))

  // Comments — some include @mentions (span[data-type=mention] format)
  // [id, extId, userId, content, createdAt]
  const comments: Array<[string, string, string, string, string]> = [
    // A1129 — ballot drop boxes for fire district elections
    ['demo-comment-1', 'legiscan:2099974', 'demo-dir',
      '<p>This closes a real gap. Fire district elections have been operating without drop box access while municipal elections have had it. Key provisions:</p><ul><li><p><strong>Security requirements</strong> in Section 3 align with existing municipal drop box rules — 24-hour video surveillance, chain of custody log</p></li><li><p><strong>Retrieval schedule</strong> requires at least daily collection during the 10-day voting window</p></li><li><p>County board of elections remains the custodian, which keeps oversight consolidated</p></li></ul><p>Recommend supporting at committee. No implementation burden beyond extending existing protocols.</p>',
      twoMonthsAgo],
    ['demo-comment-2', 'legiscan:2099974', 'demo-m1',
      '<p>Strong support. We already manage drop boxes for general elections — adding fire district elections is straightforward operationally. The video monitoring infrastructure is already in place.</p>',
      oneMonthAgo],
    ['demo-comment-3', 'legiscan:2099974', 'demo-m4',
      '<p>One question: does "county board of elections" in Section 3 include situations where the municipality administers the fire district election? We need clarity on who bears the cost of extended drop box hours.</p>',
      twoWeeksAgo],
    ['demo-comment-4', 'legiscan:2099974', 'demo-dep',
      '<p><span data-type="mention" data-id="user:demo-m4" data-label="Michael Brown">@Michael Brown</span> — good catch. The bill is ambiguous on that. I\'d suggest we request a clarifying amendment: "county board of elections or its designee" to allow delegation to municipal clerks where the fire district election is locally administered.</p>',
      twoWeeksAgo],

    // A1195 — Voter Convenience Act (any-polling-place voting)
    ['demo-comment-5', 'legiscan:2100182', 'demo-m6',
      '<p>The any-polling-place provision is the most significant operational change I\'ve seen in years. What it means in practice:</p><ul><li><p>Every polling place becomes a provisional ballot site for out-of-precinct voters</p></li><li><p>Poll workers need to process provisional ballots from <em>any</em> registered voter in the county, not just their precinct</p></li><li><p>Adjudication timelines get compressed — we\'d need to process a larger provisional pool in the same post-election window</p></li></ul><p>The concept is voter-friendly, but the operational lift is real. We should request a pilot in 2–3 counties before statewide rollout.</p>',
      oneMonthAgo],
    ['demo-comment-6', 'legiscan:2100182', 'demo-dir',
      '<p>Good catch. <span data-type="mention" data-id="role:demo-role-2" data-label="Deputy/Assistant Director">@Deputy/Assistant Director</span> can you model the provisional ballot volume increase based on our 2024 general election data? We need a number before the committee hearing.</p>',
      oneMonthAgo],

    // A1680 — voter registration 14 days before election
    ['demo-comment-7', 'legiscan:2098535', 'demo-m8',
      '<p>The 14-day window is an improvement over the current 21-day deadline, but it still leaves a gap compared to the handful of states with same-day registration. Main operational impact:</p><ul><li><p>Processing volume spike in the final two weeks — we\'d need temporary staffing</p></li><li><p>Duplicate detection becomes more time-sensitive with less runway before election day</p></li></ul><p>Support with an amendment requesting a phased implementation and fiscal note for county election offices.</p>',
      sixWeeksAgo],
    ['demo-comment-8', 'legiscan:2098535', 'demo-m11',
      '<p>The current 21-day deadline was designed around paper processing. With our electronic registration system, 14 days is operationally fine. I\'d support this as written.</p>',
      threeWeeksAgo],
    ['demo-comment-9', 'legiscan:2098535', 'demo-m7',
      '<p>Agree with Thomas on the electronic processing point. The bigger concern is voter list accuracy — tighter deadlines mean less time to catch duplicate registrations or address discrepancies before election day.</p>',
      threeWeeksAgo],
    ['demo-comment-10', 'legiscan:2098535', 'demo-m8',
      '<p><span data-type="mention" data-id="role:demo-role-3" data-label="Technology &amp; Modernization">@Technology &amp; Modernization</span> — can you pull our average registration processing time for the last 30 days of the 2024 cycle? We need data to assess whether 14 days is workable without overtime.</p>',
      twoWeeksAgo],

    // A251 — new voting machines with paper audit trail
    ['demo-comment-11', 'legiscan:2096183', 'demo-m1',
      '<p>Paper audit trail requirement is long overdue. Two things worth watching closely:</p><ul><li><p><strong>Procurement timeline</strong> — the bill requires certified machines by the 2028 general election. Given state procurement timelines, counties need to begin RFP processes in 2026.</p></li><li><p><strong>Storage requirements</strong> for paper records — the bill is silent on retention period and secure storage standards.</p></li></ul><p>We should push for an amendment specifying a minimum 22-month retention period to cover post-election audit windows.</p>',
      oneMonthAgo],
    ['demo-comment-12', 'legiscan:2096183', 'demo-m3',
      '<p>The 2028 timeline is aggressive given state procurement rules. Realistically, a competitive bid takes 12–18 months, then delivery and training adds another 6. We need to flag this to sponsors.</p>',
      twoWeeksAgo],
    ['demo-comment-13', 'legiscan:2096183', 'demo-dir',
      '<p><span data-type="mention" data-id="user:demo-dep" data-label="James Chen">@James Chen</span> — can you reach out to the Division of Elections to clarify whether county procurement falls under the state contract or requires independent bidding? The answer changes our timeline significantly.</p>',
      oneWeekAgo],

    // A2670 — canvassing early votes before election day
    ['demo-comment-14', 'legiscan:2099056', 'demo-m10',
      '<p>Allowing canvassing before election day is a significant efficiency gain. Three sections worth close review:</p><ul><li><p><strong>Section 2</strong> — prohibits releasing any results before polls close. Enforcement mechanism is unclear.</p></li><li><p><strong>Section 4</strong> — chain of custody requirements during the pre-canvass period add procedural complexity.</p></li><li><p><strong>Section 6</strong> — dispute resolution for pre-canvass period is new territory — no existing case law.</p></li></ul><p>I\'d recommend we support with an amendment strengthening the results-embargo enforcement in Section 2.</p>',
      threeWeeksAgo],
    ['demo-comment-15', 'legiscan:2099056', 'demo-m4',
      '<p>The operational upside is real — finishing the canvass post-election currently takes our office 3–4 days. Pre-canvassing early votes would cut that significantly. But the chain of custody requirements in Section 4 need to be more specific about who can be present during pre-canvass and what documentation is required.</p>',
      twoWeeksAgo],

    // A548 — county clerk death filing + voter registration
    ['demo-comment-16', 'legiscan:2096553', 'demo-m9',
      '<p>Requiring the county clerk to file death information for voter list maintenance is straightforward. We already receive vital records data — this just adds a formal obligation and timeline.</p>',
      oneMonthAgo],
    ['demo-comment-17', 'legiscan:2096553', 'demo-dir',
      '<p>Low operational impact for us, but meaningful for list accuracy. I\'d suggest we support.</p>',
      twoWeeksAgo],

    // A1715 — John R. Lewis Voter Empowerment Act
    ['demo-comment-18', 'legiscan:2098113', 'demo-dir',
      '<p>The John R. Lewis Voter Empowerment Act is the most comprehensive voting rights bill this session. Key provisions affecting county operations:</p><ul><li><strong>Automatic voter registration</strong> — triggers at any state agency interaction. County boards will receive daily electronic transmissions from DMV; volume will increase significantly.</li><li><strong>Pre-registration for 16–17 year olds</strong> — requires a new processing workflow for conditional registrants who become eligible before the election.</li><li><strong>Expanded early voting hours</strong> — adds Saturday and Sunday early voting; counties will need to budget for additional poll worker hours and facility costs.</li><li><strong>Voting rights restoration post-incarceration</strong> — county clerks are the re-registration point of contact for returning citizens; clear notification guidance from the state is needed.</li></ul><p>Recommend we formally support and engage the sponsor early on implementation guidance.</p>',
      twoMonthsAgo],
    ['demo-comment-19', 'legiscan:2098113', 'demo-m5',
      '<p>The automatic registration provision will be the heaviest lift. In 2024 our county processed about 4,000 DMV-initiated registrations — under this bill that number could double or triple. We need to confirm that SVRS can handle the volume without manual staff intervention for each record.</p>',
      oneMonthAgo],

    // A1698 — same-day voter registration
    ['demo-comment-20', 'legiscan:2098630', 'demo-m2',
      '<p>Same-day registration at polling places is more complex than moving the registration deadline (A1680). At-precinct same-day reg means every poll worker needs to accept and process a new registration on election day — that\'s a separate workflow from anything in current poll worker training.</p>',
      threeWeeksAgo],
    ['demo-comment-21', 'legiscan:2098630', 'demo-dep',
      '<p>Worth noting that A1680 and A1698 are both in play this session. If both advance, we should push for unified implementation guidance — running two different "late registration" workflows depending on timing would create real confusion at the polls. <span data-type="mention" data-id="role:demo-role-1" data-label="County Elections Director">@County Elections Director</span> — should we request a joint hearing?</p>',
      twoWeeksAgo],

    // A2670 — canvassing early votes (follow-up)
    ['demo-comment-22', 'legiscan:2099056', 'demo-m8',
      '<p>Following up on the results-embargo concern: I spoke with the sponsor\'s office and they\'re open to an amendment. Recommend we propose specific penalty language — that any county employee who discloses pre-canvass results is subject to the same penalty as early ballot disclosure under existing law.</p>',
      oneWeekAgo],

    // A548 — county clerk death filing (follow-up)
    ['demo-comment-23', 'legiscan:2096553', 'demo-m12',
      '<p>This aligns with the NVRA data-matching process we already run with the Department of Health. Main question is whether the 30-day reporting timeline in Section 1 is stricter than our current vital records exchange schedule — if so, we\'d need to adjust our data pull frequency.</p>',
      threeWeeksAgo],

    // A1195 — Voter Convenience Act (follow-up with data)
    ['demo-comment-24', 'legiscan:2100182', 'demo-m3',
      '<p>We pulled our 2024 general election numbers: roughly 8% of voters who showed up at our polling locations were registered in a different precinct. If those voters cast provisional ballots instead of being turned away, that\'s approximately 2,200 additional provisional ballots to adjudicate — a 40% increase over our 2024 provisional total. Real but manageable with adequate staffing.</p>',
      oneWeekAgo],

    // Reactions to recent committee action — co-dated with each bill's freshest
    // bill_updated event (below) so the top-of-feed cards show a mix of legislative
    // activity AND member discussion in the same card, not activity alone.
    ['demo-comment-25', 'legiscan:2098113', 'demo-dir',
      '<p>The ACS cleared Appropriations 7-4 this morning. The committee adopted our requested amendment phasing in the automatic registration data feeds — that directly addresses the volume concern Lisa flagged. Next stop is the Assembly floor; recommend we send a formal support letter before second reading.</p>',
      daysAgo(2)],
    ['demo-comment-26', 'legiscan:2099974', 'demo-m1',
      '<p>Reported out of State &amp; Local Government 5-1 — strong bipartisan signal. The "or its designee" clarification we asked for made it into the committee version, so the cost-allocation ambiguity on fire district retrieval is resolved. No further amendments needed from our side.</p>',
      daysAgo(4)],
    ['demo-comment-27', 'legiscan:2100182', 'demo-dep',
      '<p>The committee substitute narrows the any-polling-place provision to a 3-county pilot for 2026 — exactly the phased rollout we pushed for. <span data-type="mention" data-id="user:demo-dir" data-label="Maria Santos">@Maria Santos</span> this changes our position analysis; the provisional-volume risk is now contained to the pilot counties rather than statewide.</p>',
      daysAgo(6)],
    ['demo-comment-28', 'legiscan:2098535', 'demo-m8',
      '<p>Advanced to Appropriations on a 6-2 vote. The fiscal note request we submitted is referenced in the committee statement. If Appropriations funds the temporary staffing line for the final two weeks, our amendment ask is effectively satisfied.</p>',
      daysAgo(9)],
  ]
  await db.batch(comments.map(([id, extId, userId, content, createdAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO comments (id, bill_id, user_id, content, created_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(id, extId, userId, content, createdAt, extId),
  ))

  // comment_mentions — one row per (comment, notified user)
  // demo-role-2 members: demo-dep
  // demo-role-3 members: demo-m1, demo-m6, demo-m10
  type MentionRow = [string, string, string, 'user' | 'role', string, string]
  const mentions: MentionRow[] = [
    // demo-comment-4: @Michael Brown (demo-m4) mentioned by demo-dep
    ['demo-mention-1', 'demo-comment-4', 'demo-m4',  'user', 'demo-m4',     twoWeeksAgo],
    // demo-comment-6: @Deputy/Assistant Director (demo-role-2) → demo-dep
    ['demo-mention-2', 'demo-comment-6', 'demo-dep', 'role', 'demo-role-2', oneMonthAgo],
    // demo-comment-10: @Technology & Modernization (demo-role-3) → demo-m1, demo-m6, demo-m10
    ['demo-mention-3', 'demo-comment-10', 'demo-m1',  'role', 'demo-role-3', twoWeeksAgo],
    ['demo-mention-4', 'demo-comment-10', 'demo-m6',  'role', 'demo-role-3', twoWeeksAgo],
    ['demo-mention-5', 'demo-comment-10', 'demo-m10', 'role', 'demo-role-3', twoWeeksAgo],
    // demo-comment-13: @James Chen (demo-dep) mentioned by demo-dir
    ['demo-mention-6', 'demo-comment-13', 'demo-dep', 'user', 'demo-dep',    oneWeekAgo],
    // demo-comment-21: @County Elections Director (demo-role-1) → demo-dir, demo-m2, demo-m8
    ['demo-mention-7', 'demo-comment-21', 'demo-dir', 'role', 'demo-role-1', twoWeeksAgo],
    ['demo-mention-8', 'demo-comment-21', 'demo-m2',  'role', 'demo-role-1', twoWeeksAgo],
    ['demo-mention-9', 'demo-comment-21', 'demo-m8',  'role', 'demo-role-1', twoWeeksAgo],
    // demo-comment-27: @Maria Santos (demo-dir) mentioned by demo-dep
    ['demo-mention-10', 'demo-comment-27', 'demo-dir', 'user', 'demo-dir', daysAgo(6)],
  ]
  await db.batch(mentions.map(([id, commentId, userId, sourceType, sourceId, createdAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO comment_mentions (id, comment_id, user_id, source_type, source_id, created_at)
       SELECT ?, id, ?, ?, ?, ?
       FROM comments WHERE id = ? LIMIT 1`
    ).bind(id, userId, sourceType, sourceId, createdAt, commentId),
  ))

  // Feed events
  // priority_set: { priority }
  // position_set: { position }
  // comment_added: { preview, commentId, mentionedUserIds? }
  // vote_milestone: { message }
  // bill_updated: { changes: ChangeRecord[] } — legislative activity (status changes,
  //   actions, committee votes, amendments). Passive event type, but surfaces in the
  //   feed because every demo bill below carries a priority. Time-offset like the
  //   calendar hearings so fresh legislative activity tops the feed instead of the
  //   feed being all comments. `userId` is 'system' to mirror the real ingestor.
  const chg = (changeType: string, f: { oldValue?: string; newValue?: string; detail?: string } = {}) =>
    ({ changeType, oldValue: f.oldValue ?? null, newValue: f.newValue ?? null, detail: f.detail ?? null })
  type FeedEvent = [string, string, string, string, string, string]
  const feedEvents: FeedEvent[] = [
    // Priority set events
    ['demo-fe-p1', 'priority_set', 'legiscan:2099974', 'demo-dir', JSON.stringify({ priority: 'high' }),   twoMonthsAgo],
    ['demo-fe-p2', 'priority_set', 'legiscan:2100182', 'demo-dir', JSON.stringify({ priority: 'high' }),   twoMonthsAgo],
    ['demo-fe-p3', 'priority_set', 'legiscan:2098535', 'demo-dir', JSON.stringify({ priority: 'high' }),   oneMonthAgo],
    ['demo-fe-p4', 'priority_set', 'legiscan:2096553', 'demo-dir', JSON.stringify({ priority: 'low' }),    oneMonthAgo],
    ['demo-fe-p5', 'priority_set', 'legiscan:2096183', 'demo-dep', JSON.stringify({ priority: 'medium' }), threeWeeksAgo],
    ['demo-fe-p6', 'priority_set', 'legiscan:2098630', 'demo-dep', JSON.stringify({ priority: 'medium' }), threeWeeksAgo],
    ['demo-fe-p7', 'priority_set', 'legiscan:2099056', 'demo-dep', JSON.stringify({ priority: 'medium' }), threeWeeksAgo],
    ['demo-fe-p8', 'priority_set', 'legiscan:2098113', 'demo-dir', JSON.stringify({ priority: 'high' }),   twoMonthsAgo],

    // Official position set events
    ['demo-fe-o1', 'position_set', 'legiscan:2099974', 'demo-dir', JSON.stringify({ position: 'Support' }), twoMonthsAgo],
    ['demo-fe-o2', 'position_set', 'legiscan:2100182', 'demo-dir', JSON.stringify({ position: 'Support' }), twoMonthsAgo],
    ['demo-fe-o3', 'position_set', 'legiscan:2098535', 'demo-dir', JSON.stringify({ position: 'Amend' }),   oneMonthAgo],
    ['demo-fe-o4', 'position_set', 'legiscan:2098630', 'demo-dep', JSON.stringify({ position: 'Monitor' }), threeWeeksAgo],
    ['demo-fe-o5', 'position_set', 'legiscan:2096183', 'demo-dep', JSON.stringify({ position: 'Support' }), threeWeeksAgo],
    ['demo-fe-o6', 'position_set', 'legiscan:2098113', 'demo-dir', JSON.stringify({ position: 'Support' }), twoMonthsAgo],

    // Vote milestones
    ['demo-fe-v1', 'vote_milestone', 'legiscan:2099974', 'demo-m6', JSON.stringify({ message: '7 members have voted on this bill' }), twoWeeksAgo],
    ['demo-fe-v2', 'vote_milestone', 'legiscan:2100182', 'demo-m9', JSON.stringify({ message: '5 members have voted on this bill' }), twoWeeksAgo],
    ['demo-fe-v3', 'vote_milestone', 'legiscan:2098113', 'demo-m11', JSON.stringify({ message: '4 members have voted on this bill' }), threeWeeksAgo],
    ['demo-fe-v4', 'vote_milestone', 'legiscan:2098630', 'demo-m9',  JSON.stringify({ message: '3 members have voted on this bill' }), twoWeeksAgo],

    // Comment added — most recent comment per bill
    ['demo-fe-c1', 'comment_added', 'legiscan:2099974', 'demo-dep',
      JSON.stringify({ preview: 'Michael Brown — good catch. I\'d suggest we request a clarifying amendment: "county board of elections or its designee."', commentId: 'demo-comment-4', mentionedUserIds: ['demo-m4'] }),
      twoWeeksAgo],
    ['demo-fe-c2', 'comment_added', 'legiscan:2100182', 'demo-dir',
      JSON.stringify({ preview: 'Good catch. Deputy/Assistant Director can you model the provisional ballot volume increase based on our 2024 general election data?', commentId: 'demo-comment-6', mentionedUserIds: ['demo-dep'] }),
      oneMonthAgo],
    ['demo-fe-c3', 'comment_added', 'legiscan:2098535', 'demo-m8',
      JSON.stringify({ preview: 'Technology & Modernization — can you pull our average registration processing time for the last 30 days of the 2024 cycle?', commentId: 'demo-comment-10', mentionedUserIds: ['demo-m1', 'demo-m6', 'demo-m10'] }),
      twoWeeksAgo],
    ['demo-fe-c4', 'comment_added', 'legiscan:2096183', 'demo-dir',
      JSON.stringify({ preview: 'James Chen — can you reach out to the Division of Elections to clarify whether county procurement falls under the state contract?', commentId: 'demo-comment-13', mentionedUserIds: ['demo-dep'] }),
      oneWeekAgo],
    ['demo-fe-c5', 'comment_added', 'legiscan:2099056', 'demo-m4',
      JSON.stringify({ preview: 'The operational upside is real — finishing the canvass post-election currently takes our office 3–4 days. Pre-canvassing early votes would cut that significantly.', commentId: 'demo-comment-15' }),
      twoWeeksAgo],
    ['demo-fe-c6', 'comment_added', 'legiscan:2096553', 'demo-dir',
      JSON.stringify({ preview: 'Low operational impact for us, but meaningful for list accuracy. I\'d suggest we support.', commentId: 'demo-comment-17' }),
      twoWeeksAgo],
    ['demo-fe-c7', 'comment_added', 'legiscan:2098113', 'demo-m5',
      JSON.stringify({ preview: 'The automatic registration provision will be the heaviest lift. In 2024 our county processed about 4,000 DMV-initiated registrations — under this bill that could double or triple.', commentId: 'demo-comment-19' }),
      oneMonthAgo],
    ['demo-fe-c8', 'comment_added', 'legiscan:2098630', 'demo-dep',
      JSON.stringify({ preview: 'A1680 and A1698 are both in play this session. If both advance, we should push for unified implementation guidance.', commentId: 'demo-comment-21', mentionedUserIds: ['demo-dir', 'demo-m2', 'demo-m8'] }),
      twoWeeksAgo],
    ['demo-fe-c9', 'comment_added', 'legiscan:2099056', 'demo-m8',
      JSON.stringify({ preview: 'The sponsor\'s office is open to an amendment — recommend we propose specific penalty language for the results-embargo enforcement.', commentId: 'demo-comment-22' }),
      oneWeekAgo],
    ['demo-fe-c10', 'comment_added', 'legiscan:2100182', 'demo-m3',
      JSON.stringify({ preview: 'We pulled our 2024 numbers: roughly 8% of voters were registered in a different precinct — approximately 2,200 additional provisional ballots, a 40% increase over 2024.', commentId: 'demo-comment-24' }),
      oneWeekAgo],
    // Recent committee-reaction comments, co-dated with the freshest bill_updated
    // events below so the top feed cards mix activity with discussion.
    ['demo-fe-c11', 'comment_added', 'legiscan:2098113', 'demo-dir',
      JSON.stringify({ preview: 'The ACS cleared Appropriations 7-4 this morning. The committee adopted our requested amendment phasing in the automatic registration data feeds.', commentId: 'demo-comment-25' }),
      daysAgo(2)],
    ['demo-fe-c12', 'comment_added', 'legiscan:2099974', 'demo-m1',
      JSON.stringify({ preview: 'Reported out of State & Local Government 5-1 — the "or its designee" clarification we asked for made it into the committee version.', commentId: 'demo-comment-26' }),
      daysAgo(4)],
    ['demo-fe-c13', 'comment_added', 'legiscan:2100182', 'demo-dep',
      JSON.stringify({ preview: 'The committee substitute narrows the any-polling-place provision to a 3-county pilot for 2026 — exactly the phased rollout we pushed for.', commentId: 'demo-comment-27', mentionedUserIds: ['demo-dir'] }),
      daysAgo(6)],
    ['demo-fe-c14', 'comment_added', 'legiscan:2098535', 'demo-m8',
      JSON.stringify({ preview: 'Advanced to Appropriations on a 6-2 vote. If Appropriations funds the temporary staffing line, our amendment ask is effectively satisfied.', commentId: 'demo-comment-28' }),
      daysAgo(9)],

    // Bill activity (bill_updated) — legislative lifecycle spread across the recent
    // window. Recent updates on the high/medium-priority bills keep the top of the
    // feed showing legislative movement, not just comments.
    // A1715 — John R. Lewis Act (flagship, most active)
    ['demo-fe-u1', 'bill_updated', 'legiscan:2098113', 'system', JSON.stringify({ changes: [
      chg('status_change', { oldValue: 'In Committee', newValue: 'Reported - Assembly Floor' }),
      chg('action_added', { newValue: 'Reported out of Assembly Appropriations Committee with amendments, 2nd Reading' }),
      chg('vote_added', { detail: 'Assembly Appropriations Cmte: 7-4' }),
      chg('amendment_added', { detail: 'Assembly Committee Substitute (ACS) adopted' }),
    ] }), daysAgo(2)],
    ['demo-fe-u2', 'bill_updated', 'legiscan:2098113', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Public hearing held — Assembly Appropriations Committee' }),
    ] }), twoWeeksAgo],
    ['demo-fe-u3', 'bill_updated', 'legiscan:2098113', 'system', JSON.stringify({ changes: [
      chg('status_change', { oldValue: 'Introduced', newValue: 'In Committee' }),
      chg('action_added', { newValue: 'Referred to Assembly Appropriations Committee' }),
    ] }), oneMonthAgo],

    // A1129 — ballot drop boxes
    ['demo-fe-u4', 'bill_updated', 'legiscan:2099974', 'system', JSON.stringify({ changes: [
      chg('status_change', { oldValue: 'In Committee', newValue: 'Reported - Assembly Floor' }),
      chg('action_added', { newValue: 'Reported out of Assembly State & Local Government Committee, 2nd Reading' }),
      chg('vote_added', { detail: 'Assembly State & Local Gov Cmte: 5-1' }),
    ] }), daysAgo(4)],
    ['demo-fe-u5', 'bill_updated', 'legiscan:2099974', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Hearing held in Assembly State & Local Government Committee' }),
    ] }), threeWeeksAgo],

    // A1195 — Voter Convenience Act
    ['demo-fe-u6', 'bill_updated', 'legiscan:2100182', 'system', JSON.stringify({ changes: [
      chg('amendment_added', { detail: 'Assembly Committee Substitute (ACS) reported' }),
      chg('action_added', { newValue: 'Substituted by Assembly Committee Substitute' }),
    ] }), daysAgo(6)],
    ['demo-fe-u7', 'bill_updated', 'legiscan:2100182', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Referred to Assembly Judiciary Committee' }),
    ] }), twoWeeksAgo],

    // A1680 — voter registration 14 days
    ['demo-fe-u8', 'bill_updated', 'legiscan:2098535', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Reported and referred to Assembly Appropriations Committee' }),
      chg('vote_added', { detail: 'Assembly State Government Cmte: 6-2' }),
    ] }), daysAgo(9)],
    ['demo-fe-u9', 'bill_updated', 'legiscan:2098535', 'system', JSON.stringify({ changes: [
      chg('status_change', { oldValue: 'Introduced', newValue: 'In Committee' }),
    ] }), oneMonthAgo],

    // A251 — voting machines
    ['demo-fe-u10', 'bill_updated', 'legiscan:2096183', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Reported out of committee, 2nd Reading' }),
      chg('vote_added', { detail: 'Assembly State & Local Gov Cmte: 4-3' }),
    ] }), daysAgo(11)],
    ['demo-fe-u11', 'bill_updated', 'legiscan:2096183', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Introduced, referred to Assembly State & Local Government Committee' }),
    ] }), oneMonthAgo],

    // A2670 — canvassing early votes
    ['demo-fe-u12', 'bill_updated', 'legiscan:2099056', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Reported from Assembly Judiciary Committee with amendments' }),
      chg('amendment_added', { detail: 'Committee amendments adopted' }),
    ] }), twoWeeksAgo],
    ['demo-fe-u13', 'bill_updated', 'legiscan:2099056', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Referred to Assembly Judiciary Committee' }),
    ] }), threeWeeksAgo],

    // A1698 — same-day voter registration
    ['demo-fe-u14', 'bill_updated', 'legiscan:2098630', 'system', JSON.stringify({ changes: [
      chg('status_change', { oldValue: 'Introduced', newValue: 'In Committee' }),
      chg('action_added', { newValue: 'Hearing scheduled — Assembly State & Local Government Committee' }),
    ] }), twoWeeksAgo],

    // A548 — county clerk death filing
    ['demo-fe-u15', 'bill_updated', 'legiscan:2096553', 'system', JSON.stringify({ changes: [
      chg('action_added', { newValue: 'Introduced, referred to Assembly State & Local Government Committee' }),
    ] }), threeWeeksAgo],
  ]
  await db.batch(feedEvents.map(([id, type, extId, userId, metadata, createdAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO feed_events (id, type, bill_id, user_id, metadata, created_at)
       SELECT ?, ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(id, type, extId, userId, metadata, createdAt, extId),
  ))

  // Mark demo-user as having seen the feed as of now. All seeded feed events carry
  // past timestamps, so a "now" baseline keeps the Feed nav dot dark for fresh
  // demo visitors — without this, the re-created demo-user row has a null
  // last_seen_feed, which lights the dot after every nightly reset.
  await db.prepare(`UPDATE users SET last_seen_feed = datetime('now') WHERE id = 'demo-user'`).run()

  // Custom field values — spread across bills so filtering produces results
  type CfvRow = [string, string, string, string, string]
  const cfvRows: CfvRow[] = [
    // Fiscal Impact (demo-cf-1) on 5 bills
    ['legiscan:2099974', 'demo-cf-1', 'Minimal (<$10K)',      'demo-dir', twoMonthsAgo],
    ['legiscan:2100182', 'demo-cf-1', 'Significant (>$100K)', 'demo-dir', twoMonthsAgo],
    ['legiscan:2098535', 'demo-cf-1', 'Minimal (<$10K)',      'demo-dir', oneMonthAgo],
    ['legiscan:2096183', 'demo-cf-1', 'Significant (>$100K)', 'demo-dep', threeWeeksAgo],
    ['legiscan:2099056', 'demo-cf-1', 'Moderate ($10K-$100K)','demo-dep', threeWeeksAgo],
    // Committee Assignment (demo-cf-2) on 5 bills
    ['legiscan:2099974', 'demo-cf-2', 'Voter Access',        'demo-dir', twoMonthsAgo],
    ['legiscan:2100182', 'demo-cf-2', 'Voter Access',        'demo-dir', twoMonthsAgo],
    ['legiscan:2098535', 'demo-cf-2', 'Legislative Affairs', 'demo-m6',  oneMonthAgo],
    ['legiscan:2096183', 'demo-cf-2', 'Technology',          'demo-dep', threeWeeksAgo],
    ['legiscan:2099056', 'demo-cf-2', 'Legislative Affairs', 'demo-dep', oneMonthAgo],
    // Association Concerns (demo-cf-3, pinned) — rich text on 3 bills
    ['legiscan:2099974', 'demo-cf-3', '<p><strong>Key concern: cost allocation for fire district elections.</strong> Section 3 requires county boards to maintain drop boxes, but is silent on which entity bears retrieval costs when a municipality administers the fire district election. We\'ve requested a clarifying amendment — "county board of elections or its designee" — to allow cost delegation to municipal clerks.</p><ul><li>Chain of custody requirements align with existing municipal protocols — no new infrastructure needed</li><li>Amendment request submitted to sponsor\'s office; response pending</li></ul>', 'demo-dir', twoMonthsAgo],
    ['legiscan:2100182', 'demo-cf-3', '<p><strong>Significant operational lift — position pending impact analysis.</strong> Any-polling-place voting converts every polling site into a provisional ballot processing center for the full county.</p><ul><li>Provisional ballot volume modeling underway based on 2024 general election data</li><li>Poll worker training will need to be redesigned before rollout</li><li>Post-election adjudication window tightens with a larger provisional pool</li></ul>', 'demo-dir', twoMonthsAgo],
    ['legiscan:2096183', 'demo-cf-3', '<p><strong>Support the paper audit trail requirement; procurement timeline is the critical risk.</strong> State procurement realistically takes 18–24 months from RFP to delivery. Counties need authorization to begin in 2026 to meet the 2028 deadline.</p><ul><li>Amendment needed: authorize counties to initiate procurement in 2026, not contingent on bill enactment date</li><li>Paper record retention period unspecified — recommend 22-month minimum to cover post-election audit windows</li></ul>', 'demo-dir', oneMonthAgo],
    // Implementation Deadline (demo-cf-4) on 3 bills
    ['legiscan:2099974', 'demo-cf-4', '2026-11-01', 'demo-dir', twoMonthsAgo],
    ['legiscan:2096183', 'demo-cf-4', '2028-01-01', 'demo-m6',  oneMonthAgo],
    ['legiscan:2098535', 'demo-cf-4', '2026-09-01', 'demo-dep', threeWeeksAgo],
    // Fiscal Impact + Committee for A1715 and A1698
    ['legiscan:2098113', 'demo-cf-1', 'Significant (>$100K)', 'demo-dir', twoMonthsAgo],
    ['legiscan:2098113', 'demo-cf-2', 'Legislative Affairs',  'demo-dir', twoMonthsAgo],
    ['legiscan:2098630', 'demo-cf-1', 'Moderate ($10K-$100K)', 'demo-dep', threeWeeksAgo],
    ['legiscan:2098630', 'demo-cf-2', 'Voter Access',          'demo-dep', threeWeeksAgo],
    // Testimony Submitted (demo-cf-5) on 2 bills — binary fields store '1' for checked, no row for unchecked
    ['legiscan:2099974', 'demo-cf-5', '1', 'demo-dir', oneMonthAgo],
    ['legiscan:2100182', 'demo-cf-5', '1', 'demo-dir', oneMonthAgo],
  ]
  await db.batch(cfvRows.map(([extId, fieldId, value, setBy, updatedAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO bill_custom_field_values (bill_id, field_id, value, set_by, updated_at)
       SELECT (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(extId, fieldId, value, setBy, updatedAt, extId),
  ))

  // Personal notes for demo-user
  const notes: Array<[string, string, string, string]> = [
    ['demo-note-1', 'legiscan:2099974', 'Review chain of custody language in Section 3 before committee hearing — clarify who bears cost for fire district drop box retrieval', twoMonthsAgo],
    ['demo-note-2', 'legiscan:2100182', 'Get provisional ballot volume estimate from James before Senate committee hearing', oneMonthAgo],
    ['demo-note-3', 'legiscan:2098535', 'Pull 2024 cycle registration data for the final 30 days — needed to assess 14-day window feasibility', threeWeeksAgo],
    ['demo-note-4', 'legiscan:2096183', 'Confirm with Division of Elections whether county procurement is under state contract or independent bid — changes the 2028 timeline analysis', twoWeeksAgo],
    ['demo-note-5', 'legiscan:2099056', 'Request sponsor briefing — focus on results-embargo enforcement mechanism in Section 2 and chain of custody during pre-canvass period', oneWeekAgo],
    ['demo-note-6', 'legiscan:2096553', 'Low impact operationally — flag for county counsel to review the death-reporting timeline in Section 1', oneMonthAgo],
    ['demo-note-7', 'legiscan:2098113', 'Monitor committee hearings — highest-profile bill this session. Sponsor briefing requested; coordinate with Maria on implementation working group.', twoMonthsAgo],
    ['demo-note-8', 'legiscan:2098630', 'Compare with A1680 — both touch late registration; may need coordinated testimony if both advance. Ask James to map the workflow differences.', threeWeeksAgo],
  ]
  await db.batch(notes.map(([id, extId, content, createdAt]) =>
    db.prepare(
      `INSERT OR IGNORE INTO notes (id, bill_id, user_id, content, created_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), 'demo-user', ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(id, extId, content, createdAt, extId),
  ))

  // Step 5: Seed calendar events (DEMO ONLY). Dates are now-relative so the calendar and
  // hearings widget always show fresh upcoming events; the nightly reset re-derives them.
  // Hearings tie to the priority bills above (the calendar only renders hearing rows whose
  // bill has a priority). Custom events are team-created flavor; some bill-linked, some not.
  const calDate = (offsetDays: number) =>
    new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10)

  // Hearings: [slug, extId, offsetDays, time, location, description]
  const hearings: Array<[string, string, number, string, string, string]> = [
    ['demo-hearing-1', 'legiscan:2099974', 2,  '10:00:00', 'State House Annex, Committee Room 11, Trenton', 'Assembly State & Local Government Committee — hearing'],
    ['demo-hearing-2', 'legiscan:2100182', 6,  '13:30:00', 'State House Annex, Committee Room 9, Trenton',  'Assembly Judiciary Committee — hearing'],
    ['demo-hearing-3', 'legiscan:2098535', 13, '10:00:00', 'State House Annex, Committee Room 4, Trenton',  'Senate State Government Committee — hearing'],
    ['demo-hearing-4', 'legiscan:2098113', 18, '14:00:00', 'State House, Committee Room 6, Trenton',        'Assembly Appropriations Committee — hearing'],
    ['demo-hearing-5', 'legiscan:2096183', 27, '11:00:00', 'State House Annex, Committee Room 11, Trenton', 'Assembly State & Local Government Committee — hearing'],
  ]
  await db.batch(hearings.map(([slug, extId, offset, time, location, description]) =>
    db.prepare(
      `INSERT OR IGNORE INTO calendar_events (id, uid, bill_id, source, sequence, date, time, location, description, status, event_hash)
       SELECT ?, ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), 'hearing', 0, ?, ?, ?, ?, 'confirmed', NULL
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(slug, `${slug}@example.com`, extId, calDate(offset), time, location, description, extId),
  ))

  // Custom events: [slug, extId|null, offsetDays, time|null, location|null, description]
  const customEvents: Array<[string, string | null, number, string | null, string | null, string]> = [
    ['demo-event-1', null,               -4, null,       'Zoom',             'Monthly membership call'],
    ['demo-event-2', 'legiscan:2099974', 4,  '17:00:00', null,               'Testimony deadline — A1129 (drop boxes)'],
    ['demo-event-3', 'legiscan:2100182', 11, '17:00:00', null,               'Comment period closes — A1195 rules'],
    ['demo-event-4', null,               20, '09:00:00', 'Trenton Marriott', 'NJ County Clerks Association — spring conference'],
    ['demo-event-5', null,               25, '14:00:00', 'Zoom',             'Legislative strategy working group'],
  ]
  await db.batch(customEvents.map(([slug, extId, offset, time, location, description]) =>
    extId === null
      ? db.prepare(
          `INSERT OR IGNORE INTO calendar_events (id, uid, bill_id, source, sequence, date, time, location, description, status, event_hash)
           VALUES (?, ?, NULL, 'custom', 0, ?, ?, ?, ?, 'confirmed', NULL)`
        ).bind(slug, `${slug}@example.com`, calDate(offset), time, location, description)
      : db.prepare(
          `INSERT OR IGNORE INTO calendar_events (id, uid, bill_id, source, sequence, date, time, location, description, status, event_hash)
           SELECT ?, ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), 'custom', 0, ?, ?, ?, ?, 'confirmed', NULL
           WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
        ).bind(slug, `${slug}@example.com`, extId, calDate(offset), time, location, description, extId),
  ))
}
