import { describe, it, expect } from 'vitest'
import {
  resolveConfig, runChecks, formatReport, exitCode, UsageError,
  type CheckResult, type ConfigIo, type VerifyConfig,
} from './verify-instance'

// ── Config resolution ────────────────────────────────────────────────────────

const WRANGLER_TOML = `
[env.ri]
name = "acme-ri"

[env.ri.vars]
APP_URL = "https://ri.acme.example"
ALERT_EMAILS = "ops@acme.example, backup@acme.example"

[env.other]
name = "acme-other"

[env.other.vars]
APP_URL = "https://other.acme.example"
ALERT_EMAILS = "someone-else@acme.example"
`

function io(files: Record<string, string> = {}, sha: string | null = 'abc1234'): ConfigIo {
  return { readFile: (p) => files[p] ?? null, gitSha: () => sha, repoRoot: '/repo' }
}

const BASE_ENV = { ADMIN_SECRET: 's3cret', ACCOUNT_SUBDOMAIN: 'sub', RESOURCE_PREFIX: 'acme' }

describe('resolveConfig', () => {
  it('derives every URL from RESOURCE_PREFIX the way new-instance.sh does', () => {
    const cfg = resolveConfig(['ri'], BASE_ENV, io())
    expect(cfg.centralUrl).toBe('https://acme-central-legiscan.sub.workers.dev')
    expect(cfg.workerUrl).toBe('https://acme-ri.sub.workers.dev')
  })

  it('defaults the prefix to floorvote', () => {
    const cfg = resolveConfig(['ri'], { ADMIN_SECRET: 's', ACCOUNT_SUBDOMAIN: 'sub' }, io())
    expect(cfg.centralUrl).toBe('https://floorvote-central-legiscan.sub.workers.dev')
    expect(cfg.workerUrl).toBe('https://floorvote-ri.sub.workers.dev')
  })

  it('lets CENTRAL_URL, CENTRAL_WORKER_NAME, and flags override the derivation', () => {
    expect(resolveConfig(['ri'], { ...BASE_ENV, CENTRAL_URL: 'https://c.example' }, io()).centralUrl).toBe('https://c.example')
    expect(resolveConfig(['ri'], { ...BASE_ENV, CENTRAL_WORKER_NAME: 'acme-c' }, io()).centralUrl).toBe('https://acme-c.sub.workers.dev')
    const cfg = resolveConfig(['ri', '--central-url', 'https://flag.example', '--worker-url', 'https://w.example', '--app-url', 'https://a.example'], BASE_ENV, io())
    expect([cfg.centralUrl, cfg.workerUrl, cfg.appUrl]).toEqual(['https://flag.example', 'https://w.example', 'https://a.example'])
  })

  it('takes the admin secret from a flag or the environment, and refuses to run without one', () => {
    expect(resolveConfig(['ri', '--admin-secret', 'flag'], { ...BASE_ENV, ADMIN_SECRET: '' }, io()).adminSecret).toBe('flag')
    expect(resolveConfig(['ri'], BASE_ENV, io()).adminSecret).toBe('s3cret')
    expect(() => resolveConfig(['ri'], { ...BASE_ENV, ADMIN_SECRET: '' }, io())).toThrow(UsageError)
  })

  it('requires a slug', () => {
    expect(() => resolveConfig([], BASE_ENV, io())).toThrow(UsageError)
  })

  it('refuses the placeholder subdomain instead of building a URL nobody owns', () => {
    expect(() => resolveConfig(['ri'], { ADMIN_SECRET: 's', ACCOUNT_SUBDOMAIN: '<your-subdomain>' }, io())).toThrow(UsageError)
  })

  it('reads the instance own APP_URL and first ALERT_EMAILS from api/wrangler.toml', () => {
    const cfg = resolveConfig(['ri'], BASE_ENV, io({ '/repo/api/wrangler.toml': WRANGLER_TOML }))
    expect(cfg.appUrl).toBe('https://ri.acme.example')
    expect(cfg.to).toBe('ops@acme.example')
  })

  it('prefers --to over the configured ALERT_EMAILS, and ALERT_EMAILS in the env as a last resort', () => {
    expect(resolveConfig(['ri', '--to', 'me@x.example'], BASE_ENV, io({ '/repo/api/wrangler.toml': WRANGLER_TOML })).to).toBe('me@x.example')
    expect(resolveConfig(['ri'], { ...BASE_ENV, ALERT_EMAILS: 'env@x.example,b@x.example' }, io()).to).toBe('env@x.example')
    expect(resolveConfig(['ri'], BASE_ENV, io()).to).toBeNull()
  })

  it('derives the app URL from APP_DOMAINS when the config does not name one', () => {
    expect(resolveConfig(['ri'], { ...BASE_ENV, APP_DOMAINS: 'acme.example,alt.example' }, io()).appUrl).toBe('https://ri.acme.example')
  })

  it('expects the checked-out commit as the build, unless told otherwise', () => {
    expect(resolveConfig(['ri'], BASE_ENV, io()).expectBuild).toBe('abc1234')
    expect(resolveConfig(['ri', '--expect-build', 'ff00ff0'], BASE_ENV, io()).expectBuild).toBe('ff00ff0')
    expect(resolveConfig(['ri', '--expect-build', 'any'], BASE_ENV, io()).expectBuild).toBeNull()
    expect(resolveConfig(['ri'], BASE_ENV, io({}, null)).expectBuild).toBeNull()
  })

  it('treats --ai as opt-in and parses --states and the resume hint', () => {
    expect(resolveConfig(['ri'], BASE_ENV, io()).ai).toBe(false)
    const cfg = resolveConfig(
      ['ri', '--ai', '--states', 'NJ,RI', '--resume-cmd', './scripts/new-instance.sh --slug ri', '--resume-steps', 'deploy=4,secrets=5,verify=11'],
      BASE_ENV, io(),
    )
    expect(cfg.ai).toBe(true)
    expect(cfg.expectStates).toEqual(['NJ', 'RI'])
    expect(cfg.resume).toEqual({ cmd: './scripts/new-instance.sh --slug ri', steps: { deploy: 4, secrets: 5, verify: 11 } })
  })

  it('rejects an unknown flag', () => {
    expect(() => resolveConfig(['ri', '--nope'], BASE_ENV, io())).toThrow(UsageError)
  })
})

