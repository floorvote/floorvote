// Rasterize the email icon set and prune the orphans it leaves behind.
//
// The icon generator owns only files named `<glyph>__<hex>[-fill].png` (see
// emailIconSrc in shared/emailIcons.ts). `gen:brand-assets` writes
// wordmark.png and wordmark-mark.png into the same directory, so cleanup must
// never touch a name outside that pattern.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { EMAIL_ICON_NEEDS, parseIconAllowlist, emailIconSrc } from '../../shared/emailIcons'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Render at ~3x the 22px tile so glyphs stay crisp on retina mail clients.
const RENDER_WIDTH = 66

// A glyph is lowercase alphanumerics joined by single underscores (link_2,
// how_to_vote); `__` then separates it from the baked fill color.
const GENERATED_ICON = /^[a-z0-9]+(?:_[a-z0-9]+)*__[0-9a-f]{3,8}(?:-fill)?\.png$/

/** Whether the icon generator owns a file of this name. */
export function isGeneratedIconName(name: string): boolean {
  return GENERATED_ICON.test(name)
}

/**
 * Delete the generated-pattern files in `dir` that aren't in `keep`, and
 * return their names. Anything else in the directory (the wordmark images,
 * stray files, subdirectories) is left alone.
 */
export function pruneOrphanIcons(dir: string, keep: ReadonlySet<string>): string[] {
  if (!existsSync(dir)) return []
  const removed: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !isGeneratedIconName(entry.name) || keep.has(entry.name)) continue
    rmSync(join(dir, entry.name))
    removed.push(entry.name)
  }
  return removed.sort()
}

function svgPathFor(icon: string, fill: boolean): string {
  const file = `${icon}${fill ? '-fill' : ''}.svg`
  return join(ROOT, 'node_modules/@material-symbols/svg-400/outlined', file)
}

/**
 * Render the whole email icon set into `outDir` and return the filenames
 * written. Renders everything first (validating the allowlist and the source
 * svg reads), so a missing or renamed glyph aborts before the output
 * directory is touched. Then writes each icon and prunes only the icons it
 * owns that this run didn't write.
 */
export function generateEmailIcons(outDir: string): string[] {
  const allowlist = new Set(parseIconAllowlist(readFileSync(join(ROOT, 'web/index.html'), 'utf8')))

  const rendered = EMAIL_ICON_NEEDS.map(need => {
    if (!allowlist.has(need.icon)) {
      throw new Error(`Icon "${need.icon}" is not in the web/index.html allowlist — add it there first.`)
    }
    // Material Symbols paths carry no fill attribute, so injecting one colors the glyph.
    const raw = readFileSync(svgPathFor(need.icon, need.fill), 'utf8')
    const colored = raw.replace(/<path /g, `<path fill="${need.hex}" `)
    const png = new Resvg(colored, { fitTo: { mode: 'width', value: RENDER_WIDTH }, font: { loadSystemFonts: false } }).render().asPng()
    return { file: emailIconSrc(need.icon, need.hex, need.fill), png }
  })

  mkdirSync(outDir, { recursive: true })
  for (const { file, png } of rendered) writeFileSync(join(outDir, file), png)
  const written = rendered.map(r => r.file)
  pruneOrphanIcons(outDir, new Set(written))
  return written
}
