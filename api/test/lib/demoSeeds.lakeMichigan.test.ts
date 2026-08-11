import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill } from '../helpers'
import { runDemoReset } from '../../src/lib/demoReset'
import { DEMO_SEEDS, resolveDemoSeed } from '../../src/lib/demoSeeds'
import { LM_BILLS, LM_HEARING_NOTICE_SOURCES } from '../../src/lib/demoSeeds/lakeMichigan/bills'
import {
  stripHtml, truncateWithEllipsis, COMMENT_PREVIEW_MAX, PASSIVE_EVENT_TYPES, type FeedEvent,
} from '../../../shared/feedUtils'
import { LM_USER_ROLES } from '../../src/lib/demoSeeds/lakeMichigan/roster'

describe('lake-michigan seed registration', () => {
  it('is registered under its slug', () => {
    const s = DEMO_SEEDS['lake-michigan']
    expect(s).toBeDefined()
    expect(s.slug).toBe('lake-michigan')
    expect(resolveDemoSeed('lake-michigan')).toBe(s)
  })

  it('is a multi-state seed covering the four states plus Congress', () => {
    expect(DEMO_SEEDS['lake-michigan'].stateCoverage).toEqual(['MI', 'WI', 'IL', 'IN', 'US'])
  })

  it('names the organization without the Demo prefix (the machinery adds it)', () => {
    const n = DEMO_SEEDS['lake-michigan'].associationName
    expect(n).toBe('Lake Michigan Alliance')
    expect(n).not.toContain('Demo')
  })

  it('carries one session per covered jurisdiction, with LegiScan identifiers', () => {
    const ids = DEMO_SEEDS['lake-michigan'].sessions.data.map(s => s.identifier).sort()
    // WI is 2197 (2025-2026 Regular Session), NOT 2264 (May 2026 special session).
    expect(ids).toEqual(['2176', '2183', '2197', '2199', '2234'])
  })

  it('tells the visitor the org is fictional and that changes reset', () => {
    const b = DEMO_SEEDS['lake-michigan'].bannerText
    expect(b).not.toMatch(/read-only/i)
    expect(b).toMatch(/fictional/i)
    expect(b).toContain('the organization, its staff, and the hearing dates are fictional')
    expect(b).toMatch(/resets every few hours/i)
  })

  it('says the same of the New Jersey seed, which visitors can also write to', () => {
    const b = DEMO_SEEDS['nj-county-clerks'].bannerText
    expect(b).not.toMatch(/read-only/i)
    expect(b).not.toMatch(/nightly/i)
    expect(b).toMatch(/fictional/i)
    expect(b).toContain('the association, its county clerks, and the hearing dates are fictional')
    expect(b).toMatch(/resets every few hours/i)
  })

  it('ships no keyword that is empty or duplicated', () => {
    const k = DEMO_SEEDS['lake-michigan'].keywords
    expect(k.length).toBeGreaterThan(10)
    expect(k.every(x => x.trim().length > 0)).toBe(true)
    expect(new Set(k).size).toBe(k.length)
  })

  it('offers the standard position vocabulary', () => {
    expect(DEMO_SEEDS['lake-michigan'].positionVocabulary)
      .toEqual(['Support', 'Oppose', 'Amend', 'Monitor', 'No Position'])
  })

  it('leaves the optional widgets off so a visitor can turn them on', () => {
    const m = DEMO_SEEDS['lake-michigan'].modules
    expect(m['waiting-for-vote']).toBe(false)
    expect(m['upcoming-hearings']).toBe(false)
    expect(m['calendar']).toBe(true)
  })
})

