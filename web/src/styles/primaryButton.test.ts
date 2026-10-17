import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { primaryButtonColors } from './primaryButton'
import { contrast, resolveColor, type Mode } from '../test/colorTokens'

// Primary buttons put textOnFill on a solid fill. accentBlue is only 3.68:1 with
// white in light mode, so the fill is linkBlue (#484 / #589). WCAG exempts
// disabled controls from contrast rules, but a disabled button still has to be
// read ("why can't I click this?"), so its text gets a 3:1 floor against its own
// fill: a deliberate bar below AA, since the control is inactive.
const AA_NORMAL = 4.5
const DISABLED_TEXT_MIN = 3

const MODES: Mode[] = ['light', 'dark']

describe.each(MODES)('primary button colors (%s mode)', (mode) => {
  it('enabled text clears AA on the fill', () => {
    const s = primaryButtonColors(false)
    expect(s.background, 'enabled background').toBeDefined()
    expect(s.color, 'enabled color').toBeDefined()
    const fg = resolveColor(String(s.color), mode)
    const bg = resolveColor(String(s.background), mode)
    const ratio = contrast(fg, bg)
    expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('uses textOnFill on linkBlue, the #484 precedent, not accentBlue', () => {
    const s = primaryButtonColors(false)
    expect(s.color).toBe('var(--fv-text-on-fill)')
    expect(s.background).toBe('var(--fv-link-blue)')
  })

  it('disabled text stays legible on the disabled fill', () => {
    const s = primaryButtonColors(true)
    expect(s.background, 'disabled background').toBeDefined()
    expect(s.color, 'disabled color').toBeDefined()
    const fg = resolveColor(String(s.color), mode)
    const bg = resolveColor(String(s.background), mode)
    const ratio = contrast(fg, bg)
    expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(DISABLED_TEXT_MIN)
  })

  it('disabled looks different from enabled, and is outlined', () => {
    const on = primaryButtonColors(false)
    const off = primaryButtonColors(true)
    expect(off.background).toBeDefined()
    expect(off.background).not.toBe(on.background)
    expect(off.color).not.toBe(on.color)
    expect(String(off.boxShadow ?? off.border ?? '')).toMatch(/--fv-border-default/)
  })

  it('does not dim the button with opacity (that drops the text below the bar)', () => {
    expect(primaryButtonColors(true).opacity).toBeUndefined()
    expect(primaryButtonColors(false).opacity).toBeUndefined()
  })
})

// No button may fill with accentBlue or accentBlueMuted and draw textOnFill on
// it: that pair is 3.68:1 (and 1.80:1 muted) in light mode. Scans each source
// file for a `background:` naming either token with textOnFill within the same
// style object (a few lines either side).
describe('no textOnFill on accentBlue or accentBlueMuted', () => {
  const SRC = path.resolve(__dirname, '..')
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === 'test' || e.name.startsWith('tiptap') ? [] : files(full)
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : []
    })
  }

  it('finds none', () => {
    const hits: string[] = []
    for (const full of files(SRC)) {
      const rel = path.relative(SRC, full)
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      const found: string[] = []
      lines.forEach((line, i) => {
        const isFill = /(background(Color)?\s*:|actionBtn\()[^\n]*\baccentBlue(Muted)?\b/.test(line)
        if (!isFill) return
        // A button-maker taking its fill as an argument draws its text elsewhere in the file.
        const near = /actionBtn\(/.test(line) ? lines.join('\n') : lines.slice(Math.max(0, i - 3), i + 4).join('\n')
        if (/\btextOnFill\b/.test(near)) found.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
      hits.push(...found)
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})

// A primary button's colors are only as legible as the helper makes them if
// nothing dims them afterward, so no `opacity:` may share a style object with
// primaryButtonColors(...) (a few lines either side).
describe('no opacity beside primaryButtonColors', () => {
  const SRC = path.resolve(__dirname, '..')
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === 'test' || e.name.startsWith('tiptap') ? [] : files(full)
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : []
    })
  }

  it('finds none', () => {
    const hits: string[] = []
    for (const full of files(SRC)) {
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\.\.\.primaryButtonColors\(/.test(line)) return
        // The enclosing style object: from the nearest `{` line above to its closing `}` below.
        const near = lines.slice(Math.max(0, i - 3), i + 8).join('\n')
        if (/\bopacity\s*:/.test(near)) hits.push(`${path.relative(SRC, full)}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})
