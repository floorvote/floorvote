/**
 * verify-instance — a smoke test that an instance works end to end.
 *
 * new-instance.sh runs about ten steps, several of which can fail silently: the
 * site loads, but bills never arrive or email never sends. This runs five cheap
 * checks, none visible to the organization's members:
 *
 *   1. health       the instance answers /api/health with the expected build
 *   2. registration central knows the instance, its states, and how to reach it
 *   3. delivery     central sends one stored bill down the instance's queue
 *   4. ai           one stored bill is analyzed end to end (opt-in: it costs a call)
 *   5. email        a sample email goes to the operator, never to the instance's admin
 *
 * Everything past check 1 goes through central's operator routes
 * (central/src/routes/tenants.ts), authenticated with its admin secret, because
 * a tenant holds no secret of its own. None of them calls LegiScan or changes
 * which bills the instance tracks.
 *
 * The logic is here, with fetch, time, and the filesystem injected, so each
 * failure path is testable without a deployment. scripts/verify-instance.ts is
 * the CLI and scripts/verify-instance.sh the entry point.
 */

export type CheckStatus = 'pass' | 'fail' | 'skipped'
export type CheckId = 'health' | 'registration' | 'delivery' | 'ai' | 'email'

export interface CheckResult {
  id: CheckId
  label: string
  status: CheckStatus
  detail: string
  /** On a failure, the likely cause and what to do about it. */
  cause?: string
  /** On a failure, the new-instance.sh step that most likely needs re-running. */
  stage?: string
}

export interface VerifyConfig {
  slug: string
  centralUrl: string
  adminSecret: string
  /** The instance's custom domain, when known. */
  appUrl: string | null
  /** The instance's workers.dev URL, when the account subdomain is known. */
  workerUrl: string | null
  /** Who gets the sample email, or null for nobody (the check is then skipped). */
  to: string | null
  ai: boolean
  /** The build /api/health must report, or null to accept any real build. */
  expectBuild: string | null
  /** States the operator expects central to hold for the instance (empty = no expectation). */
  expectStates: string[]
  /** How to re-run new-instance.sh, and which step number each stage is. Null when run standalone. */
  resume: { cmd: string; steps: Record<string, number> } | null
}

export interface ConfigIo {
  readFile(path: string): string | null
  gitSha(): string | null
  repoRoot: string
}

export interface Deps {
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): number
  /** Called as each check finishes, so a CLI can print progress during a long run. */
  onResult?(result: CheckResult): void
}

export class UsageError extends Error {}

export const USAGE = `Usage: scripts/verify-instance.sh <slug> [options]

Smoke-tests a provisioned instance: health and build, registration on central,
queue delivery, AI analysis, and email. Exits non-zero if any check fails.

Options:
  --ai                    Also analyze one stored bill (costs one AI call; off by default)
  --to <email>            Send the sample email here (default: the instance's ALERT_EMAILS)
  --expect-build <sha|any>  Build /api/health must report (default: this checkout's HEAD)
  --central-url <url>     Central's URL (default: CENTRAL_URL, or derived from RESOURCE_PREFIX)
  --admin-secret <s>      Central's ADMIN_SECRET (default: ADMIN_SECRET from scripts/.env.ops or central/.dev.vars)
  --app-url <url>         The instance's custom domain URL (default: read from api/wrangler.toml)
  --worker-url <url>      The instance's workers.dev URL (default: derived from RESOURCE_PREFIX and ACCOUNT_SUBDOMAIN)
  --prefix <name>         RESOURCE_PREFIX (default: RESOURCE_PREFIX, else floorvote)
  --states <CSV>          States central must hold for the instance (new-instance.sh passes its own)
  -h, --help              Show this help

Configuration comes from scripts/.env.ops and central/.dev.vars, the same files
new-instance.sh reads, so a deployment with a different prefix or domain needs no flags.`

// ── Configuration ────────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  '--admin-secret', '--central-url', '--app-url', '--worker-url', '--prefix', '--to',
  '--expect-build', '--states', '--resume-cmd', '--resume-steps',
])

