import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMAIL_ICON_NEEDS, emailIconSrc } from '../../shared/emailIcons'
import { generateEmailIcons, isGeneratedIconName, pruneOrphanIcons } from './emailIconsGen'

// The email-icon generator owns only files named `<glyph>__<hex>[-fill].png`.
// `gen:brand-assets` writes wordmark.png and wordmark-mark.png into the same
// directory, so cleanup must never touch them.

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'email-icons-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const touch = (name: string, body = 'x') => writeFileSync(join(dir, name), body)
const names = () => readdirSync(dir).sort()

describe('isGeneratedIconName', () => {
  it.each([
    'gavel__1e3a5f.png',
    'thumbs_up_down__1d9e75-fill.png',
    'link_2__667386.png',
    'how_to_vote__0f766e.png',
    'event__3b82f6.png',
  ])('owns %s', name => {
    expect(isGeneratedIconName(name)).toBe(true)
  })

  it.each([
    'wordmark.png',
    'wordmark-mark.png',
    'favicon.png',
    'gavel.png',
    'gavel__1e3a5f.svg',
    'gavel__1e3a5f.png.bak',
    'gavel__zzzzzz.png',
    '.DS_Store',
    'README.md',
    'sub/gavel__1e3a5f.png',
  ])('does not own %s', name => {
    expect(isGeneratedIconName(name)).toBe(false)
  })

  it('owns every filename the generator can emit', () => {
    for (const n of EMAIL_ICON_NEEDS) expect(isGeneratedIconName(emailIconSrc(n.icon, n.hex, n.fill)), n.icon).toBe(true)
  })
})

describe('pruneOrphanIcons', () => {
  it('removes only the orphaned generated icon, leaving the wordmark files and a current icon', () => {
    touch('wordmark.png')
    touch('wordmark-mark.png')
    touch('gavel__1e3a5f.png')
    touch('flag__5e697d.png')
    const removed = pruneOrphanIcons(dir, new Set(['gavel__1e3a5f.png']))
    expect(removed).toEqual(['flag__5e697d.png'])
    expect(names()).toEqual(['gavel__1e3a5f.png', 'wordmark-mark.png', 'wordmark.png'])
  })

  it('removes an orphaned filled icon', () => {
    touch('thumbs_up_down__dc2626-fill.png')
    pruneOrphanIcons(dir, new Set())
    expect(names()).toEqual([])
  })

  it('leaves files and directories outside the generated pattern alone', () => {
    touch('notes.txt')
    touch('.DS_Store')
    mkdirSync(join(dir, 'gavel__aaaaaa.png'))  // a directory that happens to match the pattern
    pruneOrphanIcons(dir, new Set())
    expect(names()).toEqual(['.DS_Store', 'gavel__aaaaaa.png', 'notes.txt'])
  })

  it('does nothing for an empty directory, and for one where every icon is current', () => {
    expect(pruneOrphanIcons(dir, new Set())).toEqual([])
    touch('gavel__1e3a5f.png')
    expect(pruneOrphanIcons(dir, new Set(['gavel__1e3a5f.png']))).toEqual([])
    expect(names()).toEqual(['gavel__1e3a5f.png'])
  })

  it('does nothing when the directory does not exist', () => {
    expect(pruneOrphanIcons(join(dir, 'missing'), new Set())).toEqual([])
  })
})

describe('generateEmailIcons', () => {
  const wanted = EMAIL_ICON_NEEDS.map(n => emailIconSrc(n.icon, n.hex, n.fill)).sort()

  it('leaves the wordmark images in place', () => {
    touch('wordmark.png', 'brand-lockup')
    touch('wordmark-mark.png', 'brand-mark')
    generateEmailIcons(dir)
    expect(readFileSync(join(dir, 'wordmark.png'), 'utf8')).toBe('brand-lockup')
    expect(readFileSync(join(dir, 'wordmark-mark.png'), 'utf8')).toBe('brand-mark')
  })

  it('writes every icon it owns, as a real PNG, into a directory that did not exist', () => {
    const out = join(dir, 'fresh', 'email-icons')
    generateEmailIcons(out)
    expect(readdirSync(out).sort()).toEqual(wanted)
    for (const f of wanted) expect(readFileSync(join(out, f)).subarray(1, 4).toString('latin1'), f).toBe('PNG')
  })

  it('regenerates an icon it owns, replacing stale bytes', () => {
    const f = wanted[0]
    touch(f, 'stale')
    generateEmailIcons(dir)
    expect(readFileSync(join(dir, f)).subarray(1, 4).toString('latin1')).toBe('PNG')
  })

  it('removes an orphaned icon from a renamed glyph but nothing else', () => {
    touch('wordmark.png')
    touch('renamed_glyph__123456.png')
    touch('notes.txt')
    generateEmailIcons(dir)
    expect(existsSync(join(dir, 'renamed_glyph__123456.png'))).toBe(false)
    expect(existsSync(join(dir, 'wordmark.png'))).toBe(true)
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true)
    expect(names()).toEqual([...wanted, 'notes.txt', 'wordmark.png'].sort())
  })

  it('is idempotent: a second run changes neither the file set nor any bytes', () => {
    touch('wordmark.png', 'brand-lockup')
    touch('wordmark-mark.png', 'brand-mark')
    generateEmailIcons(dir)
    const snapshot = () => Object.fromEntries(names().map(n => [n, readFileSync(join(dir, n)).toString('base64')]))
    const first = snapshot()
    generateEmailIcons(dir)
    expect(snapshot()).toEqual(first)
  })

  it('returns the filenames it wrote', () => {
    expect(generateEmailIcons(dir).sort()).toEqual(wanted)
  })
})
