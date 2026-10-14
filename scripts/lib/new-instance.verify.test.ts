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

const FAKE_NPX = `#!/usr/bin/env bash
if [[ "$1" == "tsx" ]]; then exec "$FAKE_TSX" "\${@:2}"; fi
if [[ "$1" == "wrangler" ]]; then
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

beforeAll(async () => {
  central = await startFakeCentral()
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'new-instance-'))
  fs.mkdirSync(path.join(work, 'scripts/lib'), { recursive: true })
  fs.mkdirSync(path.join(work, 'api'))
  fs.mkdirSync(path.join(work, 'central'))
  fs.mkdirSync(path.join(work, 'bin'))
  for (const f of ['new-instance.sh', 'verify-instance.sh', 'verify-instance.ts', 'lib/verify-instance.ts']) {
    fs.copyFileSync(path.join(repoRoot, 'scripts', f), path.join(work, 'scripts', f))
  }
  fs.chmodSync(path.join(work, 'scripts/new-instance.sh'), 0o755)
  fs.chmodSync(path.join(work, 'scripts/verify-instance.sh'), 0o755)
  fs.writeFileSync(path.join(work, 'package.json'), '{ "type": "module" }\n')
  fs.writeFileSync(path.join(work, 'api/wrangler.toml'), 'name = "acme"\n[assets]\nbinding = "ASSETS"\nrun_worker_first = ["/api/*"]\n')
  fs.writeFileSync(path.join(work, 'central/wrangler.toml'), '[vars]\nTENANT_QUEUE_PREFIX = "acme"\n')
  fs.writeFileSync(path.join(work, 'bin/npx'), FAKE_NPX, { mode: 0o755 })
  fs.writeFileSync(path.join(work, 'bin/npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(work, 'bin/sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  sh('git', ['init', '-q'], work)
  sh('git', ['config', 'user.email', 'test@example.org'], work)
  sh('git', ['config', 'user.name', 'Test'], work)
  sh('git', ['add', '-A'], work)
  sh('git', ['commit', '-q', '-m', 'init'], work)
})

afterAll(async () => {
  await central.close()
  fs.rmSync(work, { recursive: true, force: true })
})

function provision(extraArgs: string[] = [], stdin = 'tok\n\n\ny\n'): Promise<{ code: number; out: string }> {
  const args = [
    'scripts/new-instance.sh', '--slug', 'ri', '--states', 'RI', '--name', 'Rhode Island Clerks',
    '--admin-email', 'clerk@example.org', '--admin-name', 'Jane Doe',
    '--admin-secret', 'cli-secret', '--app-url', central.url, ...extraArgs,
  ]
  return new Promise((resolve) => {
    const child = spawn('bash', args, {
      cwd: work,
      env: {
        ...process.env,
        PATH: `${path.join(work, 'bin')}:${process.env.PATH}`,
        FAKE_TSX: tsx,
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
    // A run resumed past step 5 is not asked for secrets again.
    child.stdin.end(stdin)
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

describe('new-instance.sh, last step', () => {
  it('verifies the instance, expecting the build step 4 deployed even though later commits moved HEAD', async () => {
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
    expect(code).toBe(0)
    // The commits in steps 4 and 7 moved HEAD past what was deployed, so a
    // verifier that expected HEAD would have failed the health check above.
    expect(sh('git', ['rev-parse', '--short', 'HEAD'], work)).not.toBe(deployedHead)
  }, 60_000)

  it('exits non-zero on a failed check, naming the step to resume from and never the secret', async () => {
    central.set({ bound: false, build: sh('git', ['rev-parse', '--short', 'HEAD'], work) })
    // Resume past step 4, as an operator would after the first run: only the build
    // expectation is unknown now, so it must fall back to "any" rather than fail.
    const { code, out } = await provision(['--from-step', '7'], 'y\n')
    expect(out).toMatch(/FAIL\s+Registration on central/)
    expect(out).toContain('Central has no binding for this instance: did central redeploy after the binding step?')
    expect(out).toMatch(/\.\/scripts\/new-instance\.sh --slug ri .* --from-step 7\b/)
    expect(out).not.toContain('cli-secret')
    expect(out).not.toContain('--from-step 7 --from-step')
    expect(code).not.toBe(0)
  }, 60_000)
})
