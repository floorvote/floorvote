import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'
import type { CentralDb } from '../types'

export function createDb(d1: D1Database): CentralDb {
  return drizzle(d1, { schema })
}