function isPlaceholder(v: string | undefined): boolean {
  return !v || v.includes('<') || v === 'REPLACE_WITH_ACCOUNT_ID'
}

const stripSlash = (u: string) => u.replace(/\/+$/, '')

/** A `KEY = "value"` line inside `[env.<slug>.vars]`, the way deploy.sh reads its own. */
function readTomlVar(toml: string | null, slug: string, key: string): string | null {
  if (!toml) return null
  let inBlock = false
  for (const line of toml.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === `[env.${slug}.vars]`) { inBlock = true; continue }
    if (inBlock && trimmed.startsWith('[')) break
    if (!inBlock) continue
    const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
    if (m) return m[1] ?? m[2] ?? ''
  }
  return null
}

const firstAddress = (list: string | null | undefined): string | null =>
  (list ?? '').split(',').map(s => s.trim()).find(Boolean) ?? null

export function resolveConfig(argv: string[], env: Record<string, string | undefined>, io: ConfigIo): VerifyConfig {
  const flags = new Map<string, string>()
  let ai = false
  let slug = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--ai') { ai = true; continue }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      if (v === undefined) throw new UsageError(`${a} needs a value`)
      flags.set(a, v)
      i++
      continue
    }
    if (a.startsWith('-')) throw new UsageError(`Unknown option: ${a}`)
    if (slug) throw new UsageError(`Unexpected argument: ${a}`)
    slug = a
  }
  if (!slug) throw new UsageError('A slug is required (e.g. verify-instance.sh ri)')

  const prefix = flags.get('--prefix') ?? (env.RESOURCE_PREFIX || 'floorvote')
  const subdomain = isPlaceholder(env.ACCOUNT_SUBDOMAIN) ? null : env.ACCOUNT_SUBDOMAIN!

  // Names derive from the prefix exactly as new-instance.sh and teardown-instance.sh do.
  const centralWorker = env.CENTRAL_WORKER_NAME || `${prefix}-central-legiscan`
  let centralUrl = flags.get('--central-url') ?? (isPlaceholder(env.CENTRAL_URL) ? null : env.CENTRAL_URL!)
  if (!centralUrl) {
    if (!subdomain) throw new UsageError('Cannot work out central\'s URL: set ACCOUNT_SUBDOMAIN (scripts/.env.ops) or pass --central-url')
    centralUrl = `https://${centralWorker}.${subdomain}.workers.dev`
  }
  const workerUrl = flags.get('--worker-url') ?? (subdomain ? `https://${prefix}-${slug}.${subdomain}.workers.dev` : null)

  const adminSecret = flags.get('--admin-secret') ?? env.ADMIN_SECRET ?? ''
  if (!adminSecret) throw new UsageError('Central\'s ADMIN_SECRET is required: set it in central/.dev.vars, pass --admin-secret, or export it')

  const toml = io.readFile(`${io.repoRoot}/api/wrangler.toml`)
  const domain = firstAddress(env.APP_DOMAINS)
  const appUrl = flags.get('--app-url')
    ?? readTomlVar(toml, slug, 'APP_URL')
    ?? (domain ? `https://${slug}.${domain}` : null)

  const to = flags.get('--to')
    ?? firstAddress(readTomlVar(toml, slug, 'ALERT_EMAILS'))
    ?? firstAddress(env.ALERT_EMAILS)

  const expectFlag = flags.get('--expect-build')
  const expectBuild = expectFlag === 'any' ? null : (expectFlag ?? io.gitSha())

  const resumeCmd = flags.get('--resume-cmd')
  const resumeSteps = flags.get('--resume-steps')
  const steps: Record<string, number> = {}
  for (const pair of (resumeSteps ?? '').split(',').filter(Boolean)) {
    const [k, v] = pair.split('=')
    if (k && Number.isInteger(Number(v))) steps[k] = Number(v)
  }

  return {
    slug,
    centralUrl: stripSlash(centralUrl),
    adminSecret,
    appUrl: appUrl ? stripSlash(appUrl) : null,
    workerUrl: workerUrl ? stripSlash(workerUrl) : null,
    to,
    ai,
    expectBuild,
    expectStates: (flags.get('--states') ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    resume: resumeCmd && resumeSteps ? { cmd: resumeCmd, steps } : null,
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

const NOT_BOUND = 'Central has no binding for this instance: did central redeploy after the binding step?'
const BAD_SECRET = 'Central rejected the admin secret: check ADMIN_SECRET in central/.dev.vars or scripts/.env.ops, or pass --admin-secret.'

const DELIVERY_POLL_MS = 3_000
const DELIVERY_TIMEOUT_MS = 60_000
const CALL_TIMEOUT_MS = 30_000
const AI_TIMEOUT_MS = 120_000

interface Reply { status: number; json: any; text: string }

async function request(deps: Deps, method: string, url: string, opts: { secret?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (opts.secret) headers['x-admin-secret'] = opts.secret
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await deps.fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? CALL_TIMEOUT_MS),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not JSON: an app shell, or an error page */ }
  return { status: res.status, json, text }
}

const errorText = (r: Reply): string => (r.json && typeof r.json.error === 'string' ? r.json.error : r.text.slice(0, 200)) || `HTTP ${r.status}`
const describeThrown = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Outcome = Omit<CheckResult, 'id' | 'label'>
const pass = (detail: string): Outcome => ({ status: 'pass', detail })
const skipped = (detail: string): Outcome => ({ status: 'skipped', detail })
const fail = (detail: string, cause: string, stage: string): Outcome => ({ status: 'fail', detail, cause, stage })

/** Failures every central-backed check can hit before its own logic: a rejected secret, or an unbound instance. */
function commonCentralFailure(r: Reply): Outcome | null {
  if (r.status === 401 || r.status === 403) return fail(`central answered HTTP ${r.status}`, BAD_SECRET, 'verify')
  if (r.status === 501) return fail('central has no CentralApi binding for the instance', NOT_BOUND, 'bind')
  return null
}

async function checkHealth(cfg: VerifyConfig, deps: Deps): Promise<Outcome> {
  const urls = [...new Set([cfg.appUrl, cfg.workerUrl].filter((u): u is string => !!u))]
  if (urls.length === 0) {
    return fail('no URL to check', 'No custom domain or workers.dev URL is known: set ACCOUNT_SUBDOMAIN in scripts/.env.ops, or pass --app-url or --worker-url.', 'verify')
  }
  const notes: string[] = []
  let sawShell = false
  for (const url of urls) {
    let reply: Reply
    try {
      reply = await request(deps, 'GET', `${url}/api/health`)
    } catch (e) {
      notes.push(`${url} did not answer (${describeThrown(e)})`)
      continue
    }
    if (!reply.json || reply.json.ok !== true) {
      sawShell ||= reply.status === 200
      notes.push(`${url} answered HTTP ${reply.status} but not as the API`)
      continue
    }
    const build = String(reply.json.build ?? '')
    const custom = url === cfg.appUrl
    const where = custom ? url : (cfg.appUrl ? `${url} (the custom domain ${cfg.appUrl} is not answering yet: verify it in Cloudflare)` : url)
    if (build === 'dev' || build === '') {
      return fail(`${url} reports build "${build}"`, 'The deploy did not set BUILD_SHA (the placeholder is "dev"). Deploy with `npm run deploy:tenant -- <slug>`, which defines it.', 'deploy')
    }
    if (cfg.expectBuild && build !== cfg.expectBuild) {
      return fail(`${url} reports build ${build}, expected ${cfg.expectBuild}`, `The instance is running a different commit than this checkout (${cfg.expectBuild}). Redeploy it, or pass --expect-build ${build} (or any) if that is intended.`, 'deploy')
    }
    return pass(`build ${build} answering at ${where}`)
  }
  if (sawShell) {
    return fail(notes.join('; '), 'The URL served the app shell instead of the API. api/wrangler.toml [assets] needs run_worker_first = ["/api/*"] (see the self-hosting tenants guide).', 'deploy')
  }
  return fail(notes.join('; '), 'Neither the custom domain nor the workers.dev URL answered. Did the deploy finish? If only the custom domain is down, it may not be verified yet; the workers.dev URL should still answer.', 'deploy')
}

async function checkRegistration(cfg: VerifyConfig, deps: Deps): Promise<Outcome> {
  const r = await request(deps, 'GET', `${cfg.centralUrl}/api/tenants/${cfg.slug}/registration`, { secret: cfg.adminSecret })
  if (r.status === 404) {
    return fail('central has no registration for this instance', 'Central has not registered this instance: did force-register succeed? Re-run the registration step.', 'register')
  }
  const common = commonCentralFailure(r)
  if (common) return common
  if (r.status !== 200 || !r.json) return fail(`central answered HTTP ${r.status}: ${errorText(r)}`, 'Central returned an unexpected answer; check its logs.', 'register')

  const reg = r.json as { active: boolean; stateCoverage: string[]; keywordCount: number; bound: boolean; deliveryPath: string }
  const states = reg.stateCoverage ?? []
  const problems: Outcome[] = []
  if (!reg.bound) problems.push(fail('central is not bound to the instance', NOT_BOUND, 'bind'))
  if (reg.active === false) problems.push(fail('the registration is inactive', 'Central marks this instance inactive (it was torn down, or deactivated). Re-register it.', 'register'))
  if (states.length === 0) problems.push(fail('the registration covers no states', 'Central holds no states for this instance, so it would receive no bills. Re-run registration after the instance has STATE or state_coverage set.', 'register'))
  const missing = cfg.expectStates.filter(s => !states.includes(s) && !states.includes('*'))
  if (missing.length > 0) problems.push(fail(`central lacks ${missing.join(', ')}`, `Central's coverage (${states.join(', ') || 'none'}) is missing states you asked for. Re-run registration.`, 'register'))
  if (reg.deliveryPath === 'none') {
    problems.push(fail('central has no delivery path', 'Central has no queue binding and no queue id for this instance, so it would drop its bills. Check central\'s TENANT_QUEUE_PREFIX matches RESOURCE_PREFIX and CF_QUEUES_TOKEN is set, then re-register.', 'register'))
  }
  if (problems.length > 0) {
    return { status: 'fail', detail: problems.map(p => p.detail).join('; '), cause: problems[0].cause, stage: problems[0].stage }
  }
  const kw = reg.keywordCount === 0 ? 'no keywords yet' : `${reg.keywordCount} keyword${reg.keywordCount === 1 ? '' : 's'}`
  return pass(`registered for ${states.join(', ')}; ${kw}; delivery via ${reg.deliveryPath}`)
}

async function checkDelivery(cfg: VerifyConfig, deps: Deps): Promise<Outcome> {
  const base = `${cfg.centralUrl}/api/tenants/${cfg.slug}`
  const nonce = globalThis.crypto.randomUUID()
  const sent = await request(deps, 'POST', `${base}/verify-delivery`, { secret: cfg.adminSecret, body: { nonce } })
  if (sent.status === 404) return skipped('central has no stored bill to send yet (it fills after the first sync); run this again afterward')
  if (sent.status === 409) {
    return fail(errorText(sent), 'Central has no queue to deliver to: no static binding and no queue id. Check TENANT_QUEUE_PREFIX matches RESOURCE_PREFIX, then re-register.', 'register')
  }
  const common = commonCentralFailure(sent)
  if (common) return common
  if (sent.status !== 200 || !sent.json?.ok) return fail(`central answered HTTP ${sent.status}: ${errorText(sent)}`, 'Central could not queue the check; see its logs.', 'register')

  const { billId, via } = sent.json as { billId: string; via: string }
  const start = deps.now()
  while (true) {
    const poll = await request(deps, 'GET', `${base}/delivery-probe`, { secret: cfg.adminSecret })
    const probe = poll.json?.probe as { nonce: string; readStatus: number } | null | undefined
    if (probe && probe.nonce === nonce) {
      if (probe.readStatus !== 200) {
        return fail(`the instance received ${billId} but central answered it HTTP ${probe.readStatus}`, 'The instance could not read the bill back from central. Check its CENTRAL service binding ([[env.<slug>.services]], entrypoint TenantApi) in api/wrangler.toml and redeploy it.', 'deploy')
      }
      return pass(`central sent ${billId} via ${via}; the instance received it`)
    }
    if (poll.status >= 400) {
      const c = commonCentralFailure(poll)
      if (c) return c
      return fail(`reading the instance's probe failed: HTTP ${poll.status}: ${errorText(poll)}`, 'Central could not ask the instance what it received; see central\'s logs.', 'bind')
    }
    if (deps.now() - start >= DELIVERY_TIMEOUT_MS) break
    await deps.sleep(DELIVERY_POLL_MS)
  }
  return fail(`central sent ${billId} via ${via}, but the instance did not receive it within ${DELIVERY_TIMEOUT_MS / 1000}s`, 'The message was queued but never consumed. Check the instance\'s queue consumer deployed (npx wrangler queues list) and that the shared dead-letter queue exists; a consumer naming a missing dead-letter queue fails the deploy.', 'deploy')
}

function classifyAiError(message: string): string {
  if (/402|credit/i.test(message)) return 'The AI Gateway has no credits (HTTP 402). Load credits or store a BYOK key on the gateway; see the AI Gateway notes in the self-hosting tenants guide.'
  if (/401|403|unauthori[sz]ed|forbidden/i.test(message)) return 'The AI Gateway rejected the credentials. Check CF_AIG_TOKEN (and that "Authenticated Gateway" matches) and re-set the secret.'
  return 'The analysis failed. Check CF_AIG_TOKEN, CF_AIG_GATEWAY, and CF_ACCOUNT_ID on the instance, and the gateway\'s logs in the Cloudflare dashboard.'
}

async function checkAi(cfg: VerifyConfig, deps: Deps): Promise<Outcome> {
  if (!cfg.ai) return skipped('not requested (pass --ai; it costs one AI call)')
  const r = await request(deps, 'POST', `${cfg.centralUrl}/api/tenants/${cfg.slug}/verify-ai`, { secret: cfg.adminSecret, timeoutMs: AI_TIMEOUT_MS })
  if (r.status === 404) return skipped('central has no stored bill to analyze yet; run this again after the first sync')
  const common = commonCentralFailure(r)
  if (common) return common
  if (r.status === 200 && r.json?.status === 'skipped') return skipped(String(r.json.reason ?? 'the instance has no AI configured'))
  if (r.status === 200 && r.json?.status === 'ok') {
    const j = r.json as { billNumber: string; tags: number; relevanceScore: number; usedFullText: boolean }
    return pass(`analyzed ${j.billNumber}: relevance ${j.relevanceScore}, ${j.tags} tag${j.tags === 1 ? '' : 's'}${j.usedFullText ? '' : ' (title and abstract only; central had no text)'}`)
  }
  const message = errorText(r)
  return fail(message, classifyAiError(message), 'secrets')
}

async function checkEmail(cfg: VerifyConfig, deps: Deps): Promise<Outcome> {
  if (!cfg.to) return skipped('no recipient: set ALERT_EMAILS on the instance, or pass --to')
  // The digest sample: rendered from fixed data, sent only to `to`, and carrying
  // no sign-in link. Never a login email, which would mint a link for a real user.
  const r = await request(deps, 'POST', `${cfg.centralUrl}/api/tenants/${cfg.slug}/send-sample-email`, { secret: cfg.adminSecret, body: { to: cfg.to, type: 'digest' } })
  const common = commonCentralFailure(r)
  if (common) return common
  const provider = typeof r.json?.provider === 'string' ? r.json.provider : null
  if (r.status === 200 && r.json?.ok) return pass(`sample digest sent to ${cfg.to}${provider ? ` via ${provider}` : ''}`)
  const message = errorText(r)
  if (provider === 'resend') {
    return fail(`${provider}: ${message}`, 'Resend refused the send. Check RESEND_API_KEY on the instance (npx wrangler secret put RESEND_API_KEY --env <slug>) and that EMAIL_FROM\'s domain is verified in Resend.', 'secrets')
  }
  return fail(`${provider ?? 'email'}: ${message}`, 'The send failed. For Cloudflare Email Service, check the EMAIL binding is present and EMAIL_FROM\'s domain is verified for sending; for Resend, EMAIL_PROVIDER must be "resend" with RESEND_API_KEY set.', 'deploy')
}

const CHECKS: { id: CheckId; label: string; run: (cfg: VerifyConfig, deps: Deps) => Promise<Outcome> }[] = [
  { id: 'health', label: 'Health and build', run: checkHealth },
  { id: 'registration', label: 'Registration on central', run: checkRegistration },
  { id: 'delivery', label: 'Queue delivery', run: checkDelivery },
  { id: 'ai', label: 'AI analysis', run: checkAi },
  { id: 'email', label: 'Email', run: checkEmail },
]

// These reach the instance only through central's binding to it. When
// registration has already shown there is none, each would fail with the same
// cause, so they are skipped rather than repeating it three times.
const NEEDS_BINDING: CheckId[] = ['delivery', 'ai', 'email']

export async function runChecks(cfg: VerifyConfig, deps: Deps): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  let unbound = false
  for (const check of CHECKS) {
    let outcome: Outcome
    try {
      outcome = unbound && NEEDS_BINDING.includes(check.id)
        ? skipped('not attempted: central is not bound to the instance (see Registration)')
        : await check.run(cfg, deps)
    } catch (e) {
      outcome = fail(describeThrown(e), `Could not complete the call (${describeThrown(e)}). Is central reachable at ${cfg.centralUrl}?`, 'verify')
    }
    const result: CheckResult = { id: check.id, label: check.label, ...outcome }
    if (check.id === 'registration' && result.status === 'fail' && result.stage === 'bind') unbound = true
    results.push(result)
    deps.onResult?.(result)
  }
  return results
}

