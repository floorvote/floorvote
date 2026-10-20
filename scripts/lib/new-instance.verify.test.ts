import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeCentral, type FakeCentral } from './fake-central.testutil'

// Runs the real scripts/new-instance.sh end to end in a throwaway git repo, with
// wrangler and npm faked on PATH and central faked over local HTTP. It proves the
// wiring of the last step: verification runs after provisioning, passes what the
// run provisioned with, and on failure names the step to resume from.
// Nothing here touches Cloudflare, a real central, or this checkout's config.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tsx = path.join(repoRoot, 'node_modules/.bin/tsx')

let central: FakeCentral
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

/** A throwaway git repo holding the scripts under test and a minimal config. */
function makeWork(): string {
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
  sh('git', ['commit', '-q', '-m', 'init'], dir)
  return dir
}

const extraWorks: string[] = []

beforeAll(async () => {
  central = await startFakeCentral()
  work = makeWork()
})

afterAll(async () => {
  await central.close()
  for (const dir of [work, ...extraWorks]) fs.rmSync(dir, { recursive: true, force: true })
})

const wranglerLog = (dir: string) => {
  try { return fs.readFileSync(path.join(dir, 'wrangler.log'), 'utf8') } catch { return '' }
}
const tenantToml = (dir: string) => fs.readFileSync(path.join(dir, 'api/wrangler.toml'), 'utf8')

function provision(extraArgs: string[] = [], stdin = 'tok\n\n\ny\n', dir = work): Promise<{ code: number; out: string }> {
  const args = [
    'scripts/new-instance.sh', '--slug', 'ri', '--states', 'RI', '--name', 'Rhode Island Clerks',
    '--admin-email', 'clerk@example.org', '--admin-name', 'Jane Doe',
    '--admin-secret', 'cli-secret', '--app-url', central.url, ...extraArgs,
  ]
  return new Promise((resolve) => {
    const child = spawn('bash', args, {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        FAKE_TSX: tsx, FAKE_WORK: dir,
        RESOURCE_PREFIX: 'acme', ACCOUNT_SUBDOMAIN: 'sub', CF_ACCOUNT_ID: 'acct12345678',
        CF_AIG_GATEWAY: 'gw', SUPERADMIN_JWT_PUBLIC_KEY: '{"kty":"EC"}',
        CENTRAL_URL: central.url, ALERT_EMAILS: 'ops@acme.example',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    // Default: CF_AIG_TOKEN, the two optional keys left blank, then the confirmation.
    // A run resumed past the secrets step is not asked for them again.
    child.stdin.end(stdin)
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
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