describe('lake-michigan roster', () => {
  const s = DEMO_SEEDS['lake-michigan']

  it('has 15 staff, one of them the shared demo visitor account', () => {
    expect(s.users).toHaveLength(15)
    expect(s.users.filter(u => u.id === 'demo-user')).toHaveLength(1)
  })

  it('gives everyone a plain job title, not a Title · Org compound', () => {
    for (const u of s.users) {
      expect(u.subtitle.length).toBeGreaterThan(3)
      expect(u.subtitle).not.toContain('·')
    }
  })

  it('has three admins and the rest members', () => {
    expect(s.users.filter(u => u.role === 'admin')).toHaveLength(3)
  })

  it('has five jurisdiction teams and three single-word working groups', () => {
    const names = s.roles.map(r => r.name)
    expect(s.roles).toHaveLength(8)
    for (const t of ['Michigan Team', 'Wisconsin Team', 'Illinois Team', 'Indiana Team', 'Federal Team']) {
      expect(names).toContain(t)
    }
    for (const g of ['Infrastructure', 'Contaminants', 'Habitat']) {
      expect(names).toContain(g)
      expect(g.split(' ')).toHaveLength(1)
    }
  })

  it('puts every person on exactly one jurisdiction team', () => {
    const jur = new Set(s.roles.filter(r => r.name.endsWith(' Team')).map(r => r.id))
    for (const u of s.users) {
      const mine = s.userRoles.filter(ur => ur.userId === u.id && jur.has(ur.roleId))
      expect(mine, `${u.id} jurisdiction teams`).toHaveLength(1)
    }
  })

  it('references only real user and role ids in userRoles', () => {
    const uids = new Set(s.users.map(u => u.id))
    const rids = new Set(s.roles.map(r => r.id))
    for (const ur of s.userRoles) {
      expect(uids.has(ur.userId), `user ${ur.userId}`).toBe(true)
      expect(rids.has(ur.roleId), `role ${ur.roleId}`).toBe(true)
    }
  })

  it('defines five custom fields with Policy Concerns pinned', () => {
    expect(s.customFields).toHaveLength(5)
    const pinned = s.customFields.filter(f => f.pinned)
    expect(pinned).toHaveLength(1)
    expect(pinned[0].name).toBe('Policy Concerns')
    // The Working Group field and the working-group roles are meant to be ONE
    // vocabulary, so derive the expectation from the roles rather than restating a
    // literal — otherwise renaming a role leaves this passing while the two drift.
    const wg = s.customFields.find(f => f.slug === 'working-group')!
    const workingGroupRoles = s.roles.filter(r => !r.name.endsWith(' Team')).map(r => r.name)
    expect(workingGroupRoles).toHaveLength(3)
    expect(wg.options).toEqual(workingGroupRoles)
  })

  it('gives dropdowns options and non-dropdowns none', () => {
    for (const f of s.customFields) {
      if (f.type === 'dropdown') expect(Array.isArray(f.options)).toBe(true)
      else expect(f.options).toBeNull()
    }
  })
})

describe('lake-michigan bills', () => {
  const s = DEMO_SEEDS['lake-michigan']
  const extIds = () => s.priorities.map(p => p.externalId)

  it('tracks 20 bills, every one with a priority', () => {
    expect(s.priorities).toHaveLength(20)
    for (const p of s.priorities) {
      expect(['high', 'medium', 'low']).toContain(p.priority)
      expect(p.externalId).toMatch(/^legiscan:\d+$/)
    }
    expect(new Set(extIds()).size).toBe(20)
  })

  it('spans all five jurisdictions', () => {
    const byJur = new Map<string, number>()
    for (const b of LM_BILLS) byJur.set(b.jurisdiction, (byJur.get(b.jurisdiction) ?? 0) + 1)
    expect([...byJur.keys()].sort()).toEqual(['IL', 'IN', 'MI', 'US', 'WI'])
    expect(byJur.get('MI')).toBe(5)
    expect(byJur.get('WI')).toBe(4)
    expect(byJur.get('IL')).toBe(4)
    expect(byJur.get('IN')).toBe(3)
    expect(byJur.get('US')).toBe(4)
  })

  it('schedules hearings only on bills that are still live', () => {
    const live = new Set(LM_BILLS.filter(b => b.live).map(b => b.externalId))
    const hearings = s.calendarEvents.filter(e => e.source === 'hearing')
    expect(hearings.length).toBeGreaterThanOrEqual(6)
    for (const h of hearings) {
      expect(h.externalId, `hearing ${h.id} must be on a live bill`).not.toBeNull()
      expect(live.has(h.externalId!), `hearing ${h.id} on ${h.externalId}`).toBe(true)
      expect(h.offsetDays, `hearing ${h.id} must be upcoming`).toBeGreaterThan(0)
    }
  })

  it('references only known bills and users from bill-linked rows', () => {
    const known = new Set(extIds())
    const uids = new Set(s.users.map(u => u.id))
    for (const p of s.positions) {
      expect(known.has(p.externalId), `position ${p.id}`).toBe(true)
      expect(uids.has(p.setBy), `position setBy ${p.setBy}`).toBe(true)
    }
    for (const v of s.customFieldValues) {
      expect(known.has(v.externalId), `cfv ${v.externalId}`).toBe(true)
      expect(uids.has(v.setBy), `cfv setBy ${v.setBy}`).toBe(true)
    }
    for (const e of s.calendarEvents) {
      if (e.externalId !== null) expect(known.has(e.externalId), `event ${e.id}`).toBe(true)
    }
  })

  it('uses only defined custom field ids and valid dropdown options', () => {
    const byId = new Map(s.customFields.map(f => [f.id, f]))
    for (const v of s.customFieldValues) {
      const f = byId.get(v.fieldId)
      expect(f, `field ${v.fieldId}`).toBeDefined()
      if (f!.type === 'dropdown') expect(f!.options).toContain(v.value)
      if (f!.type === 'binary') expect(v.value).toBe('1')
    }
  })

  it('gives every bill_updated event a system author and real change records', () => {
    const upd = s.feedEvents.filter(e => e.type === 'bill_updated')
    expect(upd.length).toBeGreaterThanOrEqual(20)
    for (const e of upd) {
      expect(e.userId).toBe('system')
      const changes = (e.metadata as { changes?: unknown[] }).changes
      expect(Array.isArray(changes) && changes!.length > 0, `event ${e.id}`).toBe(true)
    }
  })
})

