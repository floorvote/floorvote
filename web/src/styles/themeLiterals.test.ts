import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// Every color in the app follows the color mode, so it has to come from a token
// (a CSS variable). The ESLint hex rule only sees a string that is exactly a hex
// color; this scan also finds hex inside longer strings (a boxShadow, a border,
// an embedded <style>), white text drawn in the card-surface token, and faint
// black hover fills that vanish on a dark card.

const SRC = path.resolve(__dirname, '..')

// Not app code, or literal by design.
const SKIP_DIRS = [
  'test',                    // test utilities
  'components/tiptap-ui',    // vendored Tiptap UI; styled by its own .dark rules
  'components/tiptap-ui-primitive',
  'components/tiptap-node',
  'components/tiptap-templates',
]
const SKIP_FILES = [
  'styles/tokens.ts',        // the tokens themselves
  'styles/colorModes.ts',    // the dark palette
]
// The one literal kept on purpose: the nav progress bar reads the same in both modes.
const ALLOWED = [{ file: 'styles/mobile.css', literal: '#60a5fa' }]

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    const rel = path.relative(SRC, full)
    if (e.isDirectory()) return SKIP_DIRS.includes(rel) ? [] : sourceFiles(full)
    if (!/\.(tsx?|css)$/.test(e.name) || /\.test\.tsx?$/.test(e.name) || SKIP_FILES.includes(rel)) return []
    return [full]
  })
}

/** Source with comments blanked out, line numbers kept (issue refs like "(#355)" live there). */
function code(src: string): string[] {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  return noBlock.split('\n').map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
}

interface Hit { file: string; line: number; text: string }

function scan(test: (line: string) => RegExpMatchArray | null, allow: (file: string, match: string) => boolean = () => false): Hit[] {
  const hits: Hit[] = []
  for (const full of sourceFiles(SRC)) {
    const file = path.relative(SRC, full)
    code(fs.readFileSync(full, 'utf8')).forEach((line, i) => {
      const m = test(line)
      if (m && !allow(file, m[0].toLowerCase())) hits.push({ file, line: i + 1, text: line.trim().slice(0, 140) })
    })
  }
  return hits
}

const fmt = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n')

describe('app colors come from tokens, so they follow the color mode', () => {
  it('scans a real tree', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(100)
  })

  it('has no raw hex colors in app code', () => {
    const hits = scan(
      (line) => line.match(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/),
      (file, literal) => ALLOWED.some((a) => a.file === file && a.literal === literal),
    )
    expect(fmt(hits)).toBe('')
  })

  it('never draws text in `white`, the card surface (use textOnFill on a colored fill)', () => {
    const hits = scan((line) => line.match(/\bcolor:\s*[^,}]*\bcolor\.white\b/))
    expect(fmt(hits)).toBe('')
  })

  it('has no faint black hover fills, which vanish on a dark card (use surfaceMuted)', () => {
    // Shadows and modal scrims (alpha 0.25 and up) read in both modes and are fine.
    const hits = scan((line) => (/shadow/i.test(line) ? null : line.match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.0\d*\s*\)/)))
    expect(fmt(hits)).toBe('')
  })
})
