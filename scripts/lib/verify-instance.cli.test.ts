import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeCentral, type FakeCentral } from './fake-central.testutil'
import { BLOCKED_MARKER, loopbackOnlyFetchEnv } from './loopback-only-fetch.testutil'

// Runs the real scripts/verify-instance.sh (bash, then tsx) against a local fake
// of central and of the instance. Nothing here touches a real deployment: every
// URL is a flag pointing at 127.0.0.1, and the child process's `fetch` refuses
// any other host (see run() and the tests that check it).
//
// The script also reads api/wrangler.toml, which a fork tracks with real
// instances in it (a slug's APP_URL is its live site). A URL the test does not
// pass as a flag can therefore resolve to a production host, so each URL the
// script can use is passed explicitly, and the refusal catches any that isn't.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let central: FakeCentral

beforeAll(async () => { central = await startFakeCentral() })
afterAll(async () => { await central.close() })
beforeEach(() => { central.requests.length = 0 })

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(repoRoot, 'scripts/verify-instance.sh'), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...loopbackOnlyFetchEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

/** Fails the test, naming the host, if the child tried to reach anything but loopback. */
const expectNoOutsideRequest = (out: string) => expect(out).not.toContain(BLOCKED_MARKER)

// --app-url matters most: without it the script reads the slug's APP_URL from api/wrangler.toml.
const common = () => ['ri', '--central-url', central.url, '--worker-url', central.url, '--app-url', central.url, '--admin-secret', 'cli-secret', '--expect-build', 'cafe123', '--to', 'ops@example.org']

describe('scripts/verify-instance.sh', () => {
  it('exits 0 and reports each check when everything works', async () => {
    central.set({ bound: true })
    const { code, out } = await run(common())
    expect(out).toMatch(/pass\s+Health and build/)
    expect(out).toMatch(/pass\s+Registration on central/)
    expect(out).toMatch(/pass\s+Queue delivery/)
    expect(out).toMatch(/skipped\s+AI analysis/)
    expect(out).toMatch(/pass\s+Email: sample digest sent to ops@example.org via resend/)
    expectNoOutsideRequest(out)
    expect(central.requests.some(r => r.path === '/api/health')).toBe(true)
    expect(code).toBe(0)
  }, 30_000)

  it('runs the AI check only when asked', async () => {
    central.set({ bound: true })
    const { code, out } = await run([...common(), '--ai'])
    expect(out).toMatch(/pass\s+AI analysis: analyzed HB 1/)
    expectNoOutsideRequest(out)
    expect(code).toBe(0)
  }, 30_000)

  it('exits non-zero, names the cause, and prints the resume command on a failure', async () => {
    central.set({ bound: false })
    const { code, out } = await run([
      ...common(), '--resume-cmd', './scripts/new-instance.sh --slug ri', '--resume-steps', 'bind=7,verify=11',
    ])
    expect(out).toMatch(/FAIL\s+Registration on central/)
    expect(out).toContain('Central has no binding for this instance: did central redeploy after the binding step?')
    expect(out).toContain('./scripts/new-instance.sh --slug ri --from-step 7')
    expectNoOutsideRequest(out)
    expect(code).toBe(1)
  }, 30_000)

  it('exits 2 with usage when no slug is given', async () => {
    const { code, out } = await run([], { ADMIN_SECRET: 'x' })
    expect(code).toBe(2)
    expect(out).toContain('A slug is required')
  }, 30_000)

  it('prints usage for --help without needing any configuration', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('Usage: scripts/verify-instance.sh')
  }, 30_000)

  // The check above is only worth something if the refusal is really in the
  // child. These run a bare node with the same environment and a documentation-
  // range address (RFC 5737), so nothing is sent even if the refusal is broken.
  describe('the loopback-only refusal the tests above rely on', () => {
    const fetchIn = (url: string) => new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(() => process.exit(0), () => process.exit(7))`], {
        env: { PATH: process.env.PATH ?? '', ...loopbackOnlyFetchEnv() },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { out += d })
      child.on('close', (code) => resolve({ code: code ?? -1, out }))
    })

    it('refuses a request to a host outside the machine and names it', async () => {
      const { code, out } = await fetchIn('https://203.0.113.9/api/health')
      expect(code).toBe(7)
      expect(out).toContain(`${BLOCKED_MARKER} https://203.0.113.9/api/health`)
    }, 30_000)

    it('refuses a hostname that merely contains 127.0.0.1', async () => {
      const { code, out } = await fetchIn('https://127.0.0.1.example.invalid/api/health')
      expect(code).toBe(7)
      expect(out).toContain(BLOCKED_MARKER)
    }, 30_000)

    it('lets a request to the local fake through', async () => {
      const { code, out } = await fetchIn(`${central.url}/api/health`)
      expect(code).toBe(0)
      expect(out).not.toContain(BLOCKED_MARKER)
    }, 30_000)
  })
})
