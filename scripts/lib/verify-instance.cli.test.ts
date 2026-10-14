import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeCentral, type FakeCentral } from './fake-central.testutil'

// Runs the real scripts/verify-instance.sh (bash, then tsx) against a local fake
// of central and of the instance. Nothing here touches a real deployment: every
// URL is a flag pointing at 127.0.0.1.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let central: FakeCentral

beforeAll(async () => { central = await startFakeCentral() })
afterAll(async () => { await central.close() })

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(repoRoot, 'scripts/verify-instance.sh'), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

const common = () => ['ri', '--central-url', central.url, '--worker-url', central.url, '--admin-secret', 'cli-secret', '--expect-build', 'cafe123', '--to', 'ops@example.org']

describe('scripts/verify-instance.sh', () => {
  it('exits 0 and reports each check when everything works', async () => {
    central.set({ bound: true })
    const { code, out } = await run(common())
    expect(out).toMatch(/pass\s+Health and build/)
    expect(out).toMatch(/pass\s+Registration on central/)
    expect(out).toMatch(/pass\s+Queue delivery/)
    expect(out).toMatch(/skipped\s+AI analysis/)
    expect(out).toMatch(/pass\s+Email: sample digest sent to ops@example.org via resend/)
    expect(code).toBe(0)
  }, 30_000)

  it('runs the AI check only when asked', async () => {
    central.set({ bound: true })
    const { code, out } = await run([...common(), '--ai'])
    expect(out).toMatch(/pass\s+AI analysis: analyzed HB 1/)
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
})