// ── A fake world: central and an instance, behind a scripted fetch ───────────

const CENTRAL = 'https://acme-central-legiscan.sub.workers.dev'
const APP = 'https://ri.acme.example'
const WORKER = 'https://acme-ri.sub.workers.dev'

type Reply = { status?: number; json?: unknown; text?: string } | 'network-error'
type Route = (req: { url: URL; method: string; headers: Headers; body: any }) => Reply

interface World {
  routes: Record<string, Route>
  calls: { method: string; url: string; body: any; headers: Headers }[]
  clock: { t: number }
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): number
}

function makeWorld(overrides: Record<string, Route> = {}, opts: { probeArrivesAfterPolls?: number; probeReadStatus?: number } = {}): World {
  let nonce = ''
  let polls = 0
  const arrivesAfter = opts.probeArrivesAfterPolls ?? 2
  const routes: Record<string, Route> = {
    [`GET ${APP}/api/health`]: () => ({ json: { ok: true, build: 'abc1234' } }),
    [`GET ${WORKER}/api/health`]: () => ({ json: { ok: true, build: 'abc1234' } }),
    [`GET ${CENTRAL}/api/tenants/ri/registration`]: () => ({
      json: { tenantId: 'ri', active: true, apiUrl: APP, stateCoverage: ['RI'], keywordCount: 0, bound: true, deliveryPath: 'binding' },
    }),
    [`POST ${CENTRAL}/api/tenants/ri/verify-delivery`]: ({ body }) => {
      nonce = body?.nonce ?? 'n-1'
      return { json: { ok: true, nonce, billId: 'legiscan:42', via: 'binding' } }
    },
    [`GET ${CENTRAL}/api/tenants/ri/delivery-probe`]: () => {
      polls += 1
      if (polls < arrivesAfter) return { json: { probe: null } }
      return { json: { probe: { nonce, billId: 'legiscan:42', receivedAt: '2026-10-14 12:00:00', readStatus: opts.probeReadStatus ?? 200 } } }
    },
    [`POST ${CENTRAL}/api/tenants/ri/verify-ai`]: () => ({ json: { status: 'ok', billNumber: 'HB 1', tags: 2, relevanceScore: 7 } }),
    [`POST ${CENTRAL}/api/tenants/ri/send-sample-email`]: () => ({ json: { ok: true, provider: 'cloudflare' } }),
    ...overrides,
  }
  const calls: World['calls'] = []
  const clock = { t: 0 }
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ method, url: url.href, body, headers })
    const route = routes[`${method} ${url.origin}${url.pathname}`]
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    const reply = route({ url, method, headers, body })
    if (reply === 'network-error') throw new TypeError('fetch failed')
    const text = reply.text ?? JSON.stringify(reply.json ?? {})
    return new Response(text, { status: reply.status ?? 200, headers: { 'content-type': reply.text !== undefined ? 'text/html' : 'application/json' } })
  }) as typeof fetch
  return {
    routes, calls, clock, fetch: fakeFetch,
    sleep: async (ms) => { clock.t += ms },
    now: () => clock.t,
  }
}

