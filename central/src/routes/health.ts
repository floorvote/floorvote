import { Hono } from 'hono'
import type { Env } from '../types'

export const healthRoutes = new Hono<{ Bindings: Env }>()

healthRoutes.get('/', (c) => c.json({ status: 'ok', operator: c.env.OPERATOR_NAME }))
