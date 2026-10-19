import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { contrast, PALETTES, type Mode } from '../test/colorTokens'
import type { ColorToken } from './colorModes'

// #642: accentBlue is a fill/outline accent (3.68:1 on white), not a text color.
// Text links and text buttons on light surfaces use linkBlue (the #484 / #589
// precedent). This pins each former accentBlue text use at WCAG AA (4.5:1) in
// both color modes, on every surface the text can sit on, and fails if a
// listed file draws accentBlue as text again.
const AA_NORMAL = 4.5
const MODES: Mode[] = ['light', 'dark']
const WEB_SRC = path.resolve(__dirname, '..')

// The surfaces these texts render on: white cards and panels, the muted and
// subtle surfaces, and the event popover's expanded tints (bgInfo for default
// events, bgAmberPriority for deadlines).
const SURFACES: ColorToken[] = ['white', 'surfaceSubtle', 'surfaceMuted', 'bgInfo', 'bgAmberPriority']

interface TextUse { file: string; label: string; token: ColorToken }

// Every text color token named in a `color:` style expression on lines that
// mention `marker`, so conditionals like `a ? textMuted : linkBlue` count both.
function textTokens(file: string, marker: RegExp): TextUse[] {
  const src = fs.readFileSync(path.join(WEB_SRC, file), 'utf8')
  const uses: TextUse[] = []
  src.split('\n').forEach((line, i) => {
    if (!marker.test(line)) return
    const m = line.match(/(?<![A-Za-z])color:\s*([^,}]*)/)
    if (!m) return
    for (const t of m[1].matchAll(/color\.([A-Za-z0-9]+)/g)) {
      uses.push({ file, label: `${file}:${i + 1}`, token: t[1] as ColorToken })
    }
  })
  return uses
}

const FILES = [
  'components/calendar/EventPopover.tsx',
  'components/calendar/EventLines.tsx',
  'pages/admin/Members.tsx',
]

// The text-on-surface uses #642 lists: the bill links in the popover, the
// agenda link chips and "show more" button, and the Members header actions.
const USES: TextUse[] = [
  ...textTokens('components/calendar/EventPopover.tsx', /<Link to=\{billUrl/),
  ...textTokens('components/calendar/EventLines.tsx', /textDecoration: 'underline', overflowWrap|cursor: 'pointer', fontSize: fontSize\.xs, color:/),
  ...textTokens('pages/admin/Members.tsx', /color: color\.accentBlue|copyableEmails\.length === 0 \? color\.textMuted/),
]

describe('accentBlue text contrast (#642)', () => {
  it('finds the listed text uses', () => {
    expect(USES.map((u) => u.label).sort()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/EventPopover\.tsx:\d+/),
        expect.stringMatching(/EventLines\.tsx:\d+/),
        expect.stringMatching(/Members\.tsx:\d+/),
      ]),
    )
    expect(USES.length).toBeGreaterThanOrEqual(6)
  })

  describe.each(MODES)('%s mode', (mode) => {
    for (const use of USES) {
      if (use.token === 'textMuted') continue // the disabled state, exempt from AA and unchanged
      it.each(SURFACES)(`${use.label} (${use.token}) clears 4.5:1 on %s`, (surface) => {
        const fg = PALETTES[mode][use.token]
        const bg = PALETTES[mode][surface]
        const ratio = contrast(fg, bg)
        expect(ratio, `${use.token} ${fg} on ${surface} ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL)
      })
    }
  })

  it('documents why: accentBlue itself fails AA on white in light mode', () => {
    expect(contrast(PALETTES.light.accentBlue, PALETTES.light.white)).toBeLessThan(AA_NORMAL)
  })

  it.each(FILES)('%s draws no text in accentBlue', (file) => {
    const src = fs.readFileSync(path.join(WEB_SRC, file), 'utf8')
    const offenders = src
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /(?<![A-Za-z])color:[^,}]*\baccentBlue\b/.test(line))
      .map(({ n }) => `${file}:${n}`)
    expect(offenders).toEqual([])
  })
})
