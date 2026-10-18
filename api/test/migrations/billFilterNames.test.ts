import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { applyMigrations, resetDb, parseMigration } from '../helpers'
import { parseBillFilter } from '../../../shared/billFilter'
import migrationSql from '../../migrations/0111_bill_filter_names.sql?raw'

// One name per filter (#699): a saved view stores a serialized bill filter, and three of its keys were renamed:
// `q` to `search`, `cf_<slug>` to `field.<slug>`, and the API-only `session` to `sessionName`. The tenant
// migration rewrites every stored view's query to the new keys and leaves everything else in it byte for byte.

type Row = { id: string; query: string; updated_at: string }

const UPDATED_AT = '2026-01-02 03:04:05'

async function seedViews(views: Record<string, string>) {
  let order = 0
  for (const [id, query] of Object.entries(views)) {
    await env.DB.prepare(
      'INSERT INTO saved_views (id, name, query, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, `View ${id}`, query, order++, UPDATED_AT, UPDATED_AT).run()
  }
}

async function views(): Promise<Record<string, Row>> {
  const { results } = await env.DB.prepare('SELECT id, query, updated_at FROM saved_views').all<Row>()
  return Object.fromEntries(results.map(r => [r.id, r]))
}

const queries = async () => Object.fromEntries(Object.entries(await views()).map(([id, r]) => [id, r.query]))

/** Run the migration's statements again over the database as it stands. */
async function rerun() {
  for (const q of parseMigration(migrationSql, '0111').queries) await env.DB.prepare(q).run()
}

describe('0111_bill_filter_names', () => {
  beforeEach(async () => {
    await resetDb()
    // Seed the views as a database from before this migration holds them, then run the rest.
    await applyMigrations({ before: '0111' })
  })

  const migrate = async (seed: Record<string, string>) => {
    await seedViews(seed)
    await applyMigrations()
    return queries()
  }

  describe('rewrites each renamed key', () => {
    it('q to search', async () => {
      expect((await migrate({ v: 'q=lead+pipes' })).v).toBe('search=lead+pipes')
    })

    it('cf_<slug> to field.<slug>', async () => {
      expect((await migrate({ v: 'cf_working-group=Infrastructure&position=none' })).v)
        .toBe('field.working-group=Infrastructure&position=none')
    })

    it('cf_<id> to field.<id>, a field named by its id', async () => {
      expect((await migrate({ v: 'cf_3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c=1' })).v)
        .toBe('field.3f2a9c1e-7b4d-4a8e-9c55-0d1e2f3a4b5c=1')
    })

    it('session to sessionName', async () => {
      expect((await migrate({ v: 'session=2025-2026+Regular+Session' })).v).toBe('sessionName=2025-2026+Regular+Session')
    })

    it('every value of a repeated key', async () => {
      expect((await migrate({ v: 'cf_team=Ada&cf_team=Bo&session=S1&session=S2' })).v)
        .toBe('field.team=Ada&field.team=Bo&sessionName=S1&sessionName=S2')
    })

    it('a renamed key first, in the middle, and last', async () => {
      const got = await migrate({
        first: 'q=x&status=Passed',
        middle: 'status=Passed&q=x&tag=Energy',
        last: 'status=Passed&tag=Energy&q=x',
      })
      expect(got).toEqual({
        first: 'search=x&status=Passed',
        middle: 'status=Passed&search=x&tag=Energy',
        last: 'status=Passed&tag=Energy&search=x',
      })
    })

    it('a key with no value', async () => {
      expect((await migrate({ v: 'status=1&q&session&cf_team' })).v).toBe('status=1&search&sessionName&field.team')
    })

    it('a query stored with a leading question mark, keeping it', async () => {
      expect((await migrate({ v: '?q=x&cf_team=Ada' })).v).toBe('?search=x&field.team=Ada')
    })
  })

  it('rewrites a view that mixes every renamed key with keys that stay, in the order they were stored', async () => {
    const got = await migrate({
      v: 'cf_committee=Labor&match=any&q=water&session=S&sort=priority&dir=desc&state=MI&status=Passed&tag=Energy',
    })
    expect(got.v).toBe('field.committee=Labor&match=any&search=water&sessionName=S&sort=priority&dir=desc&state=MI&status=Passed&tag=Energy')
  })

  it('rewrites a view that has both an old key and its new one', async () => {
    expect((await migrate({ v: 'q=old&search=new' })).v).toBe('search=old&search=new')
  })

  it('leaves the encoded values alone, including ones that spell an old key', async () => {
    const got = await migrate({
      v: 'q=a%26q%3Dx+%26session%3D1&tag=cf_thing&tag=Water+%26+Power&subject=UT%3AElection+Law%3A+Voting&cf_area=50%25&cf_area=caf%C3%A9',
    })
    expect(got.v).toBe(
      'search=a%26q%3Dx+%26session%3D1&tag=cf_thing&tag=Water+%26+Power&subject=UT%3AElection+Law%3A+Voting&field.area=50%25&field.area=caf%C3%A9',
    )
    // The value still reads back as it was written.
    expect(parseBillFilter(got.v).search).toBe('a&q=x &session=1')
    expect(parseBillFilter(got.v).field).toEqual({ area: ['50%', 'café'] })
  })

  it('reads back as the filter the old keys described, through the shared parse', async () => {
    const got = await migrate({ v: 'cf_team=Ada&match=any&q=water+rights&session=S&tag=Energy' })
    expect(parseBillFilter(got.v)).toMatchObject({
      field: { team: ['Ada'] }, match: 'any', search: 'water rights', sessionName: ['S'], tag: ['Energy'],
    })
  })

  describe('leaves alone', () => {
    const untouched = {
      none: 'priority=high&state=MI&state=WI',
      operator: 'match=any&tag=Drinking+Water&position=none',
      lookalikes: 'qq=1&quality=2&sessions=3&sessionNames=4&xcf_a=5&cfx=6&field=7&searchq=8&tag=q%3D1',
      migrated: 'search=x&field.team=Ada&sessionName=S',
      sortOnly: 'sort=session&dir=asc',
      empty: '',
    }

    it('a view that uses none of the renamed keys, byte for byte', async () => {
      expect(await migrate(untouched)).toEqual(untouched)
    })

    it('the updated time of every view, rewritten or not', async () => {
      await migrate({ ...untouched, renamed: 'q=x&cf_team=Ada&session=S' })
      for (const row of Object.values(await views())) expect(row.updated_at, row.id).toBe(UPDATED_AT)
    })

    it('the name, slug, and order of a rewritten view', async () => {
      await env.DB.prepare(
        `INSERT INTO saved_views (id, name, query, slug, previous_slug, display_order) VALUES ('v', 'Water', 'q=x', 'water', 'old-water', 7)`,
      ).run()
      await applyMigrations()
      const row = await env.DB.prepare('SELECT name, query, slug, previous_slug, display_order FROM saved_views').first()
      expect(row).toEqual({ name: 'Water', query: 'search=x', slug: 'water', previous_slug: 'old-water', display_order: 7 })
    })
  })

  it('is a no-op on a re-run', async () => {
    const seed = {
      all: 'cf_committee=Labor&match=any&q=water&session=S&status=Passed',
      bare: 'status=1&q&session&q&session',
      leading: '?q=x',
      none: 'priority=high',
      empty: '',
    }
    const once = await migrate(seed)
    await rerun()
    expect(await queries()).toEqual(once)
    await rerun()
    expect(await queries()).toEqual(once)
    expect(Object.values(once).join('&')).not.toMatch(/(^|[&?])(q|session)(=|&|$)|(^|[&?])cf_/)
  })

  it('does nothing to a database with no saved views', async () => {
    await applyMigrations()
    await rerun()
    expect(await views()).toEqual({})
  })
})
