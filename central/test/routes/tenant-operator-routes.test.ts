import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { app } from '../../src/index-legiscan'
import { setupLsDb } from '../helpers/setupLsDb'

beforeEach(async () => { await setupLsDb() })

describe('operator fan-out routes', () => {
  it('401s without the central secret', async () => {
    const res = await app.request('/api/tenants/my-org/force-register', { method: 'POST' }, env)
    expect(res.status).toBe(401)
  })

  it('invokes the tenant RPC when authorized and bound', async () => {
    let called = false
    const rpcEnv = { ...env, TENANT_MY_ORG: { forceRegister: async () => { called = true; return true } } } as any
    const res = await app.request('/api/tenants/my-org/force-register',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } }, rpcEnv)
    expect(res.status).toBe(200)
    expect(called).toBe(true)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('501s when the tenant is not bound', async () => {
    const res = await app.request('/api/tenants/unbound-xyz/force-register',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } }, env)
    expect(res.status).toBe(501)
  })

  it('demo-reset forwards the tenant RPC result', async () => {
    const rpcEnv = { ...env, TENANT_MY_ORG: { demoReset: async () => ({ ok: true, billsSeeded: true }) } } as any
    const res = await app.request('/api/tenants/my-org/demo-reset',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } }, rpcEnv)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, billsSeeded: true })
  })

  it('send-sample-email 400s when to/type missing', async () => {
    const rpcEnv = { ...env, TENANT_MY_ORG: { sendSampleEmail: async () => ({ ok: true }) } } as any
    const res = await app.request('/api/tenants/my-org/send-sample-email',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ to: 'a@b.com' }) }, rpcEnv)
    expect(res.status).toBe(400)
  })

  it('send-sample-email 502s when the RPC reports failure', async () => {
    const rpcEnv = { ...env, TENANT_MY_ORG: { sendSampleEmail: async () => ({ ok: false, error: 'boom' }) } } as any
    const res = await app.request('/api/tenants/my-org/send-sample-email',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret', 'content-type': 'application/json' }, body: JSON.stringify({ to: 'a@b.com', type: 'login' }) }, rpcEnv)
    expect(res.status).toBe(502)
  })

  it('returns a clean 502 with the message when the tenant RPC throws', async () => {
    const rpcEnv = { ...env, TENANT_MY_ORG: { demoReset: async () => { throw new Error('demo mode not enabled') } } } as any
    const res = await app.request('/api/tenants/my-org/demo-reset',
      { method: 'POST', headers: { 'x-admin-secret': 'test-secret' } }, rpcEnv)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'demo mode not enabled' })
  })
})
