import { Hono } from 'hono'
import type { LsEnv } from '../types'

export const healthRoutes = new Hono<{ Bindings: LsEnv }>()

healthRoutes.get('/', (c) => c.json({ status: 'ok', operator: c.env.OPERATOR_NAME }))
