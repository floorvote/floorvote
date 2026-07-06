#!/usr/bin/env tsx
/**
 * verify-tokenization.ts — CLI wrapper for the tokenize-verify tool.
 *
 * Usage:
 *   npx tsx scripts/verify-tokenization.ts <baseRef> <file> [<file> ...]
 *
 * For each file:
 *   - Reads OLD source via `git show <baseRef>:<file>`
 *   - Reads NEW source from the working tree
 *   - Calls verify() against the real design tokens
 *   - Prints PASS or FAIL with problem details
 *
 * Exit code 1 if any file fails.
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { verify } from './lib/tokenize-verify'
import type { TokenMaps } from './lib/tokenize-verify'

// Import the real token objects from web/src/styles/tokens.ts.
// These are `as const` objects; the TokenMaps interface expects
// Record<string, string|number> for color and Record<string, number> for the rest.
import { color, radius, fontSize, fontWeight } from '../web/src/styles/tokens'

const maps: TokenMaps = {
  color:      color      as unknown as Record<string, string>,
  radius:     radius     as Record<string, number>,
  fontSize:   fontSize   as Record<string, number>,
  fontWeight: fontWeight as Record<string, number>,
}

function main(): void {
  const [, , baseRef, ...files] = process.argv

  if (!baseRef || files.length === 0) {
    console.error('Usage: npx tsx scripts/verify-tokenization.ts <baseRef> <file> [<file> ...]')
    process.exit(2)
  }

  let anyFail = false
  const repoRoot = path.resolve(__dirname, '..')

  for (const file of files) {
    // Normalise to repo-relative path for git show
    const repoRelative = path.relative(repoRoot, path.resolve(file))

    let oldSrc: string
    try {
      oldSrc = execSync(`git show "${baseRef}:${repoRelative}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
      })
    } catch (err) {
      console.error(`SKIP  ${file}  (not found in ${baseRef}: ${(err as Error).message.split('\n')[0]})`)
      continue
    }

    let newSrc: string
    try {
      newSrc = fs.readFileSync(path.resolve(file), 'utf8')
    } catch (err) {
      console.error(`SKIP  ${file}  (cannot read working-tree file: ${(err as Error).message})`)
      continue
    }

    let result: ReturnType<typeof verify>
    try {
      result = verify(oldSrc, newSrc, maps)
    } catch (err) {
      console.error(`ERROR ${file}  (${(err as Error).message})`)
      anyFail = true
      continue
    }

    if (result.ok) {
      console.log(`PASS  ${file}`)
    } else {
      console.log(`FAIL  ${file}`)
      for (const p of result.problems) {
        console.log(`      ${p}`)
      }
      anyFail = true
    }
  }

  if (anyFail) process.exit(1)
}

main()
