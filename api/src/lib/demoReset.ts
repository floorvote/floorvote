import type { DemoSeed } from './demoSeeds'

/** N days ago in the SQLite space format that stored timestamps require.
 *  Counts BACKWARD: positive n is the past, and n = 0 is now. This is the seed's
 *  default convention (every `…DaysAgo` / `daysAgo` field). Note the opposite
 *  sign to dateFromNow below. */
const daysAgoDb = (n: number) =>
  new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19).replace('T', ' ')

/**
 * A date-only (YYYY-MM-DD) offset from today, for calendar rows, snapped off the
 * weekend.
 *
 * Counts FORWARD: positive offsetDays is the future, negative is the past. The
 * seed's `offsetDays` is the sole field that inverts the "N days ago" convention,
 * because most calendar events are upcoming. Note the opposite sign to
 * daysAgoDb above.
 *
 * Why the snap: `offsetDays` is relative to the reset, so a fixed offset lands on
 * a different weekday every night — which put committee hearings on Saturdays and
 * Sundays roughly two nights in seven. Legislatures don't sit at the weekend, and
 * a demo advertising a Sunday hearing is the sort of detail a prospect notices.
 *
 * The snap preserves the offset's sense: a future event moves forward to Monday,
 * a past event back to Friday. So a past event can never become upcoming, which
 * would otherwise reorder the feed and calendar.
 *
 * Consequence for tests: the day-delta between the reset date and a calendar date
 * is now weekday-dependent, so it is NOT stable across run dates. The golden
 * snapshot therefore cannot bucket `calendar_events.date` as a relative offset —
 * see the note in demoReset.snapshot.test.ts, which pins these dates by
 * recomputing them instead.
 */
export const dateFromNow = (offsetDays: number, nowMs: number = Date.now()) => {
  const d = new Date(nowMs + offsetDays * 86400_000)
  const step = offsetDays < 0 ? -1 : 1
  // 0 = Sunday, 6 = Saturday
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + step)
  return d.toISOString().slice(0, 10)
}

const placeholdersFor = (ids: readonly unknown[]) => ids.map(() => '?').join(',')

/**
 * Restore a demo tenant to the canonical state described by `seed`.
 *
 * This function is the machinery only — truncate ordering, FK handling, and the
 * insert idioms. Every row it writes comes from the seed, so standing up a second
 * demo tenant is a data change (a new entry in demoSeeds/) rather than a fork of
 * this file.
 */