describe('lake-michigan derived feed events', () => {
  const s = DEMO_SEEDS['lake-michigan']

  it('emits exactly one comment_added event per comment', () => {
    const ev = s.feedEvents.filter(e => e.type === 'comment_added')
    expect(ev).toHaveLength(s.comments.length)
    const ids = ev.map(e => (e.metadata as { commentId: string }).commentId).sort()
    expect(ids).toEqual(s.comments.map(c => c.id).sort())
  })

  it('derives each preview from its comment, so they cannot drift', () => {
    const byId = new Map(s.comments.map(c => [c.id, c]))
    for (const e of s.feedEvents.filter(x => x.type === 'comment_added')) {
      const m = e.metadata as { commentId: string; preview: string }
      const c = byId.get(m.commentId)!
      expect(m.preview).toBe(truncateWithEllipsis(stripHtml(c.content), COMMENT_PREVIEW_MAX))
      expect(e.userId).toBe(c.userId)
      expect(e.externalId).toBe(c.externalId)
      expect(e.daysAgo).toBe(c.daysAgo)
    }
  })

  it('carries mentioned user ids on events whose comment mentions someone', () => {
    for (const e of s.feedEvents.filter(x => x.type === 'comment_added')) {
      const m = e.metadata as { commentId: string; mentionedUserIds?: string[] }
      const expected = s.mentions.filter(x => x.commentId === m.commentId).map(x => x.userId).sort()
      expect((m.mentionedUserIds ?? []).slice().sort()).toEqual(expected)
    }
  })

  it('carries three hearing notices, detailed straight from the calendar', () => {
    // Keyed on the calendar row `hearingNotice()` actually read, not on a row found
    // by bill: a bill carrying two hearings would let a bill-keyed lookup match the
    // wrong one and pass while the feed row and the calendar disagreed.
    const sourceOf = new Map(LM_HEARING_NOTICE_SOURCES.map(x => [x.eventId, x.calendarId]))
    const hearings = s.feedEvents.filter(e => e.type === 'hearing_added')
    expect(hearings).toHaveLength(3)
    expect(hearings.map(e => e.id).sort()).toEqual([...sourceOf.keys()].sort())
    for (const e of hearings) {
      expect(e.userId).toBe('system')
      const cal = s.calendarEvents.find(c => c.id === sourceOf.get(e.id))
      expect(cal, `hearing event ${e.id} needs its source calendar entry`).toBeDefined()
      expect(cal!.source).toBe('hearing')
      expect(e.externalId).toBe(cal!.externalId)
      expect(e.metadata).toEqual({ time: cal!.time, location: cal!.location, description: cal!.description })
      // The point of the type change: no invented LegiScan action string rides along.
      expect(e.metadata, `${e.id} must not carry bill_updated changes`).not.toHaveProperty('changes')
    }
  })

  it('lands each hearing notice ahead of thread that reacts to it', () => {
    // Read top-down, a notice that arrives after the staff are already planning for
    // the hearing makes them look clairvoyant and the system look late. Whether a
    // given sentence is "reacting" is not machine-readable, but the necessary
    // condition is: some comment on that bill has to postdate the notice.
    for (const e of s.feedEvents.filter(x => x.type === 'hearing_added')) {
      const after = s.comments.filter(c => c.externalId === e.externalId && c.daysAgo < e.daysAgo)
      expect(after.length, `nothing in ${e.externalId}'s thread postdates notice ${e.id}`)
        .toBeGreaterThan(0)
    }
  })

  it('uses only real change types and never fabricates a hearing notice as one', () => {
    // Hearing details ride on hearing_added rows, which is what the calendar
    // reconciler emits. A bill_updated change claiming a hearing notice would be a
    // provider action string the provider never produced. The changeType check is
    // the general form of the same property: nothing outside ChangeRecord's
    // vocabulary gets invented either.
    for (const e of s.feedEvents.filter(x => x.type === 'bill_updated')) {
      const changes = (e.metadata as { changes: Array<{ changeType: string; newValue: string | null }> }).changes
      for (const ch of changes) {
        expect(['status_change', 'action_added', 'vote_added', 'amendment_added'], `${e.id} changeType`)
          .toContain(ch.changeType)
        expect(ch.newValue ?? '', `${e.id}`).not.toMatch(/hearing notice/i)
      }
    }
  })

  it('gives every feed event a unique id and a known bill', () => {
    const ids = s.feedEvents.map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const known = new Set(s.priorities.map(p => p.externalId))
    for (const e of s.feedEvents) expect(known.has(e.externalId), `event ${e.id}`).toBe(true)
  })
})

