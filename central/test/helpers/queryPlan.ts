import { env } from 'cloudflare:test'

export type Captured = { sql: string; params: unknown[] }

/**
 * The same D1 binding, recording every statement a caller prepares and binds,
 * so a test can EXPLAIN the SQL the code really ran with the values it ran
 * it with, rather than a copy of the query that can drift from it.
 */
export function spyOnD1(): { db: D1Database; captured: Captured[] } {
  const captured: Captured[] = []
  const real = env.DB
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop !== 'prepare') {
        const v = (target as any)[prop]
        return typeof v === 'function' ? v.bind(target) : v
      }
      return (sql: string) => {
        const stmt = target.prepare(sql)
        return new Proxy(stmt, {
          get(s, p) {
            if (p === 'bind') return (...params: unknown[]) => { captured.push({ sql, params }); return s.bind(...params) }
            const v = (s as any)[p]
            return typeof v === 'function' ? v.bind(s) : v
          },
        })
      }
    },
  })
  return { db, captured }
}

/** EXPLAIN QUERY PLAN for one captured statement, its lines joined by ' | '. */
export async function planOf(c: Captured): Promise<string> {
  const rows = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${c.sql}`).bind(...c.params).all()).results as { detail: string }[]
  return rows.map(r => r.detail).join(' | ')
}