function config(over: Partial<VerifyConfig> = {}): VerifyConfig {
  return {
    slug: 'ri', centralUrl: CENTRAL, adminSecret: 's3cret', appUrl: APP, workerUrl: WORKER,
    to: 'ops@acme.example', ai: true, expectBuild: 'abc1234', expectStates: [], resume: null,
    ...over,
  }
}

async function run(world: World, cfg: VerifyConfig = config()) {
  const results = await runChecks(cfg, world)
  const by = (id: string) => results.find(r => r.id === id) as CheckResult
  return { results, by }
}

describe('runChecks — all green', () => {
  it('runs the five checks in order, all passing', async () => {
    const { results } = await run(makeWorld())
    expect(results.map(r => [r.id, r.status])).toEqual([
      ['health', 'pass'], ['registration', 'pass'], ['delivery', 'pass'], ['ai', 'pass'], ['email', 'pass'],
    ])
    expect(exitCode(results)).toBe(0)
  })

  it('never calls LegiScan, never touches an admin sign-in route, and mails only the operator', async () => {
    const world = makeWorld()
    await run(world)
    for (const c of world.calls) {
      expect(c.url).not.toMatch(/legiscan/i)
      expect(c.url).not.toMatch(/\/api\/auth\//)
    }
    const mail = world.calls.filter(c => c.url.endsWith('/send-sample-email'))
    expect(mail).toHaveLength(1)
    expect(mail[0].body.to).toBe('ops@acme.example')
    expect(mail[0].body.type).not.toBe('login')
    expect(mail[0].body.type).not.toBe('invite')
  })

  it('authenticates to central with the admin secret on every central call', async () => {
    const world = makeWorld()
    await run(world)
    const central = world.calls.filter(c => c.url.startsWith(CENTRAL))
    expect(central.length).toBeGreaterThan(0)
    for (const c of central) expect(c.headers.get('x-admin-secret')).toBe('s3cret')
  })

  it('works with a non-default prefix and no custom domain at all', async () => {
    const world = makeWorld()
    const { results } = await run(world, config({ appUrl: null }))
    expect(results.every(r => r.status === 'pass')).toBe(true)
    expect(world.calls.some(c => c.url.startsWith(APP))).toBe(false)
  })
})

describe('check 1: health and build', () => {
  it('passes on workers.dev when the custom domain is not verified yet, and says so', async () => {
    const { by } = await run(makeWorld({ [`GET ${APP}/api/health`]: () => 'network-error' }))
    expect(by('health').status).toBe('pass')
    expect(by('health').detail).toContain(WORKER)
    expect(by('health').detail).toMatch(/custom domain/i)
  })

  it('fails naming the cause when neither URL answers', async () => {
    const { by } = await run(makeWorld({
      [`GET ${APP}/api/health`]: () => 'network-error',
      [`GET ${WORKER}/api/health`]: () => 'network-error',
    }))
    expect(by('health').status).toBe('fail')
    expect(by('health').cause).toMatch(/deploy/i)
    expect(by('health').stage).toBe('deploy')
  })

  it('fails when the URL serves the app shell instead of the API', async () => {
    const shell = () => ({ text: '<!doctype html><html></html>' })
    const { by } = await run(makeWorld({ [`GET ${APP}/api/health`]: shell, [`GET ${WORKER}/api/health`]: shell }))
    expect(by('health').status).toBe('fail')
    expect(by('health').cause).toMatch(/run_worker_first/)
  })

  it('fails when the running build is not the expected one', async () => {
    const stale = () => ({ json: { ok: true, build: 'old0000' } })
    const { by } = await run(makeWorld({ [`GET ${APP}/api/health`]: stale, [`GET ${WORKER}/api/health`]: stale }))
    expect(by('health').status).toBe('fail')
    expect(by('health').detail).toContain('old0000')
    expect(by('health').cause).toMatch(/abc1234/)
  })

  it('fails on the unreplaced dev build placeholder', async () => {
    const dev = () => ({ json: { ok: true, build: 'dev' } })
    const { by } = await run(makeWorld({ [`GET ${APP}/api/health`]: dev, [`GET ${WORKER}/api/health`]: dev }), config({ expectBuild: null }))
    expect(by('health').status).toBe('fail')
    expect(by('health').cause).toMatch(/BUILD_SHA/)
  })

  it('accepts any real build when no expectation is set', async () => {
    const other = () => ({ json: { ok: true, build: 'zzz9999' } })
    const { by } = await run(makeWorld({ [`GET ${APP}/api/health`]: other }), config({ expectBuild: null }))
    expect(by('health').status).toBe('pass')
  })
})

describe('check 2: registration', () => {
  const reg = (over: Record<string, unknown>, status = 200): Route => () => ({
    status,
    json: { tenantId: 'ri', active: true, apiUrl: APP, stateCoverage: ['RI'], keywordCount: 0, bound: true, deliveryPath: 'binding', ...over },
  })
  const key = `GET ${CENTRAL}/api/tenants/ri/registration`

  it('reports states and keywords', async () => {
    const { by } = await run(makeWorld({ [key]: reg({ stateCoverage: ['NJ', 'RI'], keywordCount: 3 }) }))
    expect(by('registration').detail).toContain('NJ, RI')
    expect(by('registration').detail).toContain('3 keywords')
  })

  it('fails when central has never heard of the instance', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 404, json: { error: 'tenant not registered' } }) }))
    expect(by('registration').status).toBe('fail')
    expect(by('registration').cause).toMatch(/force-register/)
    expect(by('registration').stage).toBe('register')
  })

  it('fails with the binding question when central has no binding for the instance', async () => {
    const { by } = await run(makeWorld({ [key]: reg({ bound: false }) }))
    expect(by('registration').status).toBe('fail')
    expect(by('registration').cause).toBe('Central has no binding for this instance: did central redeploy after the binding step?')
    expect(by('registration').stage).toBe('bind')
  })

  it('fails when central has no way to deliver bills', async () => {
    const { by } = await run(makeWorld({ [key]: reg({ deliveryPath: 'none' }) }))
    expect(by('registration').status).toBe('fail')
    expect(by('registration').cause).toMatch(/TENANT_QUEUE_PREFIX/)
  })

  it('fails when the registration is inactive or covers no states', async () => {
    expect((await run(makeWorld({ [key]: reg({ active: false }) }))).by('registration').status).toBe('fail')
    expect((await run(makeWorld({ [key]: reg({ stateCoverage: [] }) }))).by('registration').status).toBe('fail')
  })

  it('fails when a state the operator asked for is missing from the registration', async () => {
    const { by } = await run(makeWorld({ [key]: reg({ stateCoverage: ['RI'] }) }), config({ expectStates: ['NJ', 'RI'] }))
    expect(by('registration').status).toBe('fail')
    expect(by('registration').detail).toContain('NJ')
  })

  it('fails with a clear cause when central rejects the admin secret', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 401, json: { error: 'unauthorized' } }) }))
    expect(by('registration').status).toBe('fail')
    expect(by('registration').cause).toMatch(/ADMIN_SECRET/)
  })

  it('fails when central cannot be reached at all', async () => {
    const { by } = await run(makeWorld({ [key]: () => 'network-error' }))
    expect(by('registration').status).toBe('fail')
    expect(by('registration').cause).toMatch(/central/i)
  })
})