describe('lake-michigan discussion', () => {
  const s = DEMO_SEEDS['lake-michigan']

  // Length is guarded by the COMMENT_PREVIEW_MAX check further down, which is the
  // stricter cap; this one is only about register.
  it('writes comments as conversation, not formatted policy analysis', () => {
    for (const c of s.comments) {
      expect(c.content, `${c.id} must not use bulleted analysis`).not.toContain('<ul>')
      expect(c.content, `${c.id} must not use bold headers`).not.toContain('<strong>')
    }
  })

  it('resolves every comment, reaction, mention, vote, and note reference', () => {
    const uids = new Set(s.users.map(u => u.id))
    const rids = new Set(s.roles.map(r => r.id))
    const bills = new Set(s.priorities.map(p => p.externalId))
    const cids = new Set(s.comments.map(c => c.id))
    for (const c of s.comments) {
      expect(uids.has(c.userId), `comment ${c.id} user`).toBe(true)
      expect(bills.has(c.externalId), `comment ${c.id} bill`).toBe(true)
    }
    for (const r of s.reactions) {
      expect(cids.has(r.commentId), `reaction ${r.id} comment`).toBe(true)
      expect(uids.has(r.userId), `reaction ${r.id} user`).toBe(true)
    }
    for (const m of s.mentions) {
      expect(cids.has(m.commentId), `mention ${m.id} comment`).toBe(true)
      expect(uids.has(m.userId), `mention ${m.id} target`).toBe(true)
      if (m.sourceType === 'role') expect(rids.has(m.sourceId), `mention ${m.id} role`).toBe(true)
      else expect(uids.has(m.sourceId), `mention ${m.id} user`).toBe(true)
    }
    for (const v of s.votes) {
      expect(uids.has(v.userId), `vote ${v.id} user`).toBe(true)
      expect(bills.has(v.externalId), `vote ${v.id} bill`).toBe(true)
    }
    for (const n of s.notes) expect(bills.has(n.externalId), `note ${n.id} bill`).toBe(true)
  })

  it('never lets a reaction predate its comment', () => {
    const byId = new Map(s.comments.map(c => [c.id, c]))
    for (const r of s.reactions) {
      expect(r.daysAgo, `reaction ${r.id}`).toBeLessThanOrEqual(byId.get(r.commentId)!.daysAgo)
    }
  })

  it('has no duplicate reaction from one person on one comment with one emoji', () => {
    const seen = new Set(s.reactions.map(r => `${r.commentId}|${r.userId}|${r.emoji}`))
    expect(seen.size).toBe(s.reactions.length)
  })

  it('has one vote per member per bill', () => {
    const seen = new Set(s.votes.map(v => `${v.externalId}|${v.userId}`))
    expect(seen.size).toBe(s.votes.length)
  })

  it('never records a vote from a member who cannot vote', () => {
    // demoReset writes member_votes straight from the seed without consulting
    // users.can_vote, so a vote from a non-voting member would put the demo in a
    // state the app itself cannot produce — the vote controls are hidden for those
    // users. The seed deliberately includes one non-voter to show that state, so
    // assert both halves: the non-voter exists, and casts nothing.
    const nonVoters = new Set(s.users.filter(u => !u.canVote).map(u => u.id))
    expect(nonVoters.size, 'seed should include a non-voting member').toBeGreaterThan(0)
    for (const v of s.votes) {
      expect(nonVoters.has(v.userId), `${v.id}: ${v.userId} cannot vote`).toBe(false)
    }
  })

  it('uses only valid member vote positions, and exercises all three', () => {
    for (const v of s.votes) expect(['support', 'oppose', 'neutral']).toContain(v.position)
    // A demo that sells the voting feature has to show its third state somewhere.
    for (const p of ['support', 'oppose', 'neutral']) {
      expect(s.votes.some(v => v.position === p), `no ${p} vote anywhere`).toBe(true)
    }
  })

  // A comment longer than the preview cap renders on its feed card cut off with a
  // mid-sentence ellipsis. Nothing in this seed is long enough to need that.
  it('keeps every comment inside the feed preview, so no card ends mid-sentence', () => {
    for (const c of s.comments) {
      const text = stripHtml(c.content)
      expect(text.length, `${c.id} overflows the ${COMMENT_PREVIEW_MAX}-char preview: ${text}`)
        .toBeLessThanOrEqual(COMMENT_PREVIEW_MAX)
    }
  })
})

