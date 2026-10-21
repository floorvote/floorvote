import http from 'node:http'
import type { AddressInfo } from 'node:net'

// A local stand-in for central and for the instance's /api/health, so the shell
// scripts can be run for real without a deployment. It answers on 127.0.0.1 only.

export interface FakeCentral {
  url: string
  /** Every request it has seen, in order. */
  requests: { method: string; path: string; body: any }[]
  /** Change what it answers. */
  set(opts: Partial<FakeOptions>): void
  close(): Promise<void>
}

export interface FakeOptions {
  /** The build /api/health reports. */
  build: string
  secret: string
  /** Whether central is bound to the instance (registration.bound, and the RPC routes). */
  bound: boolean
}

export async function startFakeCentral(initial: Partial<FakeOptions> = {}): Promise<FakeCentral> {
  const opts: FakeOptions = { build: 'cafe123', secret: 'cli-secret', bound: true, ...initial }
  const requests: FakeCentral['requests'] = []
  let nonce = ''

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)) }
      const path = req.url ?? ''
      let body: any
      try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
      requests.push({ method: req.method ?? 'GET', path, body })

      if (path === '/api/health') return send(200, { ok: true, build: opts.build, status: 'ok' })
      if (req.headers['x-admin-secret'] !== opts.secret) return send(401, { error: 'unauthorized' })
      if (path === '/api/admin/superadmin/check') return send(200, { ok: true })
      if (path === '/api/tenants/ri/force-register') return send(200, { ok: true })
      if (path.startsWith('/api/tenants/seed-session/')) return send(200, { ok: true, done: true })
      if (path === '/api/tenants/ri/registration') {
        return send(200, { tenantId: 'ri', active: true, apiUrl: 'https://ri.example.org', stateCoverage: ['RI'], keywordCount: 0, bound: opts.bound, deliveryPath: 'binding' })
      }
      if (!opts.bound && path.startsWith('/api/tenants/ri/')) return send(501, { error: 'tenant not bound' })
      if (path === '/api/tenants/ri/verify-delivery') {
        nonce = body.nonce
        return send(200, { ok: true, nonce, billId: 'bill:1', via: 'binding' })
      }
      if (path === '/api/tenants/ri/delivery-probe') return send(200, { probe: { nonce, billId: 'bill:1', receivedAt: 'now', readStatus: 200 } })
      if (path === '/api/tenants/ri/verify-ai') return send(200, { status: 'ok', billNumber: 'HB 1', tags: 2, relevanceScore: 7, usedFullText: true })
      if (path === '/api/tenants/ri/send-sample-email') return send(200, { ok: true, provider: 'resend', to: body.to })
      return send(404, { error: 'not found' })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    set: (o) => { Object.assign(opts, o) },
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}
