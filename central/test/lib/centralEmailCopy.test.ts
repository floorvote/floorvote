import { describe, it, expect } from 'vitest'

// Central sends through the shared sender (#710). Its own copy of the sender,
// central/src/lib/email.ts, is gone, and nothing may reach for it again.
// Reads source files as text through Vite, so it runs in the Workers pool.

const sources = import.meta.glob('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const tests = import.meta.glob(['../**/*.ts', '!../**/centralEmailCopy.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>

// An import or re-export, or a vi.mock, whose specifier ends in `lib/email` or is `./email`.
const IMPORTS_COPY = /(?:from\s+|import\(\s*|vi\.mock\(\s*|require\(\s*)['"](?:(?:\.\.?\/)+(?:[\w./-]*\/)?lib\/email|\.\/email)(?:\.ts)?['"]/

// A direct call on the `EMAIL` binding, with or without a non-null or optional access.
const SEND_CALL = /\bEMAIL[!?]?\.send\(/

describe("central's own email copy", () => {
  it('read every source and test file as a string', () => {
    for (const [file, text] of [...Object.entries(sources), ...Object.entries(tests)]) expect(typeof text, file).toBe('string')
  })

  it('scans real sources: adminEmail.ts and jobAlert.ts use centralSender', () => {
    expect(sources['../../src/lib/adminEmail.ts']).toContain('centralSender')
    expect(sources['../../src/lib/jobAlert.ts']).toContain('centralSender')
  })

  it('has found central sources to scan', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
    expect(Object.keys(tests).length).toBeGreaterThan(20)
  })

  it('has no central/src/lib/email.ts', () => {
    expect(Object.keys(sources).filter((f) => /\/lib\/email\.ts$/.test(f))).toEqual([])
  })

  it('has no test of the deleted module left in src or test', () => {
    const leftovers = [...Object.keys(sources), ...Object.keys(tests)].filter((f) => /\/lib\/email\.test\.ts$/.test(f))
    expect(leftovers).toEqual([])
  })

  it('imports nothing from the deleted module, in source or tests', () => {
    const offenders = [...Object.entries(sources), ...Object.entries(tests)]
      .filter(([, text]) => IMPORTS_COPY.test(text))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })

  it('has no src file that sends mail through anything but the shared sender', () => {
    const rawProviders = Object.entries(sources)
      .filter(([, text]) => text.includes('api.resend.com/emails') || SEND_CALL.test(text))
      .map(([file]) => file)
    expect(rawProviders).toEqual([])
  })

  it('detects the import shapes it is meant to catch', () => {
    for (const bad of [
      `import { sendEmail } from './email'`,
      `import { sendEmail } from '../lib/email'`,
      `import type { CloudflareEmailBinding } from './lib/email'`,
      `export * from './email'`,
      `vi.mock('../../src/lib/email', () => ({}))`,
      `const m = await import('./lib/email')`,
    ]) expect(IMPORTS_COPY.test(bad), bad).toBe(true)
    for (const fine of [
      `import { sendOpsAlert } from './jobAlert'`,
      `import { isValidEmail } from '../../../shared/email'`,
      `import { x } from './emailDelivery'`,
      `import { x } from '../lib/emailSuppression'`,
    ]) expect(IMPORTS_COPY.test(fine), fine).toBe(false)
  })

  it('detects the binding send shapes it is meant to catch', () => {
    for (const bad of [`EMAIL.send(msg)`, `EMAIL?.send(msg)`, `env.EMAIL!.send(msg)`]) expect(SEND_CALL.test(bad), bad).toBe(true)
    for (const fine of [`EMAIL_LOG.send(msg)`, `emailSender.send(msg)`, `sendEmail(env, msg)`]) expect(SEND_CALL.test(fine), fine).toBe(false)
  })
})
