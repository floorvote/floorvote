import { describe, it, expect } from 'vitest'
import { isTransientD1Error } from './seed-legiscan-db'

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
