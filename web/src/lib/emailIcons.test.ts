import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMAIL_ICON_NEEDS, parseIconAllowlist, emailIconSrc, EMAIL_ICONS_DIR } from '../../../shared/emailIcons'

// Repo root from this test file (web/src/lib/emailIcons.test.ts).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const allowlist = new Set(parseIconAllowlist(readFileSync(join(ROOT, 'web/index.html'), 'utf8')))

describe('email icon set stays in sync', () => {
  it('parses a non-empty allowlist from index.html', () => {
    expect(allowlist.size).toBeGreaterThan(0)
    expect(allowlist.has('gavel')).toBe(true)
  })

  it('every email icon is in the Material Symbols allowlist', () => {
    for (const need of EMAIL_ICON_NEEDS) {
      expect(allowlist.has(need.icon), `${need.icon} missing from web/index.html icon_names`).toBe(true)
    }
  })

  it('every email icon has a generated PNG (run npm run gen:email-icons)', () => {
    for (const need of EMAIL_ICON_NEEDS) {
      const file = emailIconSrc(need.icon, need.hex, need.fill)
      const p = join(ROOT, EMAIL_ICONS_DIR, file)
      expect(existsSync(p), `${file} not generated — run: npm run gen:email-icons`).toBe(true)
    }
  })
})
