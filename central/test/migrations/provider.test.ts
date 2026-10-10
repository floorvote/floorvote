import { env, applyD1Migrations } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { legiscanMigrations, parseMigrations, setupDb, type MigrationFiles } from '../helpers/migrations'
import { limsBillId, limsPeopleId, limsSessionId } from '../../src/providers/lims/ids'

// Central's migrations from before the provider column (0025), as a central
// that holds LIMS rows had them: a fresh one has lims_records from
// 0021_lims_records, and a downstream fork's production from its own 0020.
const before0025: MigrationFiles = Object.fromEntries(
  Object.entries(legiscanMigrations).filter(([path]) => path.split('/').pop()! < '0025'))

const columns = async (table: string) =>
  (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map(r => r.name)

const tables = async () =>
  (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all<{ name: string }>()).results.map(r => r.name)

describe('the provider migrations', () => {
  it('leave a fresh central with provider columns and tables, and no lims_records', async () => {
    await setupDb(legiscanMigrations)

    for (const table of ['bills', 'sessions', 'people']) {
      expect(await columns(table)).toContain('provider')
      expect(await columns(table)).not.toContain('source')
    }
    expect(await columns('provider_records')).toEqual(expect.arrayContaining(
      ['bill_id', 'provider', 'native_key', 'session_id', 'raw_json', 'raw_hash', 'details_json', 'details_fetched_at']))
    expect(await columns('provider_ids')).toEqual(['id', 'provider', 'kind', 'native_key'])
    const names = await tables()
    expect(names).toEqual(expect.arrayContaining(['provider_records', 'provider_ids']))
    for (const gone of ['lims_records', 'source_records', 'source_ids']) expect(names).not.toContain(gone)
  })

  it('upgrade a central holding LIMS rows: ids unchanged, LIMS rows marked lims, raw records moved, lims_records dropped', async () => {
    await setupDb(before0025)
    const B0400 = limsBillId('B26-0400')!
    const CP26 = limsSessionId(26)
    const CP25 = limsSessionId(25)
    const GRAY = limsPeopleId(150)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO sessions (session_id, state_id, state, year_start, year_end, session_tag, session_title, session_name)
        VALUES (?, 51, 'DC', 2025, 2026, 'CP26', 'Council Period 26', 'Council Period 26'), (?, 51, 'DC', 2023, 2024, '', 'Council Period 25', 'Council Period 25'),
          (2154, 39, 'RI', 2026, 2026, '', '2026', '2026')`).bind(CP26, CP25),
      env.DB.prepare(`INSERT INTO bills (bill_id, change_hash, session_id, state, state_id, bill_number, title)
        VALUES (?, 'h', ?, 'DC', 51, 'B26-0400', 'DC bill'), (9001, 'h', 2154, 'RI', 39, 'H1', 'RI bill')`).bind(B0400, CP26),
      env.DB.prepare(`INSERT INTO people (people_id, name) VALUES (?, 'Vincent C. Gray'), (5, 'Ann Able')`).bind(GRAY),
      env.DB.prepare(`INSERT INTO lims_records (bill_id, legislation_number, council_period_id, category_id, bulk_json, bulk_hash, details_fetched_at)
        VALUES (?, 'B26-0400', 26, 1, '{"legislationNumber":"B26-0400"}', 'bh', '2026-10-01 00:00:00')`).bind(B0400),
    ])

    await applyD1Migrations(env.DB, parseMigrations(legiscanMigrations))

    const providers = async (sql: string) =>
      Object.fromEntries((await env.DB.prepare(sql).all<{ id: number; provider: string }>()).results.map(r => [r.id, r.provider]))
    expect(await providers('SELECT bill_id AS id, provider FROM bills')).toEqual({ [B0400]: 'lims', 9001: 'legiscan' })
    expect(await providers('SELECT session_id AS id, provider FROM sessions')).toEqual({ [CP26]: 'lims', [CP25]: 'lims', 2154: 'legiscan' })
    // A LIMS session without its tag gets the one its id encodes, and nothing else changes.
    const tags = await env.DB.prepare('SELECT session_id, session_tag FROM sessions').all<{ session_id: number; session_tag: string }>()
    expect(Object.fromEntries(tags.results.map(r => [r.session_id, r.session_tag]))).toEqual({ [CP26]: 'CP26', [CP25]: 'CP25', 2154: '' })
    expect(await providers('SELECT people_id AS id, provider FROM people')).toEqual({ [GRAY]: 'lims', 5: 'legiscan' })

    expect((await env.DB.prepare('SELECT * FROM provider_records').all()).results).toEqual([expect.objectContaining({
      bill_id: B0400, provider: 'lims', native_key: 'B26-0400', session_id: CP26,
      raw_json: '{"legislationNumber":"B26-0400"}', raw_hash: 'bh', details_json: null, details_fetched_at: '2026-10-01 00:00:00',
    })])
    expect(await tables()).not.toContain('lims_records')

    // New providers' ids still start above every LIMS range.
    const minted = await env.DB.prepare(`INSERT INTO provider_ids (provider, kind, native_key) VALUES ('mga', 'bill', '2026RS/HB0001') RETURNING id`)
      .first<{ id: number }>()
    expect(minted!.id).toBeGreaterThan(3_000_000_000)
  })
})