/**
 * These three checks are the ones with teeth. The derivation tests above recompute
 * a derived value with the same helper that produced it, so they lock behaviour in
 * but cannot catch bad hand-written data. Mentions ARE hand-written, and the three
 * ways they can be wrong — self-notification, a half-finished role fan-out, and a
 * row/markup mismatch — are all invisible on a casual read of the seed.
 */
describe('lake-michigan mention fan-out', () => {
  const s = DEMO_SEEDS['lake-michigan']
  const commentsById = new Map(s.comments.map(c => [c.id, c]))
  const roleMembers = (roleId: string) =>
    new Set(LM_USER_ROLES.filter(ur => ur.roleId === roleId).map(ur => ur.userId))
  /** Every `data-id="role:x"` / `data-id="user:x"` mention span in a comment. */
  const spansIn = (html: string) =>
    [...html.matchAll(/data-id="(user|role):([^"]+)"/g)].map(m => ({ sourceType: m[1], sourceId: m[2] }))
  /** Who a mention on `comment` should reach: role membership (or the named user)
   *  minus the comment's own author, exactly as api/src/lib/mentions.ts resolves it. */
  const audience = (span: { sourceType: string; sourceId: string }, authorUserId: string) => {
    const set = span.sourceType === 'role' ? roleMembers(span.sourceId) : new Set([span.sourceId])
    set.delete(authorUserId)
    return set
  }

  it('never notifies a comment author of their own comment', () => {
    for (const m of s.mentions) {
      const author = commentsById.get(m.commentId)!.userId
      // api/src/lib/mentions.ts filters the author out (`rm.userId !== authorUserId`),
      // so the app can never write such a row. A seeded one would show the demo
      // visitor an unread "you were mentioned" pointing at their own comment,
      // because notificationsApi.ts selects every comment_mentions row for them.
      expect(m.userId, `mention ${m.id} on ${m.commentId} targets its own author`).not.toBe(author)
    }
  })

  it('fans a role mention out to every member of that role except the author', () => {
    const pairs = new Set(
      s.mentions.filter(m => m.sourceType === 'role').map(m => `${m.commentId}|${m.sourceId}`),
    )
    expect(pairs.size).toBeGreaterThanOrEqual(8)
    for (const pair of pairs) {
      const [commentId, roleId] = pair.split('|')
      const got = s.mentions
        .filter(m => m.commentId === commentId && m.sourceType === 'role' && m.sourceId === roleId)
        .map(m => m.userId)
      // A partial fan-out looks fine in the UI but means some teammates silently
      // never get notified, so the whole membership has to be present.
      expect(new Set(got), `@${roleId} on ${commentId}`)
        .toEqual(audience({ sourceType: 'role', sourceId: roleId }, commentsById.get(commentId)!.userId))
      expect(got.length, `duplicate rows for @${roleId} on ${commentId}`).toBe(new Set(got).size)
    }
  })

  it('has mention rows for every mention span, and a span for every mention row', () => {
    for (const c of s.comments) {
      const rows = s.mentions.filter(m => m.commentId === c.id)
      const spans = spansIn(c.content)
      // Span → rows: markup the app would resolve into notifications must have them.
      for (const span of spans) {
        const got = rows
          .filter(m => m.sourceType === span.sourceType && m.sourceId === span.sourceId)
          .map(m => m.userId)
        expect(new Set(got), `${c.id} span ${span.sourceType}:${span.sourceId} has no matching rows`)
          .toEqual(audience(span, c.userId))
      }
      // Rows → span: a row with no markup behind it is a notification the reader
      // can't explain when they open the comment.
      const spanKeys = new Set(spans.map(x => `${x.sourceType}:${x.sourceId}`))
      for (const m of rows) {
        expect(spanKeys.has(`${m.sourceType}:${m.sourceId}`), `mention ${m.id} has no span in ${c.id}`).toBe(true)
      }
    }
  })
})

