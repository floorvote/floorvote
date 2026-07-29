// Rasterize the FloorVote brand asset set from the single source shared/logo.ts.
//
//   npm run gen:brand-assets
//
// Writes into web/public/:
//   favicon.svg + favicon-{16,32,48}.png + favicon.ico  — transparent Honey mark,
//     centered on a SQUARE canvas (the mark is wide, so a square frame keeps the
//     tab icon un-stretched).
//   apple-touch-icon.png (180) + icon-{192,512}.png       — navy full-bleed square
//     (rx=0; iOS masks its own corners), mark centered ~68% width. Maskable-safe.
//   email-icons/wordmark-mark.png                          — transparent Honey mark
//     at its natural (tight) aspect, for the email masthead <img>.
//
// All geometry derives from LOGO_MARK — never hand-drawn. Run whenever the mark
// or its colors change.

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { LOGO_MARK, logoMarkSvg } from '../shared/logo'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'web/public')
const HONEY = '#e8a33d'
const NAVY = '#1e3a5f'

// The mark's bounding box (baked coords) centers on (50, 46.6). Frame it in a
// square for the tab icon: side 66 → ~87% width fill, comfortable margin.
const SQUARE_VB = '17 13.6 66 66'

function markPaths(): string {
  return LOGO_MARK.paths.map((d) => `<path d="${d}"/>`).join('')
}

/** Transparent Honey mark centered on a square canvas (for favicon.svg + PNGs). */
function markSquareSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SQUARE_VB}" fill="none" stroke="${HONEY}" stroke-width="${LOGO_MARK.strokeWidth}">${markPaths()}</svg>`
}

/** Navy full-bleed square, mark centered ~68% width. rx=0 — iOS/Android mask their own corners. */
function navySquareSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${NAVY}"/><g transform="translate(50 50) scale(1.18) translate(-50 -46.6)" fill="none" stroke="${HONEY}" stroke-width="${LOGO_MARK.strokeWidth}">${markPaths()}</g></svg>`
}

function png(svg: string, width: number): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng())
}

/** Minimal ICO container embedding PNG frames (PNG-in-ICO; supported everywhere modern). */
function ico(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(frames.length, 4)
  const entries: Buffer[] = []
  const blobs: Buffer[] = []
  let offset = 6 + frames.length * 16
  for (const { size, png } of frames) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    blobs.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...entries, ...blobs])
}

export interface BrandAsset { name: string; data: Buffer }

export function buildBrandAssets(): BrandAsset[] {
  const square = markSquareSvg()
  const navy = navySquareSvg()
  const f16 = png(square, 16)
  const f32 = png(square, 32)
  const f48 = png(square, 48)
  return [
    { name: 'favicon.svg', data: Buffer.from(square + '\n', 'utf8') },
    { name: 'favicon-16.png', data: f16 },
    { name: 'favicon-32.png', data: f32 },
    { name: 'favicon-48.png', data: f48 },
    { name: 'favicon.ico', data: ico([{ size: 16, png: f16 }, { size: 32, png: f32 }, { size: 48, png: f48 }]) },
    { name: 'apple-touch-icon.png', data: png(navy, 180) },
    { name: 'icon-192.png', data: png(navy, 192) },
    { name: 'icon-512.png', data: png(navy, 512) },
    { name: 'email-icons/wordmark-mark.png', data: png(logoMarkSvg(HONEY), 96) },
  ]
}

function main(): void {
  mkdirSync(join(PUBLIC, 'email-icons'), { recursive: true })
  for (const { name, data } of buildBrandAssets()) {
    writeFileSync(join(PUBLIC, name), data)
    console.log(`  web/public/${name} (${data.length} B)`)
  }
  console.log('brand assets written')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