describe('check 3: queue delivery', () => {
  it('polls until the instance reports the probe it was sent', async () => {
    const world = makeWorld({}, { probeArrivesAfterPolls: 3 })
    const { by } = await run(world)
    expect(by('delivery').status).toBe('pass')
    expect(world.calls.filter(c => c.url.endsWith('/delivery-probe'))).toHaveLength(3)
    expect(by('delivery').detail).toContain('legiscan:42')
  })

  it('ignores a probe left over from an earlier run', async () => {
    const world = makeWorld({
      [`GET ${CENTRAL}/api/tenants/ri/delivery-probe`]: () => ({ json: { probe: { nonce: 'stale', billId: 'legiscan:1', receivedAt: 'x', readStatus: 200 } } }),
    })
    const { by } = await run(world)
    expect(by('delivery').status).toBe('fail')
  })

  it('fails with a cause when the message never arrives', async () => {
    const world = makeWorld({}, { probeArrivesAfterPolls: 10_000 })
    const { by } = await run(world)
    expect(by('delivery').status).toBe('fail')
    expect(by('delivery').cause).toMatch(/dead-letter|consumer/i)
    expect(world.clock.t).toBeGreaterThanOrEqual(30_000)
  })

  it('fails when the message arrives but the instance cannot read the bill from central', async () => {
    const { by } = await run(makeWorld({}, { probeReadStatus: 403 }))
    expect(by('delivery').status).toBe('fail')
    expect(by('delivery').cause).toMatch(/CENTRAL/)
  })

  it('is skipped, not failed, when central stores no bill to send', async () => {
    const { by, results } = await run(makeWorld({
      [`POST ${CENTRAL}/api/tenants/ri/verify-delivery`]: () => ({ status: 404, json: { error: 'no stored bill' } }),
    }))
    expect(by('delivery').status).toBe('skipped')
    expect(by('delivery').detail).toMatch(/stored bill/)
    expect(exitCode(results)).toBe(0)
  })

  it('fails when central has no delivery path for the instance', async () => {
    const { by } = await run(makeWorld({
      [`POST ${CENTRAL}/api/tenants/ri/verify-delivery`]: () => ({ status: 409, json: { error: 'no delivery path' } }),
    }))
    expect(by('delivery').status).toBe('fail')
    expect(by('delivery').cause).toMatch(/queue/i)
  })

  it('fails with the binding question when central says the instance is not bound', async () => {
    const { by } = await run(makeWorld({
      [`POST ${CENTRAL}/api/tenants/ri/verify-delivery`]: () => ({ status: 501, json: { error: 'tenant not bound' } }),
    }))
    expect(by('delivery').status).toBe('fail')
    expect(by('delivery').cause).toMatch(/binding/);
  })
})

