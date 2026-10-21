import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeCentral, type FakeCentral } from './fake-central.testutil'
import { startFakeInstallEvent, refusedUrl, type FakeInstallEvent } from './fake-install-event.testutil'
import { runInPty } from './pty-run.testutil'

// Runs the real scripts/new-instance.sh end to end in a throwaway git repo, with
// wrangler and npm faked on PATH and central faked over local HTTP. It proves the
// wiring of the last step: verification runs after provisioning, passes what the
// run provisioned with, and on failure names the step to resume from.
// Nothing here touches Cloudflare, a real central, or this checkout's config.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsx = path.join(repoRoot, 'node_modules/.bin/tsx')

let central: FakeCentral
let installEvent: FakeInstallEvent
let work: string

// Every wrangler call is appended to wrangler.log in the work dir, so a test can
// see which Cloudflare resources a run would have created.
const FAKE_NPX = `#!/usr/bin/env bash
if [[ "$1" == "tsx" ]]; then exec "$FAKE_TSX" "\${@:2}"; fi
if [[ "$1" == "wrangler" ]]; then
  echo "\${*:2}" >> "$FAKE_WORK/wrangler.log"
  case "$2 $3" in
    "whoami "*) echo "Account: $CF_ACCOUNT_ID" ;;
    "queues list") echo "acme-dlq" ;;
    "d1 create") echo 'database_id = "db-123"' ;;
    "d1 execute") echo '[{"results":[]}]' ;;
    "secret put") cat >/dev/null ;;
    *) echo "fake wrangler: $*" ;;
  esac
fi
exit 0
`

function sh(cmd: string, args: string[], cwd: string) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * A throwaway git repo holding the scripts under test and a minimal config. `commitDate`
 * (YYYY-MM-DD) dates the one commit, so a test can tell the checkout's date from today's.
 */