describe('lake-michigan feed density', () => {
  const s = DEMO_SEEDS['lake-michigan']
  // `daysAgo` is already a whole-day bucket, so it groups directly.

  it('has enough discussion to look inhabited', () => {
    expect(s.comments.length).toBeGreaterThanOrEqual(70)
    expect(s.reactions.length).toBeGreaterThanOrEqual(30)
    expect(s.votes.length).toBeGreaterThanOrEqual(60)
  })

  it('covers every bill with at least three comments', () => {
    for (const p of s.priorities) {
      const n = s.comments.filter(c => c.externalId === p.externalId).length
      expect(n, `${p.externalId} comment count`).toBeGreaterThanOrEqual(3)
    }
  })

  it('produces at least 12 bill-day groups within the last 14 days', () => {
    const groups = new Set(
      s.feedEvents.filter(e => e.daysAgo <= 14).map(e => `${e.externalId}::${e.daysAgo}`),
    )
    expect(groups.size).toBeGreaterThanOrEqual(12)
  })

  it('produces at least 4 bill-day groups within the last 72 hours', () => {
    const groups = new Set(
      s.feedEvents.filter(e => e.daysAgo <= 3).map(e => `${e.externalId}::${e.daysAgo}`),
    )
    expect(groups.size).toBeGreaterThanOrEqual(4)
  })

  it('has at least one bill-day group carrying three or more events', () => {
    const counts = new Map<string, number>()
    for (const e of s.feedEvents) {
      const k = `${e.externalId}::${e.daysAgo}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(3)
  })

  it('mixes legislative activity with discussion in the recent window', () => {
    const recent = s.feedEvents.filter(e => e.daysAgo <= 14)
    // "Legislative activity" is any provider-sourced (passive) event, not
    // bill_updated specifically — the three recent ones are hearing notices, and
    // none of the 20 bills happens to have a real LegiScan action inside 14 days.
    expect(recent.some(e => PASSIVE_EVENT_TYPES.has(e.type as FeedEvent['type']))).toBe(true)
    expect(recent.some(e => e.type === 'comment_added')).toBe(true)
  })

  it('mentions teams, not just people', () => {
    expect(s.mentions.filter(m => m.sourceType === 'role').length).toBeGreaterThanOrEqual(8)
  })
})

// The one thing a pure data test cannot settle: whether D1 accepts the row. The
// feed_events type CHECK constraint is rebuilt by migration (0043 added the hearing
// types, 0053 last touched it), so `hearing_added` has to survive a real reset
// against a real migrated schema, not just typecheck.
describe('lake-michigan hearing notices through a real demo reset', () => {
  const s = DEMO_SEEDS['lake-michigan']

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('writes every hearing_added row, with the calendar details intact', async () => {
    const expected = s.feedEvents.filter(e => e.type === 'hearing_added')
    expect(expected.length).toBeGreaterThan(0)
    // The insert is guarded on the bill existing, so the bills have to be there.
    for (const e of expected) {
      await seedBill({ externalId: e.externalId, billNumber: e.externalId, title: e.externalId })
    }

    await runDemoReset(env.DB, s)

    const rows = await env.DB.prepare(
      `SELECT id, user_id, metadata FROM feed_events WHERE type = 'hearing_added' ORDER BY id`
    ).all<{ id: string; user_id: string; metadata: string }>()
    expect(rows.results.map(r => r.id)).toEqual(expected.map(e => e.id).sort())
    for (const r of rows.results) {
      expect(r.user_id).toBe('system')
      const m = JSON.parse(r.metadata) as Record<string, unknown>
      expect(Object.keys(m).sort()).toEqual(['description', 'location', 'time'])
      expect(String(m.description)).toMatch(/hearing/i)
    }
  })
})
