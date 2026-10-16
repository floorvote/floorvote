#!/usr/bin/env tsx
/**
 * verify-instance.ts — CLI for the post-provisioning smoke test. Run it through
 * scripts/verify-instance.sh, which loads scripts/.env.ops and central/.dev.vars
 * first (the files new-instance.sh reads). The checks live in lib/verify-instance.ts.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  USAGE, UsageError, resolveConfig, runChecks, formatResult, formatFooter, exitCode,
} from './lib/verify-instance'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  let cfg
  try {
    cfg = resolveConfig(argv, process.env, {
      repoRoot,
      readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
      gitSha: () => {
        try { return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() || null } catch { return null }
      },
    })
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`verify-instance: ${e.message}\n\n${USAGE}`)
      return 2
    }
    throw e
  }

  console.log(`Verifying ${cfg.slug} (central: ${cfg.centralUrl})`)
  const results = await runChecks(cfg, {
    fetch,
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    now: () => Date.now(),
    onResult: (r) => console.log(formatResult(r)),
  })
  console.log(formatFooter(results, cfg))
  return exitCode(results)
}

main().then(code => process.exit(code), (e) => { console.error(e); process.exit(1) })
