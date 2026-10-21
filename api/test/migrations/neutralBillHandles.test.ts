import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, parseMigration } from '../helpers'
import migration0119 from '../../migrations/0119_neutral_bill_handles.sql?raw'

// 0119 is release 2 of the neutral handle rename (#305): every stored bill
// handle `legiscan:<n>` becomes `bill:<n>`, in `bills.external_id` and in both
// ends of `bill_identical_links`. Only well-formed handles move. Bill ids, the
// rows that hang off them, calendar UIDs, and stored text keys stay exactly as
// they were, and a bill already held under both spellings breaks neither the
// unique index on `bills.external_id` nor the links' primary key. Invented
// bills throughout.

async function run(sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql).bind(...binds).run()
}

async function bill(id: string, externalId: string | null, extra: { textR2Key?: string } = {}) {
  await run(`INSERT INTO bills (id, external_id, bill_number, title, state, text_r2_key) VALUES (?, ?, ?, 't', 'RI', ?)`,
    id, externalId, `H ${id}`, extra.textR2Key ?? null)
}

async function link(a: string, b: string) {
  await run('INSERT INTO bill_identical_links (external_id, companion_external_id) VALUES (?, ?)', a, b)
}

const handles = async () => (await env.DB.prepare('SELECT id, external_id FROM bills ORDER BY id').all<{ id: string; external_id: string | null }>()).results
  .map(r => [r.id, r.external_id])
const links = async () => (await env.DB.prepare('SELECT external_id, companion_external_id FROM bill_identical_links ORDER BY 1, 2').all<{ external_id: string; companion_external_id: string }>()).results
  .map(r => [r.external_id, r.companion_external_id])

/** Every row of every table the migration could reach, for a byte-for-byte comparison. */
async function snapshot() {
  const out: Record<string, unknown[]> = {}
  for (const table of ['bills', 'bill_identical_links', 'calendar_events', 'notes', 'member_votes', 'comments', 'bill_texts']) {
    out[table] = (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()).results
  }
  return out
}

/** Run 0119's statements again, as a second apply would. */
async function rerun() {
  for (const q of parseMigration(migration0119, '0119').queries) await env.DB.prepare(q).run()
}

beforeEach(async () => {
  await resetDb()
  await applyMigrations({ before: '0119_neutral_bill_handles' })
})