// ── Report ───────────────────────────────────────────────────────────────────

export function formatResult(r: CheckResult): string {
  const tag = r.status === 'fail' ? 'FAIL' : r.status
  const lines = [`  ${tag.padEnd(8)} ${r.label}: ${r.detail}`]
  if (r.status === 'fail' && r.cause) lines.push(`           Likely cause: ${r.cause}`)
  return lines.join('\n')
}

export function formatFooter(results: CheckResult[], cfg: VerifyConfig): string {
  const n = (s: CheckStatus) => results.filter(r => r.status === s).length
  const lines = ['', `  ${n('pass')} passed, ${n('fail')} failed, ${n('skipped')} skipped.`]
  const failures = results.filter(r => r.status === 'fail')
  if (failures.length > 0 && cfg.resume) {
    const { cmd, steps } = cfg.resume
    const fallback = steps.verify
    const numbers = failures.map(f => (f.stage ? steps[f.stage] : undefined) ?? fallback).filter((x): x is number => typeof x === 'number')
    if (numbers.length > 0) {
      lines.push('', `  Fix the cause, then resume:`, `    ${cmd} --from-step ${Math.min(...numbers)}`)
    }
  }
  return lines.join('\n')
}

export function formatReport(results: CheckResult[], cfg: VerifyConfig): string {
  return [`Verifying ${cfg.slug}`, ...results.map(formatResult), formatFooter(results, cfg)].join('\n')
}

export function exitCode(results: CheckResult[]): number {
  return results.some(r => r.status === 'fail') ? 1 : 0
}
