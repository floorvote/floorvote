import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Repo root from this test file (web/src/lib/brandEmailAssets.test.ts).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// The email masthead wordmark is a generated PNG (scripts/gen-brand-assets.ts,
// rasterizing the outlined .github/assets/floorvote-wordmark.svg). This guards
// against it going missing or drifting in size. We check existence + PNG magic +
// dimensions rather than byte-equality on purpose: Resvg rasterization is not
// guaranteed byte-identical across platforms, so a byte compare would flake in
// CI, while the dimensions (render width × the SVG's aspect) are deterministic.
describe('email masthead wordmark asset', () => {
  const p = join(ROOT, 'web/public/email-icons/wordmark.png')

  it('is generated on disk (run: npm run gen:brand-assets)', () => {
    expect(existsSync(p), 'wordmark.png missing — run: npm run gen:brand-assets').toBe(true)
  })

  it('is a valid PNG at the expected retina dimensions', () => {
    const buf = readFileSync(p)
    // PNG signature: bytes 1..4 spell "PNG".
    expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG')
    // IHDR width/height: big-endian uint32 at byte offsets 16 and 20. 480×76 =
    // WORDMARK_WIDTH (480) at the wordmark SVG's ~6.31:1 aspect. If the SVG or the
    // width changes, regenerate and update these — that's the drift signal.
    expect({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }).toEqual({ w: 480, h: 76 })
  })
})