export async function runDemoReset(db: D1Database, seed: DemoSeed): Promise<void> {
  // D1 throws "No SQL statements detected" on an empty batch, and a seed may
  // legitimately carry none of a given row type (no mentions, no custom fields).
  const batch = async (stmts: D1PreparedStatement[]) => {
    if (stmts.length > 0) await db.batch(stmts)
  }

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

  // Canonical seed users
  await batch(seed.users.map((u) =>
    db.prepare(`INSERT OR REPLACE INTO users (id, email, name, role, subtitle, created_at, can_vote) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(u.id, u.email, u.name, u.role, u.subtitle, daysAgoDb(u.createdDaysAgo), u.canVote ? 1 : 0),
  ))

  // Canonical roles
  await batch(seed.roles.map((r) =>
    db.prepare(`INSERT OR REPLACE INTO roles (id, name) VALUES (?, ?)`).bind(r.id, r.name),
  ))

  // Delete any non-seed roles added during demo. The keep-list is derived from the
  // seed, not hardcoded, so a second seed does not delete its own rows.
  const seedRoleIds = seed.roles.map((r) => r.id)
  await db.prepare(`DELETE FROM roles WHERE id NOT IN (${placeholdersFor(seedRoleIds)})`).bind(...seedRoleIds).run()

  // Reset user_roles to canonical assignments (wipe and re-insert)
  await db.prepare('DELETE FROM user_roles').run()
  await batch(seed.userRoles.map((ur) =>
    db.prepare(`INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`).bind(ur.userId, ur.roleId),
  ))

  // Canonical custom field definitions
  await batch(seed.customFields.map((f) =>
    db.prepare(`INSERT OR REPLACE INTO custom_field_definitions (id, name, slug, type, options, display_order, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(f.id, f.name, f.slug, f.type, f.options === null ? null : JSON.stringify(f.options), f.displayOrder, f.pinned ? 1 : 0),
  ))
  // Remove any custom fields added during demo (keep-list from the seed).
  const seedFieldIds = seed.customFields.map((f) => f.id)
  await db.prepare(`DELETE FROM custom_field_definitions WHERE id NOT IN (${placeholdersFor(seedFieldIds)})`).bind(...seedFieldIds).run()

  // Canonical association config. instance_preset is deliberately NOT set — the
  // preset system is retired; the seed carries ai_context, relevance_question,
  // tag_taxonomy, and keywords directly.
  await batch([
    // Delete rather than skip: a demo tenant deployed before presets were retired
    // still carries the row, and while it exists ensureInstancePreset keeps
    // reporting a preset slug. Deleting it makes every demo tenant — old and new —
    // converge on "no preset". Safe because the four keys a preset would have
    // supplied are written from the seed immediately below.
    db.prepare(`DELETE FROM association_config WHERE key = 'instance_preset'`),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('association_name', ?)`).bind(JSON.stringify(`Demo — ${seed.associationName}`)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('ai_context', ?)`).bind(seed.aiContext),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('relevance_question', ?)`).bind(seed.relevanceQuestion),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('tag_taxonomy', ?)`).bind(JSON.stringify(seed.tagTaxonomy)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('keywords', ?)`).bind(JSON.stringify(seed.keywords)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('position_vocabulary', ?)`).bind(JSON.stringify(seed.positionVocabulary)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('org_noun', ?)`).bind(JSON.stringify(seed.orgNoun)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('demo_banner', ?)`).bind(JSON.stringify(seed.bannerText)),
    // Optional widgets start OFF so visitors can experience enabling them in
    // Settings → Modules (toggling modules is allowed in demo mode; all other
    // config stays locked). Nightly reset returns them to the seeded state.
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('modules', ?)`).bind(JSON.stringify(seed.modules)),
    db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('sessions', ?)`).bind(JSON.stringify({
      data: seed.sessions.data,
      cachedAt: new Date().toISOString(), // ts-write-ok: cache metadata inside a JSON config blob, never SQL-sorted
    })),
    // Only multi-state seeds carry a coverage list; a STATE-scoped tenant leaves
    // the key absent rather than writing an empty array.
    ...(seed.stateCoverage
      ? [db.prepare(`INSERT OR REPLACE INTO association_config (key, value) VALUES ('state_coverage', ?)`).bind(JSON.stringify(seed.stateCoverage))]
      : []),
  ])

  await db.prepare('PRAGMA foreign_keys = ON').run()

  // Step 3: Delete non-seed users and their sessions (keep-list from the seed)
  const seedUserIds = seed.users.map((u) => u.id)
  const placeholders = placeholdersFor(seedUserIds)
  await batch([
    db.prepare(`DELETE FROM sessions WHERE user_id NOT IN (${placeholders})`).bind(...seedUserIds),
    db.prepare(`DELETE FROM users WHERE id NOT IN (${placeholders})`).bind(...seedUserIds),
  ])

  // Step 3b: Seed an active login session for every demo persona.
  // The sidebar member count and the @everyone/@role mention lists only count
  // users that have a session row (the "exclude invite-pending users" rule in
  // stats.ts / users.ts), and the admin dashboard's active_members_7d/_30d are
  // derived from sessions.last_active. Demo personas never sign in via magic
  // link, so without these rows the app reports "1 member" despite the full
  // seeded roster. The seed's staggered lastActiveDaysAgo values give a
  // realistic active curve.
  const sessionExpires = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
  await batch(seed.users.map((u) =>
    db.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, token_hash, expires_at, last_active) VALUES (?, ?, ?, ?, ?)`)
      .bind(`demo-sess-${u.id}`, u.id, `demo-token-${u.id}`, sessionExpires, daysAgoDb(u.lastActiveDaysAgo)),
  ))

  // Step 3c: Seed a *used* magic link per persona so they count as accepted
  // members. The sidebar member count (stats.ts) counts users who accepted their
  // invite — `magic_links.used_at IS NOT NULL` — not users with a live session
  // row. Demo personas never run the magic-link flow, so without these rows the
  // sidebar reports "0 members" even though the Members page lists the full
  // roster. used_at is set to each persona's last_active for a realistic curve.
  await batch(seed.users.map((u) =>
    db.prepare(`INSERT OR REPLACE INTO magic_links (id, user_id, token_hash, expires_at, used_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(`demo-ml-${u.id}`, u.id, `demo-mltoken-${u.id}`, sessionExpires, daysAgoDb(u.lastActiveDaysAgo)),
  ))

  // Step 4: Re-seed engagement data. Every bill-linked insert uses the
  // INSERT ... SELECT ... WHERE (SELECT id FROM bills WHERE external_id = ?) IS NOT NULL
  // idiom so a seed row whose bill has not been ingested yet no-ops instead of
  // failing the batch.

  // Bill priorities
  const priorityExtIds = seed.priorities.map((p) => p.externalId)
  await batch([
    ...seed.priorities.map((p) =>
      db.prepare(`UPDATE bills SET priority = ? WHERE external_id = ?`).bind(p.priority, p.externalId),
    ),
    db.prepare(`UPDATE bills SET priority = NULL WHERE external_id NOT IN (${placeholdersFor(priorityExtIds)})`).bind(...priorityExtIds),
  ])

  // Official positions
  await batch(seed.positions.map((p) =>
    db.prepare(
      `INSERT OR IGNORE INTO official_positions (id, bill_id, position, set_by, created_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(p.id, p.externalId, p.position, p.setBy, daysAgoDb(p.daysAgo), p.externalId),
  ))

  // Member votes spread across several bills
  await batch(seed.votes.map((v) => {
    const ts = daysAgoDb(v.daysAgo)
    return db.prepare(
      `INSERT OR IGNORE INTO member_votes (id, bill_id, user_id, position, created_at, updated_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(v.id, v.externalId, v.userId, v.position, ts, ts, v.externalId)
  }))

  // Comments — some include @mentions (span[data-type=mention] format)
  await batch(seed.comments.map((c) =>
    db.prepare(
      `INSERT OR IGNORE INTO comments (id, bill_id, user_id, content, created_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(c.id, c.externalId, c.userId, c.content, daysAgoDb(c.daysAgo), c.externalId),
  ))

  // comment_mentions — one row per (comment, notified user). Guarded on the
  // comment existing, which itself is guarded on the bill existing.
  await batch(seed.mentions.map((m) =>
    db.prepare(
      `INSERT OR IGNORE INTO comment_mentions (id, comment_id, user_id, source_type, source_id, created_at)
       SELECT ?, id, ?, ?, ?, ?
       FROM comments WHERE id = ? LIMIT 1`
    ).bind(m.id, m.userId, m.sourceType, m.sourceId, daysAgoDb(m.daysAgo), m.commentId),
  ))

  // Reactions hang off comments, so they only land for comments that landed —
  // which in turn only land for bills that exist in this tenant. deleted_at is
  // left NULL; the unique index on (comment_id, user_id, emoji) makes the
  // OR IGNORE meaningful on a repeat reset.
  await batch(seed.reactions.map((r) =>
    db.prepare(
      `INSERT OR IGNORE INTO comment_reactions (id, comment_id, user_id, emoji, created_at)
       SELECT ?, id, ?, ?, ?
       FROM comments WHERE id = ? LIMIT 1`
    ).bind(r.id, r.userId, r.emoji, daysAgoDb(r.daysAgo), r.commentId),
  ))

  // Feed events
  await batch(seed.feedEvents.map((e) =>
    db.prepare(
      `INSERT OR IGNORE INTO feed_events (id, type, bill_id, user_id, metadata, created_at)
       SELECT ?, ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(e.id, e.type, e.externalId, e.userId, JSON.stringify(e.metadata), daysAgoDb(e.daysAgo), e.externalId),
  ))

  // Mark demo-user as having seen the feed as of now. All seeded feed events carry
  // past timestamps, so a "now" baseline keeps the Feed nav dot dark for fresh
  // demo visitors — without this, the re-created demo-user row has a null
  // last_seen_feed, which lights the dot after every nightly reset.
  await db.prepare(`UPDATE users SET last_seen_feed = datetime('now') WHERE id = 'demo-user'`).run()

  // Custom field values — spread across bills so filtering produces results
  await batch(seed.customFieldValues.map((v) =>
    db.prepare(
      `INSERT OR IGNORE INTO bill_custom_field_values (bill_id, field_id, value, set_by, updated_at)
       SELECT (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, ?, ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(v.externalId, v.fieldId, v.value, v.setBy, daysAgoDb(v.daysAgo), v.externalId),
  ))

  // Personal notes for demo-user
  await batch(seed.notes.map((n) =>
    db.prepare(
      `INSERT OR IGNORE INTO notes (id, bill_id, user_id, content, created_at)
       SELECT ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), 'demo-user', ?, ?
       WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
    ).bind(n.id, n.externalId, n.content, daysAgoDb(n.daysAgo), n.externalId),
  ))

  // Step 5: Seed calendar events (DEMO ONLY). Dates are now-relative so the calendar and
  // hearings widget always show fresh upcoming events; the nightly reset re-derives them.
  await batch(seed.calendarEvents.map((e) =>
    e.externalId === null
      ? db.prepare(
          `INSERT OR IGNORE INTO calendar_events (id, uid, bill_id, source, sequence, date, time, location, description, status, event_hash)
           VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, 'confirmed', NULL)`
        ).bind(e.id, `${e.id}@example.com`, e.source, dateFromNow(e.offsetDays), e.time, e.location, e.description)
      : db.prepare(
          `INSERT OR IGNORE INTO calendar_events (id, uid, bill_id, source, sequence, date, time, location, description, status, event_hash)
           SELECT ?, ?, (SELECT id FROM bills WHERE external_id = ? LIMIT 1), ?, 0, ?, ?, ?, ?, 'confirmed', NULL
           WHERE (SELECT id FROM bills WHERE external_id = ? LIMIT 1) IS NOT NULL`
        ).bind(e.id, `${e.id}@example.com`, e.externalId, e.source, dateFromNow(e.offsetDays), e.time, e.location, e.description, e.externalId),
  ))
}