describe('migration 0119: stored bill handles take the neutral prefix', () => {
  it('rewrites a well-formed legacy handle in bills.external_id, small and large ids alike', async () => {
    await bill('b1', 'legiscan:1')
    await bill('b2', 'legiscan:2099974')
    await bill('b3', 'legiscan:2147483649')
    await applyMigrations()
    expect(await handles()).toEqual([['b1', 'bill:1'], ['b2', 'bill:2099974'], ['b3', 'bill:2147483649']])
  })

  it.each([
    ['a missing id', 'legiscan:'],
    ['id zero', 'legiscan:0'],
    ['letters', 'legiscan:abc'],
    ['trailing junk', 'legiscan:12x'],
    ['a leading zero', 'legiscan:012'],
    ['a space before the id', 'legiscan: 12'],
    ['an uppercase prefix', 'LEGISCAN:12'],
    ['an ocd-bill id', 'ocd-bill/abc'],
    ['a bare id', '12'],
  ])('leaves %s in bills.external_id as it is', async (_, value) => {
    await bill('odd', value)
    await bill('ok', 'legiscan:7')
    await applyMigrations()
    expect(await handles()).toEqual([['odd', value], ['ok', 'bill:7']])
  })

  it('leaves a draft (no handle) and an already-neutral handle as they are', async () => {
    await bill('draft', null)
    await bill('done', 'bill:8')
    await applyMigrations()
    expect(await handles()).toEqual([['done', 'bill:8'], ['draft', null]])
  })

  it('keeps every bill id, and every note, vote, comment, text, and calendar entry on its bill', async () => {
    await bill('b1', 'legiscan:101')
    await bill('b2', 'legiscan:102')
    await run(`INSERT INTO notes (id, bill_id, user_id, content) VALUES ('n1', 'b1', 'u1', 'note')`)
    await run(`INSERT INTO member_votes (id, user_id, bill_id, position) VALUES ('v1', 'u1', 'b1', 'support'), ('v2', 'u2', 'b2', 'oppose')`)
    await run(`INSERT INTO comments (id, bill_id, user_id, content) VALUES ('c1', 'b2', 'u1', 'hi')`)
    await run(`INSERT INTO bill_texts (id, bill_id, doc_id, type, date) VALUES ('t1', 'b1', '9', 'Introduced', '2026-01-01')`)
    await run(`INSERT INTO calendar_events (id, uid, bill_id, source, date) VALUES ('e1', 'hearing-legiscan-101-1-house@ri', 'b1', 'hearing', '2026-06-01')`)
    const before = await snapshot()
    await applyMigrations()
    const after = await snapshot()
    for (const table of ['calendar_events', 'notes', 'member_votes', 'comments', 'bill_texts']) expect(after[table], table).toEqual(before[table])
    expect((after.bills as { id: string }[]).map(b => b.id)).toEqual(['b1', 'b2'])
  })

  it('leaves hearing UIDs and stored text keys byte-identical', async () => {
    await bill('b1', 'legiscan:101', { textR2Key: 'bills/legiscan-101/texts/9.pdf' })
    await run(`INSERT INTO calendar_events (id, uid, bill_id, source, date) VALUES
      ('e1', 'hearing-legiscan-101-1-house-cmte-on-elections@ri', 'b1', 'hearing', '2026-06-01'),
      ('e2', 'body-lims-2405@floorvote.org', NULL, 'body', '2026-06-02')`)
    await applyMigrations()
    const uids = (await env.DB.prepare('SELECT uid FROM calendar_events ORDER BY id').all<{ uid: string }>()).results.map(r => r.uid)
    expect(uids).toEqual(['hearing-legiscan-101-1-house-cmte-on-elections@ri', 'body-lims-2405@floorvote.org'])
    const key = await env.DB.prepare(`SELECT text_r2_key FROM bills WHERE id = 'b1'`).first<string>('text_r2_key')
    expect(key).toBe('bills/legiscan-101/texts/9.pdf')
    expect(await handles()).toEqual([['b1', 'bill:101']])
  })

  it('keeps both rows of a bill already held in both spellings, so the unique index holds', async () => {
    await bill('old', 'legiscan:300')
    await bill('new', 'bill:300')
    await bill('other', 'legiscan:301')
    await applyMigrations()
    expect(await handles()).toEqual([['new', 'bill:300'], ['old', 'legiscan:300'], ['other', 'bill:301']])
  })

  it('rewrites both ends of every identical link', async () => {
    await link('legiscan:1', 'legiscan:2')
    await link('legiscan:3', 'bill:4')
    await link('bill:5', 'legiscan:6')
    await applyMigrations()
    expect(await links()).toEqual([['bill:1', 'bill:2'], ['bill:3', 'bill:4'], ['bill:5', 'bill:6']])
  })

  it('collapses a link held in several spellings into one, so the primary key holds', async () => {
    await link('legiscan:10', 'legiscan:20')
    await link('bill:10', 'legiscan:20')
    await link('legiscan:10', 'bill:20')
    await link('bill:10', 'bill:20')
    await link('legiscan:20', 'legiscan:10')
    await applyMigrations()
    expect(await links()).toEqual([['bill:10', 'bill:20'], ['bill:20', 'bill:10']])
  })

  it('collapses a link whose ends are held in both spellings even when no row is fully neutral yet', async () => {
    await link('legiscan:11', 'legiscan:21')
    await link('bill:11', 'legiscan:21')
    await link('legiscan:11', 'bill:21')
    await applyMigrations()
    expect(await links()).toEqual([['bill:11', 'bill:21']])
  })

  it.each([
    ['legiscan:'], ['legiscan:0'], ['legiscan:abc'], ['legiscan:12x'], ['ocd-bill/abc'],
  ])('leaves a link end of %j as it is', async (odd) => {
    await link(odd, 'legiscan:9')
    await link('legiscan:9', odd)
    await applyMigrations()
    expect(await links()).toEqual([['bill:9', odd], [odd, 'bill:9']].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
  })

  it('changes nothing on a second run', async () => {
    await bill('b1', 'legiscan:1')
    await bill('dup-old', 'legiscan:2')
    await bill('dup-new', 'bill:2')
    await bill('odd', 'legiscan:12x')
    await bill('draft', null)
    await link('legiscan:1', 'legiscan:2')
    await link('bill:1', 'legiscan:2')
    await link('legiscan:12x', 'legiscan:1')
    await run(`INSERT INTO calendar_events (id, uid, bill_id, source, date) VALUES ('e1', 'hearing-legiscan-1-x@ri', 'b1', 'hearing', '2026-06-01')`)
    await applyMigrations()
    const once = await snapshot()
    expect(await handles()).toContainEqual(['b1', 'bill:1'])
    await rerun()
    expect(await snapshot()).toEqual(once)
  })

  it('is a no-op on a database with no handles', async () => {
    await applyMigrations()
    expect(await handles()).toEqual([])
    expect(await links()).toEqual([])
  })

  it('keeps semicolons out of its comments, which the statement splitter would cut on', () => {
    for (const line of migration0119.split('\n').filter(l => l.trimStart().startsWith('--'))) expect(line).not.toContain(';')
  })
})
