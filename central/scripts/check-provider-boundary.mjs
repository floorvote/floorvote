// Fixture check for the provider boundary rule (eslint-provider-boundary.mjs).
// Runs in plain Node, since central's vitest runs in the Workers pool; `npm run
// lint` runs it after ESLint. Each case lints a snippet as if it lived at the
// given path and says how many boundary errors it should raise. Nothing is
// written to disk.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Linter } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import { providerBoundary } from '../eslint-provider-boundary.mjs'

const central = fileURLToPath(new URL('..', import.meta.url))
const linter = new Linter({ cwd: central })
const config = [{
  files: ['**/*.ts'],
  languageOptions: { parser: tsParser },
  plugins: { local: { rules: { 'provider-boundary': providerBoundary } } },
  rules: { 'local/provider-boundary': 'error' },
}]

const P = 'src/providers/legiscan/x.ts'
const P_DEEP = 'src/providers/legiscan/a/b/c/d/x.ts'
const CORE = 'src/lib/x.ts'

// [file, code, expected boundary errors]
const cases = [
  // Provider code: its own directory, the SDK, and npm packages pass.
  [P, "import { rateLimitedFetch } from '../sdk'", 0],
  [P, "import { getBill } from './client'", 0],
  [P, "import { Hono } from 'hono'", 0],
  [P_DEEP, "import { getBill } from '../../../../client'", 0],
  [P_DEEP, "import type { Provider } from '../../../../../sdk'", 0],
  // ...anything else in central fails, however it's spelled or reached.
  [P, "import type { Provider } from '../types'", 1],
  [P, "import { getProvider } from '../index'", 1],
  [P, "import { getProvider } from '..'", 1],
  [P, "import { nowDb } from '../../lib/dbTime'", 1],
  [P, "import { nowDb } from './../../lib/dbTime'", 1],
  [P, "import { getBill } from '../lims/client'", 1],
  [P, "import type { RateLimiter } from '../../../../shared/rateLimit'", 1],
  [P, "export * from '../../lib/dbTime'", 1],
  [P, "export { nowDb } from '../../lib/dbTime'", 1],
  [P, "export const m = () => import('../../lib/dbTime')", 1],
  [P, 'export const m = () => import(`../../lib/dbTime`)', 1],
  [P, "export const m = (p: string) => import(p)", 1],
  [P, "export type T = typeof import('../../lib/dbTime')", 1],
  [P, "export type E = import('../../types').Env", 1],
  [P_DEEP, "import { nowDb } from '../../../../../../lib/dbTime'", 1],
  [P_DEEP, "import type { Provider } from '../../../../../types'", 1],
  // Core: the registry passes, anything deeper in providers/ fails.
  [CORE, "import { getProvider } from '../providers'", 0],
  [CORE, "import { getProvider } from '../providers/index'", 0],
  [CORE, "import { nowDb } from './dbTime'", 0],
  ['src/index-legiscan.ts', "import { getProvider } from './providers'", 0],
  [CORE, "import type { Provider } from '../providers/types'", 1],
  [CORE, "import { rateLimitedFetch } from '../providers/sdk'", 1],
  [CORE, "import { getBill } from '../providers/legiscan/client'", 1],
  [CORE, "import { legiscan } from './../providers/legiscan'", 1],
  [CORE, "export const m = () => import('../providers/legiscan/client')", 1],
  [CORE, "export type T = typeof import('../providers/types')", 1],
  ['src/index-legiscan.ts', "import { legiscan } from './providers/legiscan'", 1],
  // The boundary files may import either side. Nothing else lives beside them.
  ['src/providers/index.ts', "import { legiscan } from './legiscan'", 0],
  ['src/providers/sdk.ts', "export { rateLimitedFetch } from '../lib/rateLimitedFetch'", 0],
  ['src/providers/types.ts', "import type { Env } from '../types'", 0],
  ['src/providers/helpers.ts', 'export const x = 1', 1],
]

let failures = 0
for (const [file, code, expected] of cases) {
  const messages = linter.verify(code, config, { filename: path.join(central, file) })
  const fatal = messages.filter(m => m.fatal)
  const errors = messages.filter(m => m.ruleId === 'local/provider-boundary')
  if (fatal.length > 0 || errors.length !== expected) {
    failures++
    console.error(`✗ ${file}: ${code}\n  expected ${expected} boundary error(s), got ${errors.length}`)
    for (const m of [...fatal, ...errors]) console.error(`    ${m.message}`)
  }
}

if (failures > 0) {
  console.error(`provider boundary: ${failures} of ${cases.length} case(s) failed`)
  process.exit(1)
}
console.log(`provider boundary: ${cases.length} cases pass`)