describe('check 4: AI analysis', () => {
  const key = `POST ${CENTRAL}/api/tenants/ri/verify-ai`

  it('is skipped unless asked for, and makes no AI call', async () => {
    const world = makeWorld()
    const { by } = await run(world, config({ ai: false }))
    expect(by('ai').status).toBe('skipped')
    expect(by('ai').detail).toContain('--ai')
    expect(world.calls.some(c => c.url.endsWith('/verify-ai'))).toBe(false)
  })

  it('is skipped when the deployment has no AI configured', async () => {
    const { by, results } = await run(makeWorld({ [key]: () => ({ json: { status: 'skipped', reason: 'CF_AIG_GATEWAY is not set' } }) }))
    expect(by('ai').status).toBe('skipped')
    expect(by('ai').detail).toContain('CF_AIG_GATEWAY')
    expect(exitCode(results)).toBe(0)
  })

  it('is skipped when central stores no bill to analyze', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 404, json: { error: 'no stored bill' } }) }))
    expect(by('ai').status).toBe('skipped')
    expect(by('ai').detail).toMatch(/stored bill/)
  })

  it('fails naming the credit balance when the gateway answers 402', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 502, json: { error: '402 Insufficient wholesale credits' } }) }))
    expect(by('ai').status).toBe('fail')
    expect(by('ai').cause).toMatch(/credits/i)
    expect(by('ai').stage).toBe('secrets')
  })

  it('fails naming the token for an auth error', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 502, json: { error: '401 Unauthorized' } }) }))
    expect(by('ai').cause).toMatch(/CF_AIG_TOKEN/)
  })

  it('fails on any other analysis error and shows it', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 502, json: { error: 'model exploded' } }) }))
    expect(by('ai').status).toBe('fail')
    expect(by('ai').detail).toContain('model exploded')
  })
})

