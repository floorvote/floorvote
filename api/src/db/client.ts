import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'
import type { AppDb } from '../types'

export function getDb(d1: D1Database): AppDb {
  return drizzle(d1, { schema })
}
