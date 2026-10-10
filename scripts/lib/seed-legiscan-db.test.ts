import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTransientD1Error, sessionUpsertSql } from './seed-legiscan-db'

describe('isTransientD1Error', () => {
  // These are exactly the blips that the original narrow filter (timeout/503 only)
  // let fall through — they threw, got swallowed by the per-bill catch, and dropped
  // whole batches (the 58-bill TX gap). They MUST now be classified retryable.
  it.each([
    'Error: fetch failed',
    'Network connection lost.',
    'A request to the Cloudflare API failed with status 429: Too Many Requests',
    'D1_ERROR: internal error',
    'HTTP 500 Internal Server Error',
    'workerd/server error 502 Bad Gateway',
    '503 Service Unavailable',
    '504 Gateway Timeout',
    'read ECONNRESET',
    'write EPIPE',
    'socket hang up',
    'Execution timed out',
    'operation timeout',
    // The D1 import status poll racing the import's completion. Verbatim from a
    // failed MI seed, including the surrounding output wrangler emits — note the
    // `Processed 50 queries` immediately before, i.e. the write had already
    // landed and only the status check failed.
    '🌀 Starting import...\n🌀 Processed 50 queries.\n✘ [ERROR] Not currently importing anything.',
    'Not currently importing anything.',
    'no import in progress',
  ])('treats %j as transient', (msg) => {
    expect(isTransientD1Error(msg)).toBe(true)
  })

  // Genuine, deterministic SQL errors must NOT be retried — retrying wastes time and
  // masks a real problem. A re-run won't fix these.
  it.each([
    'no such table: bills',
    'UNIQUE constraint failed: bills.bill_id',
    'near "FROM": syntax error',
    'NOT NULL constraint failed: bills.title',
    'no such column: foo',
  ])('treats %j as NON-transient', (msg) => {
    expect(isTransientD1Error(msg)).toBe(false)
  })
})

describe('sessionUpsertSql', () => {
  // Central's real sessions table: every central migration, in filename order.
  const migrated = () => {
    const db = new DatabaseSync(':memory:')
    const dir = join(__dirname, '../../central/migrations-legiscan')
    for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'))
    return db
  }
  const session = { state_id: 39, year_start: 2026, year_end: 2026, session_tag: 'Regular Session', session_title: '2026 Regular Session', session_name: '2026 Regular Session' }

  it('writes a new session', () => {
    const db = migrated()
    db.exec(sessionUpsertSql(2154, 'RI', session))
    expect(db.prepare('SELECT state, session_name, provider, slug FROM sessions').all())
      .toEqual([{ state: 'RI', session_name: '2026 Regular Session', provider: 'legiscan', slug: null }])
  })

  it("updates an existing session's dataset fields, and keeps its slug, provider, and sync settings", () => {
    const db = migrated()
    db.exec(`INSERT INTO sessions (session_id, state, state_id, year_start, year_end, session_title, session_name, provider, slug, sync_enabled, full_sync_hours_et)
      VALUES (2154, 'RI', 39, 2026, 2026, 'old', 'old', 'legiscan', '2026', 0, '[5]')`)
    db.exec(sessionUpsertSql(2154, 'RI', { ...session, sine_die: 1 }))
    expect(db.prepare('SELECT session_name, sine_die, provider, slug, sync_enabled, full_sync_hours_et FROM sessions').all())
      .toEqual([{ session_name: '2026 Regular Session', sine_die: 1, provider: 'legiscan', slug: '2026', sync_enabled: 0, full_sync_hours_et: '[5]' }])
  })
})