describe('check 5: email', () => {
  const key = `POST ${CENTRAL}/api/tenants/ri/send-sample-email`

  it('reports the provider that sent it, for either provider', async () => {
    for (const provider of ['cloudflare', 'resend']) {
      const { by } = await run(makeWorld({ [key]: () => ({ json: { ok: true, provider } }) }))
      expect(by('email').status).toBe('pass')
      expect(by('email').detail).toContain(provider)
      expect(by('email').detail).toContain('ops@acme.example')
    }
  })

  it('is skipped, saying why, when there is nobody to send to', async () => {
    const world = makeWorld()
    const { by } = await run(world, config({ to: null }))
    expect(by('email').status).toBe('skipped')
    expect(by('email').detail).toMatch(/ALERT_EMAILS/)
    expect(world.calls.some(c => c.url.endsWith('/send-sample-email'))).toBe(false)
  })

  it('fails pointing at the resend key when a resend send fails', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 502, json: { ok: false, provider: 'resend', error: '401 API key invalid' } }) }))
    expect(by('email').status).toBe('fail')
    expect(by('email').cause).toMatch(/RESEND_API_KEY/)
    expect(by('email').detail).toContain('API key invalid')
  })

  it('fails pointing at the sender domain when a cloudflare send fails', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 502, json: { ok: false, provider: 'cloudflare', error: 'domain not verified' } }) }))
    expect(by('email').status).toBe('fail')
    expect(by('email').cause).toMatch(/EMAIL_FROM/)
  })

  it('fails when the instance is not bound on central', async () => {
    const { by } = await run(makeWorld({ [key]: () => ({ status: 501, json: { error: 'tenant not bound' } }) }))
    expect(by('email').status).toBe('fail')
    expect(by('email').cause).toMatch(/binding/)
  })
})

describe('report and exit code', () => {
  const fail: CheckResult = { id: 'ai', label: 'AI analysis', status: 'fail', detail: 'boom', cause: 'check the token', stage: 'secrets' }
  const pass: CheckResult = { id: 'health', label: 'Health and build', status: 'pass', detail: 'ok' }
  const skipped: CheckResult = { id: 'email', label: 'Email', status: 'skipped', detail: 'no recipient' }

  it('exits non-zero on any failure, zero otherwise', () => {
    expect(exitCode([pass, skipped])).toBe(0)
    expect(exitCode([pass, fail, skipped])).toBe(1)
  })

  it('prints one line per check, naming status, and the cause under a failure', () => {
    const text = formatReport([pass, fail, skipped], config())
    expect(text).toMatch(/pass\s+Health and build/)
    expect(text).toMatch(/FAIL\s+AI analysis/)
    expect(text).toMatch(/skipped\s+Email/)
    expect(text).toContain('Likely cause: check the token')
  })

  it('prints the resume command at the earliest failing step', () => {
    const cfg = config({ resume: { cmd: './scripts/new-instance.sh --slug ri', steps: { deploy: 4, bind: 7, secrets: 5, verify: 11 } } })
    const text = formatReport([
      { ...fail, stage: 'bind' },
      { ...fail, id: 'email', stage: 'secrets' },
    ], cfg)
    expect(text).toContain('./scripts/new-instance.sh --slug ri --from-step 5')
  })

  it('prints no resume command when run standalone', () => {
    const text = formatReport([fail], config())
    expect(text).toContain('boom')
    expect(text).not.toMatch(/--from-step/)
  })

  it('falls back to re-running verification when a failure has no mapped step', () => {
    const cfg = config({ resume: { cmd: 'cmd', steps: { verify: 11 } } })
    expect(formatReport([fail], cfg)).toContain('cmd --from-step 11')
  })
})