function makeWork(commitDate?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-instance-'))
  fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'api'))
  fs.mkdirSync(path.join(dir, 'central'))
  fs.mkdirSync(path.join(dir, 'bin'))
  for (const f of ['new-instance.sh', 'verify-instance.sh', 'verify-instance.ts', 'lib/verify-instance.ts']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', f), path.join(dir, 'scripts', f))
  }
  fs.chmodSync(path.join(dir, 'scripts/new-instance.sh'), 0o755)
  fs.chmodSync(path.join(dir, 'scripts/verify-instance.sh'), 0o755)
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n')
  fs.writeFileSync(path.join(dir, 'api/wrangler.toml'), 'name = "acme"\n[assets]\nbinding = "ASSETS"\nrun_worker_first = ["/api/*"]\n')
  fs.writeFileSync(path.join(dir, 'central/wrangler.toml'), '[vars]\nTENANT_QUEUE_PREFIX = "acme"\n')
  fs.writeFileSync(path.join(dir, 'bin/npx'), FAKE_NPX, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'bin/npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'bin/sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  sh('git', ['init', '-q'], dir)
  sh('git', ['config', 'user.email', 'test@example.org'], dir)
  sh('git', ['config', 'user.name', 'Test'], dir)
  sh('git', ['add', '-A'], dir)
  const stamp = commitDate ? `${commitDate}T12:00:00+0000` : undefined
  execFileSync('git', ['commit', '-q', '-m', 'init'], {
    cwd: dir,
    stdio: 'ignore',
    env: stamp ? { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : process.env,
  })
  return dir
}

const extraWorks: string[] = []

beforeAll(async () => {
  central = await startFakeCentral()
  installEvent = await startFakeInstallEvent()
  work = makeWork()
})

afterAll(async () => {
  await central.close()
  await installEvent.close()
  for (const dir of [work, ...extraWorks]) fs.rmSync(dir, { recursive: true, force: true })
})

const wranglerLog = (dir: string) => {
  try { return fs.readFileSync(path.join(dir, 'wrangler.log'), 'utf8') } catch { return '' }
}
const tenantToml = (dir: string) => fs.readFileSync(path.join(dir, 'api/wrangler.toml'), 'utf8')

type Env = Record<string, string | undefined>

// Every run points the setup report at a refused local port and clears the opt-in, whatever the
// developer's own shell sets: no test may reach floorvote.org, or change with an exported variable.
const DEAD_REPORT_URL = 'http://127.0.0.1:9/api/install-event'

function provisionArgs(extraArgs: string[]): string[] {
  return [
    'scripts/new-instance.sh', '--slug', 'ri', '--states', 'RI', '--name', 'Rhode Island Clerks',
    '--admin-email', 'clerk@example.org', '--admin-name', 'Jane Doe',
    '--admin-secret', 'cli-secret', '--app-url', central.url, ...extraArgs,
  ]
}

function provisionEnv(dir: string, overrides: Env = {}): NodeJS.ProcessEnv {
  const env: Env = {
    ...process.env,
    FAKE_TSX: tsx, FAKE_WORK: dir,
    RESOURCE_PREFIX: 'acme', ACCOUNT_SUBDOMAIN: 'sub', CF_ACCOUNT_ID: 'acct12345678',
    CF_AIG_GATEWAY: 'gw', SUPERADMIN_JWT_PUBLIC_KEY: '{"kty":"EC"}',
    CENTRAL_URL: central.url, ALERT_EMAILS: 'ops@acme.example',
    FLOORVOTE_INSTALL_PING: undefined,
    FLOORVOTE_INSTALL_PING_URL: DEAD_REPORT_URL,
    ...overrides,
  }
  // The fakes in the work dir's bin come first; an override replaces only what follows.
  env.PATH = `${path.join(dir, 'bin')}:${overrides.PATH ?? process.env.PATH}`
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  return env as NodeJS.ProcessEnv
}

function startProvision(extraArgs: string[] = [], stdin = 'tok\n\n\ny\n', dir = work, env: Env = {}, detached = false) {
  const child = spawn('bash', provisionArgs(extraArgs), { cwd: dir, env: provisionEnv(dir, env), stdio: ['pipe', 'pipe', 'pipe'], detached })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  // Default: CF_AIG_TOKEN, the two optional keys left blank, then the confirmation.
  // A run resumed past the secrets step is not asked for them again.
  child.stdin.end(stdin)
  const done = new Promise<{ code: number; out: string }>((resolve) => {
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
  return { child, done, output: () => out }
}

function provision(extraArgs: string[] = [], stdin = 'tok\n\n\ny\n', dir = work, env: Env = {}): Promise<{ code: number; out: string }> {
  return startProvision(extraArgs, stdin, dir, env).done
}

describe('new-instance.sh, last step', () => {
  it('verifies the instance, expecting the build the deploy step deployed even though later commits moved HEAD', async () => {
    const deployedHead = sh('git', ['rev-parse', '--short', 'HEAD'], work)
    central.set({ bound: true, build: deployedHead })
    const { code, out } = await provision()
    expect(out).toContain('Verify the instance end to end')
    expect(out).toMatch(/pass\s+Health and build/)
    expect(out).toMatch(/pass\s+Registration on central/)
    expect(out).toMatch(/pass\s+Queue delivery/)
    // Provisioning runs the AI check; standalone it is opt-in.
    expect(out).toMatch(/pass\s+AI analysis/)
    // ALERT_EMAILS was written into the instance's env block and read back from it.
    expect(out).toMatch(/pass\s+Email: sample digest sent to ops@acme\.example/)
    expect(out).toContain('Instance verified end to end')
    // Attachments are on by default: a private bucket, bound in the env block.
    expect(wranglerLog(work)).toContain('r2 bucket create acme-ri-files')
    expect(tenantToml(work)).toMatch(/\[\[env\.ri\.r2_buckets\]\]\nbinding = "ATTACHMENTS_BUCKET"\nbucket_name = "acme-ri-files"/)
    expect(out).toMatch(/Attachments: on \(acme-ri-files\b/)
    expect(code).toBe(0)
    // The commits after the deploy and bind steps moved HEAD past what was deployed, so a
    // verifier that expected HEAD would have failed the health check above.
    expect(sh('git', ['rev-parse', '--short', 'HEAD'], work)).not.toBe(deployedHead)
  }, 60_000)

  it('exits non-zero on a failed check, naming the step to resume from and never the secret', async () => {
    central.set({ bound: false, build: sh('git', ['rev-parse', '--short', 'HEAD'], work) })
    // Resume past the deploy, as an operator would after the first run: only the build
    // expectation is unknown now, so it must fall back to "any" rather than fail.
    const { code, out } = await provision(['--from-step', '8'], 'y\n')
    expect(out).toMatch(/FAIL\s+Registration on central/)
    expect(out).toContain('Central has no binding for this instance: did central redeploy after the binding step?')
    expect(out).toMatch(/\.\/scripts\/new-instance\.sh --slug ri .* --from-step 8\b/)
    // The closing summary still prints, with the manual steps the operator needs.
    expect(out).toContain('Remaining manual step')
    expect(out).toContain('did not pass verification')
    expect(out).not.toContain('Instance verified end to end')
    expect(out).not.toContain('cli-secret')
    expect(out).not.toContain('--from-step 8 --from-step')
    expect(code).not.toBe(0)
  }, 60_000)
})

describe('new-instance.sh, attachments bucket', () => {
  it('with --no-attachments, creates no bucket, binds none, and still verifies', async () => {
    const dir = makeWork()
    extraWorks.push(dir)
    central.set({ bound: true, build: sh('git', ['rev-parse', '--short', 'HEAD'], dir) })
    const { code, out } = await provision(['--no-attachments'], undefined, dir)
    expect(wranglerLog(dir)).toContain('queues create acme-ri-queue')
    expect(wranglerLog(dir)).not.toContain('r2 bucket')
    expect(tenantToml(dir)).toContain('[env.ri]')
    expect(tenantToml(dir)).not.toContain('r2_buckets')
    expect(out).toMatch(/Attachments: off/)
    expect(out).toContain('Instance verified end to end')
    expect(code).toBe(0)
  }, 60_000)

  it('treats a bucket that already exists as created, so a resumed run goes on', async () => {
    const dir = makeWork()
    extraWorks.push(dir)
    // wrangler's answer when the bucket is already there (from an earlier, failed run).
    fs.writeFileSync(path.join(dir, 'bin/npx'), FAKE_NPX.replace(
      '"d1 create")',
      '"r2 bucket") echo "✘ [ERROR] A request to the Cloudflare API failed. The bucket you tried to create already exists, and you own it. [code: 10004]" >&2; exit 1 ;;\n    "d1 create")',
    ), { mode: 0o755 })
    central.set({ bound: true, build: sh('git', ['rev-parse', '--short', 'HEAD'], dir) })
    const { code, out } = await provision([], undefined, dir)
    expect(out).toContain('acme-ri-files already exists')
    expect(tenantToml(dir)).toContain('bucket_name = "acme-ri-files"')
    expect(code).toBe(0)
  }, 60_000)

  it('warns in preflight when another instance already binds the bucket name, and refuses an invalid one', async () => {
    const dir = makeWork()
    extraWorks.push(dir)
    fs.appendFileSync(path.join(dir, 'api/wrangler.toml'), '\n[env.old]\nname = "acme-old"\n\n[[env.old.r2_buckets]]\nbinding = "ATTACHMENTS_BUCKET"\nbucket_name = "acme-ri-files"\n')
    const shared = await provision(['--preflight-only'], '', dir)
    expect(shared.out).toMatch(/⚠ bucket acme-ri-files is already bound in api\/wrangler\.toml/)
    expect(shared.code).toBe(0)
    // An uppercase slug makes a name R2 would refuse at step 3.
    const invalid = await provision(['--preflight-only', '--slug', 'RI_2'], '', dir)
    expect(invalid.out).toMatch(/✗ bucket name acme-RI_2-files is not a valid R2 name/)
    expect(invalid.code).not.toBe(0)
    expect(wranglerLog(dir)).not.toContain('r2 bucket')
  }, 60_000)
})

// ── The optional, anonymous setup report ──────────────────────────────────────
// new-instance.sh can tell floorvote.org how a run ended: four coarse fields, only
// with the operator's say-so, never able to change the run's result.

const reportUrl = () => `${installEvent.url}/api/install-event`
const YES: Env = { FLOORVOTE_INSTALL_PING: 'yes' }
const CHECKOUT_DATE = '2024-03-05'
const tenantsDoc = path.join(repoRoot, 'docs/content/self-hosting/tenants.md')

/** A work repo, deployed-build set on the fake central so verification passes. */
function freshWork(opts: { commitDate?: string; bound?: boolean } = {}): string {
  const dir = makeWork(opts.commitDate)
  extraWorks.push(dir)
  central.set({ bound: opts.bound ?? true, build: sh('git', ['rev-parse', '--short', 'HEAD'], dir) })
  return dir
}

/** Swap a branch of the fake wrangler (or add one) in a work dir. */
function fakeWrangler(dir: string, from: string, to: string) {
  fs.writeFileSync(path.join(dir, 'bin/npx'), FAKE_NPX.replace(from, to), { mode: 0o755 })
}

const reported = (): any[] => installEvent.posts.map((p) => JSON.parse(p.body))

/** The closing summary, minus timestamps and the log path, so two runs can be compared. */
function summaryOf(out: string): string {
  const from = out.indexOf("Instance 'ri' provisioned.")
  expect(from).toBeGreaterThan(-1)
  const tail = out.slice(from)
  return tail.slice(0, tail.lastIndexOf('━') + 1)
    .replace(/\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\]/g, '[ts]')
    .split('\n').filter((l) => !l.includes('Log:')).join('\n')
}

/** A PATH of symlinks to every program on this one, optionally leaving curl out. */
function pathFarm(withCurl: boolean): string {
  const farm = fs.mkdtempSync(path.join(os.tmpdir(), 'path-farm-'))
  extraWorks.push(farm)
  const seen = new Set<string>()
  for (const d of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    let names: string[]
    try { names = fs.readdirSync(d) } catch { continue }
    for (const n of names) {
      if (seen.has(n) || (!withCurl && n === 'curl')) continue
      seen.add(n)
      try { fs.symlinkSync(path.join(d, n), path.join(farm, n)) } catch { /* ignore */ }
    }
  }
  return farm
}

describe('new-instance.sh, anonymous setup report: what is sent', () => {
  beforeEach(() => installEvent.reset())

  it('sends one report with exactly four fields when the run passes verification, and prints it', async () => {
    const dir = freshWork({ commitDate: CHECKOUT_DATE })
    const { code, out } = await provision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(1)
    const post = installEvent.posts[0]
    expect(post.method).toBe('POST')
    expect(post.path).toBe('/api/install-event')
    expect(post.headers['content-type']).toMatch(/^application\/json/)
    // The version is the checkout's commit date, taken before the run adds commits of its own.
    expect(JSON.parse(post.body)).toEqual({ event: 'tenant_setup', outcome: 'verified', step: 'verify', version: CHECKOUT_DATE })
    expect(Object.keys(JSON.parse(post.body)).sort()).toEqual(['event', 'outcome', 'step', 'version'])
    // What was sent is printed, character for character.
    expect(out).toContain(post.body)
  }, 60_000)

  it('carries nothing about the team: no slug, states, names, emails, account ID, or URLs', async () => {
    const dir = freshWork()
    const { out } = await provision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(out).toContain('Instance verified end to end')
    expect(installEvent.posts).toHaveLength(1)
    const { body, headers } = installEvent.posts[0]
    expect(body).toMatch(/^\{"event":"tenant_setup","outcome":"verified","step":"verify","version":"\d{4}-\d\d-\d\d"\}$/)
    for (const secret of ['Rhode', 'Clerks', 'RI', '"ri"', 'clerk@example.org', 'example.org', 'Jane', 'Doe', 'acct12345678',
      'acme', 'workers.dev', 'cli-secret', central.url, 'http', 'ops@acme.example']) {
      expect(body).not.toContain(secret)
    }
    expect(JSON.stringify(headers)).not.toContain('cli-secret')
  }, 60_000)

  it('reports unverified at the verify step when verification fails, and still exits non-zero', async () => {
    const dir = freshWork({ bound: false })
    // Resumed past the deploy, as in the verification test above: the --from-step run names the right step.
    const { code, out } = await provision(['--from-step', '8'], 'y\n', dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(out).toContain('did not pass verification')
    expect(code).not.toBe(0)
    expect(reported()).toEqual([{ event: 'tenant_setup', outcome: 'unverified', step: 'verify', version: expect.stringMatching(/^\d{4}-\d\d-\d\d$/) }])
  }, 60_000)

  it('reports failed with the key of the step that was running when wrangler fails partway', async () => {
    const dir = freshWork()
    fakeWrangler(dir, `"d1 create") echo 'database_id = "db-123"' ;;`, `"d1 create") echo "✘ [ERROR] boom" >&2; exit 1 ;;`)
    const { code } = await provision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(code).not.toBe(0)
    expect(reported()).toEqual([{ event: 'tenant_setup', outcome: 'failed', step: 'db', version: expect.any(String) }])
  }, 60_000)

  it('names the right step key when resumed with --from-step, not the first step or a step number', async () => {
    const dir = freshWork()
    // Step 6 is the secrets step: skipped steps 1 to 5 must not be what gets reported.
    fakeWrangler(dir, '"secret put") cat >/dev/null ;;', '"secret put") cat >/dev/null; echo "✘ [ERROR] no" >&2; exit 1 ;;')
    const { code } = await provision(['--from-step', '6'], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(code).not.toBe(0)
    expect(reported()).toEqual([{ event: 'tenant_setup', outcome: 'failed', step: 'secrets', version: expect.any(String) }])
  }, 60_000)

  it('reports failed at preflight when preflight fails', async () => {
    const dir = freshWork()
    // A slug that is already taken fails preflight before anything is provisioned.
    fs.appendFileSync(path.join(dir, 'api/wrangler.toml'), '\n[env.ri]\nname = "acme-ri"\n')
    const { code, out } = await provision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(out).toContain('Preflight failed')
    expect(code).not.toBe(0)
    expect(reported()).toEqual([{ event: 'tenant_setup', outcome: 'failed', step: 'preflight', version: expect.any(String) }])
  }, 60_000)

  it('sends nothing when the operator declines at the final confirmation', async () => {
    const dir = freshWork()
    const { code, out } = await provision([], 'tok\n\n\nn\n', dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    expect(out).toContain('Aborted.')
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it('sends to floorvote.org/api/install-event by default, as a POST with a 5-second limit', async () => {
    const dir = freshWork()
    const realCurl = execFileSync('which', ['curl'], { encoding: 'utf8' }).trim()
    // Records the report's curl call instead of sending it; every other curl call goes through.
    fs.writeFileSync(path.join(dir, 'bin/curl'), `#!/usr/bin/env bash
if [[ "$*" == *install-event* ]]; then printf '%s\\n' "$@" > "$FAKE_WORK/curl-report.log"; exit 0; fi
exec "${realCurl}" "$@"
`, { mode: 0o755 })
    const { code } = await provision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: undefined })
    expect(code).toBe(0)
    const args = fs.readFileSync(path.join(dir, 'curl-report.log'), 'utf8').trimEnd().split('\n')
    expect(args).toContain('https://floorvote.org/api/install-event')
    const maxTime = args.indexOf('--max-time')
    expect(maxTime).toBeGreaterThan(-1)
    expect(args[maxTime + 1]).toBe('5')
    expect(args.some((a) => a.startsWith('{"event":"tenant_setup","outcome":"verified","step":"verify"'))).toBe(true)
  }, 60_000)
})

describe('new-instance.sh, anonymous setup report: consent', () => {
  beforeEach(() => installEvent.reset())
  const url = () => ({ FLOORVOTE_INSTALL_PING_URL: reportUrl() })

  it('sends nothing and prints no prompt when FLOORVOTE_INSTALL_PING=no', async () => {
    const dir = freshWork()
    const { code, out } = await provision([], undefined, dir, { FLOORVOTE_INSTALL_PING: 'no', ...url() })
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(0)
    expect(out).not.toMatch(/anonymous/i)
    expect(out).not.toContain('tenant_setup')
  }, 60_000)

  it('applies the value in scripts/.env.ops when the environment sets none', async () => {
    const dir = freshWork()
    fs.writeFileSync(path.join(dir, 'scripts/.env.ops'), 'FLOORVOTE_INSTALL_PING=yes\n')
    const { code } = await provision([], undefined, dir, url())
    expect(code).toBe(0)
    expect(reported()).toEqual([expect.objectContaining({ outcome: 'verified' })])

    installEvent.reset()
    fs.writeFileSync(path.join(dir, 'scripts/.env.ops'), 'FLOORVOTE_INSTALL_PING=no\n')
    const second = await provision(['--from-step', '8'], 'y\n', dir, url())
    expect(second.out).not.toMatch(/anonymous/i)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it('lets a value in the environment win over scripts/.env.ops', async () => {
    const dir = freshWork()
    fs.writeFileSync(path.join(dir, 'scripts/.env.ops'), 'FLOORVOTE_INSTALL_PING=yes\n')
    const { code } = await provision([], undefined, dir, { FLOORVOTE_INSTALL_PING: 'no', ...url() })
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it('sends nothing and prints no prompt when the variable is unset and stdin is not a terminal', async () => {
    const dir = freshWork()
    const { code, out } = await provision([], undefined, dir, url())
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(0)
    expect(out).not.toMatch(/anonymous/i)
  }, 60_000)

  it('treats a value other than yes or no as unset, so without a terminal it sends nothing', async () => {
    const dir = freshWork()
    const { code } = await provision([], undefined, dir, { FLOORVOTE_INSTALL_PING: 'maybe', ...url() })
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  // The terminal run: CF_AIG_TOKEN is exported so the only prompts are the optional keys, the consent
  // question, and the final confirmation.
  const ptyRun = (answerToReport: string | null, dir: string, extraArgs: string[] = [], env: Env = {}) =>
    runInPty(['bash', ...provisionArgs(extraArgs)], {
      cwd: dir,
      env: provisionEnv(dir, { CF_AIG_TOKEN: 'tok', ...url(), ...env }),
      script: [
        ['GEMINI_API_KEY', '\n'],
        ['RESEND_API_KEY', '\n'],
        ...(answerToReport === null ? [] : [['Send an anonymous setup report? [y/N]', answerToReport] as [string, string]]),
        ['Proceed? [y/N]', 'y\n'],
      ],
    })

  it('under a terminal, shows the payload shape and [y/N], and sends nothing on Enter', async () => {
    const dir = freshWork()
    const { code, out } = await ptyRun('\n', dir)
    expect(out).toContain('"event":"tenant_setup"')
    expect(out).toMatch(/"outcome":"(verified|<)/)
    expect(out).toContain('Send an anonymous setup report? [y/N]')
    expect(code).toBe(0)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it('under a terminal, sends nothing on n', async () => {
    const dir = freshWork()
    const { out } = await ptyRun('n\n', dir)
    expect(out).toContain('Send an anonymous setup report? [y/N]')
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it('under a terminal, sends a report on y', async () => {
    const dir = freshWork()
    const { code, out } = await ptyRun('y\n', dir)
    expect(out).toContain('Send an anonymous setup report? [y/N]')
    expect(code).toBe(0)
    expect(reported()).toEqual([{ event: 'tenant_setup', outcome: 'verified', step: 'verify', version: expect.any(String) }])
  }, 60_000)

  it('does not ask under a terminal when the variable is set, either way', async () => {
    const dir = freshWork()
    const yes = await ptyRun(null, dir, [], YES)
    expect(yes.out).not.toContain('Send an anonymous setup report?')
    expect(reported()).toHaveLength(1)
    installEvent.reset()
    const no = await ptyRun(null, freshWork(), [], { FLOORVOTE_INSTALL_PING: 'no' })
    expect(no.out).not.toContain('Send an anonymous setup report?')
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it('with --preflight-only, sends nothing whatever the setting, and does not ask under a terminal', async () => {
    const dir = freshWork()
    const withYes = await provision(['--preflight-only'], '', dir, { ...YES, ...url() })
    expect(withYes.code).toBe(0)
    expect(withYes.out).toContain('Preflight passed')
    expect(withYes.out).not.toMatch(/anonymous/i)
    expect(installEvent.posts).toHaveLength(0)
    // Even a failing preflight, which a normal run would report, stays unreported here.
    fs.appendFileSync(path.join(dir, 'api/wrangler.toml'), '\n[env.ri]\nname = "acme-ri"\n')
    const failing = await provision(['--preflight-only'], '', dir, { ...YES, ...url() })
    expect(failing.code).not.toBe(0)
    expect(installEvent.posts).toHaveLength(0)
    const clean = freshWork()
    const tty = await runInPty(['bash', ...provisionArgs(['--preflight-only'])], {
      cwd: clean, env: provisionEnv(clean, { ...url() }), script: [],
    })
    expect(tty.code).toBe(0)
    expect(tty.out).not.toMatch(/anonymous/i)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)
})

describe('new-instance.sh, anonymous setup report: it never gets in the way', () => {
  beforeEach(() => installEvent.reset())

  // A fake wrangler whose `d1 create` waits for the test, so the run can be stopped mid-step.
  const BLOCKING_D1 = `"d1 create") touch "$FAKE_WORK/blocked"; while [[ ! -e "$FAKE_WORK/release" ]]; do /bin/sleep 0.1; done; echo "✘ [ERROR] stopped" >&2; exit 1 ;;`
  const waitFor = async (file: string) => {
    for (let i = 0; i < 300 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(file)).toBe(true)
  }

  it('control: a run that fails inside the blocked step reports failed at that step', async () => {
    const dir = freshWork()
    fakeWrangler(dir, `"d1 create") echo 'database_id = "db-123"' ;;`, BLOCKING_D1)
    const run = startProvision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    await waitFor(path.join(dir, 'blocked'))
    fs.writeFileSync(path.join(dir, 'release'), '')
    const { code } = await run.done
    expect(code).not.toBe(0)
    expect(reported()).toEqual([expect.objectContaining({ outcome: 'failed', step: 'db' })])
  }, 60_000)

  it('sends nothing when the run is interrupted with Ctrl-C (SIGINT) mid-step', async () => {
    const dir = freshWork()
    fakeWrangler(dir, `"d1 create") echo 'database_id = "db-123"' ;;`, BLOCKING_D1)
    const run = startProvision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() }, true)
    await waitFor(path.join(dir, 'blocked'))
    // Ctrl-C reaches the whole foreground process group, so signal the group.
    process.kill(-run.child.pid!, 'SIGINT')
    const { code, out } = await run.done
    expect(code).not.toBe(0)
    expect(out).not.toContain('tenant_setup')
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)

  it.each([
    ['refuses connections', async () => ({ url: `${await refusedUrl()}/api/install-event`, mode: 'ok' as const })],
    ['answers 500', async () => ({ url: reportUrl(), mode: 'error' as const })],
    ['hangs', async () => ({ url: reportUrl(), mode: 'hang' as const })],
  ])('leaves the exit code and summary as with "no" when the endpoint %s, adding at most about 5 seconds', async (_name, target) => {
    const { url, mode } = await target()
    installEvent.setMode(mode)
    const baselineStart = Date.now()
    const baseline = await provision([], undefined, freshWork(), { FLOORVOTE_INSTALL_PING: 'no', FLOORVOTE_INSTALL_PING_URL: url })
    const baselineMs = Date.now() - baselineStart
    expect(baseline.code).toBe(0)

    const start = Date.now()
    const sent = await provision([], undefined, freshWork(), { ...YES, FLOORVOTE_INSTALL_PING_URL: url })
    const elapsed = Date.now() - start
    installEvent.setMode('ok')

    expect(sent.code).toBe(baseline.code)
    expect(summaryOf(sent.out)).toBe(summaryOf(baseline.out))
    expect(sent.out).toContain('Instance verified end to end')
    // The report was attempted: a refused connection has nothing to show, but the others reached the endpoint.
    if (mode !== 'ok') expect(installEvent.posts).toHaveLength(1)
    expect(elapsed - baselineMs).toBeLessThan(8_000)
  }, 90_000)

  it('also leaves a failing run failing the same way when the endpoint hangs', async () => {
    installEvent.setMode('hang')
    const dir = freshWork({ bound: false })
    const start = Date.now()
    const { code, out } = await provision(['--from-step', '8'], 'y\n', dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    installEvent.setMode('ok')
    expect(code).toBe(1)
    expect(out).toContain('did not pass verification')
    expect(installEvent.posts).toHaveLength(1)
    expect(Date.now() - start).toBeLessThan(20_000)
  }, 60_000)

  it('completes as if "no" when curl is not on PATH, and sends nothing', async () => {
    const url = { FLOORVOTE_INSTALL_PING_URL: reportUrl() }
    // Control: with curl on the PATH, the same run reports.
    const control = await provision([], undefined, freshWork(), { ...YES, ...url, PATH: pathFarm(true) })
    expect(control.code).toBe(0)
    expect(reported()).toEqual([expect.objectContaining({ outcome: 'verified' })])
    installEvent.reset()

    // Without curl the run's own calls to central fail as well, so it stops in preflight. It stops the
    // same way with "yes" as with "no", and "yes" neither sends nor prints anything about it.
    const noCurl = pathFarm(false)
    const withYes = await provision([], undefined, freshWork(), { ...YES, ...url, PATH: noCurl })
    const withNo = await provision([], undefined, freshWork(), { FLOORVOTE_INSTALL_PING: 'no', ...url, PATH: noCurl })
    expect(withYes.code).toBe(withNo.code)
    expect(withYes.code).not.toBe(0)
    expect(withYes.out).toContain('Preflight failed')
    expect(withYes.out).not.toMatch(/anonymous|tenant_setup/i)
    expect(installEvent.posts).toHaveLength(0)
  }, 60_000)
})

describe('new-instance.sh, anonymous setup report: documented', () => {
  const doc = fs.readFileSync(tenantsDoc, 'utf8')
  const section = (() => {
    const m = /^## .*setup report.*$/im.exec(doc)
    if (!m) return ''
    const rest = doc.slice(m.index + m[0].length)
    const next = rest.search(/^## /m)
    return next === -1 ? rest : rest.slice(0, next)
  })()

  beforeEach(() => installEvent.reset())

  it('has a section on the setup report in tenants.md, naming the variable and what is not sent', () => {
    expect(section).not.toBe('')
    expect(section).toContain('FLOORVOTE_INSTALL_PING')
    expect(section).toMatch(/\[y\/N\]|defaults? to (No|no)/)
    expect(section).toMatch(/slug/i)
    expect(section).toMatch(/email/i)
    expect(section).toMatch(/account ID/i)
  })

  it('documents a payload whose keys are exactly the keys the script sends', async () => {
    const block = /```json\n([\s\S]*?)```/.exec(section)
    expect(block, 'no JSON code block in the setup report section').not.toBeNull()
    const documented = JSON.parse(block![1])
    const dir = freshWork()
    await provision([], undefined, dir, { ...YES, FLOORVOTE_INSTALL_PING_URL: reportUrl() })
    const [sent] = reported()
    expect(Object.keys(documented).sort()).toEqual(Object.keys(sent).sort())
    expect(documented.event).toBe(sent.event)
  }, 60_000)

  it('is mentioned in the script header, beside the other options', () => {
    const header = fs.readFileSync(path.join(repoRoot, 'scripts/new-instance.sh'), 'utf8').split('\nset -euo pipefail')[0]
    expect(header).toContain('FLOORVOTE_INSTALL_PING')
  })
})
