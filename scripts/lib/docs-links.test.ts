import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkDocsLinks } from './docs-links'

const made: string[] = []

/** A throwaway docs content directory holding the given pages. */
function site(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'docs-links-'))
  made.push(dir)
  for (const [path, body] of Object.entries(pages)) {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, body)
  }
  return dir
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true })
})

describe('checkDocsLinks', () => {
  it('reports a link to a heading the page does not have', () => {
    const dir = site({
      'index.md': '# Home\n\nSee [setup](/setup#step-two).\n',
      'setup.md': '# Setup\n\n## Step one\n',
    })
    const { problems } = checkDocsLinks(dir)
    expect(problems).toEqual([
      { page: 'index.md', link: '/setup#step-two', reason: 'no heading with that anchor on /setup' },
    ])
  })

  it('reports a link to a page that does not exist', () => {
    const dir = site({ 'index.md': '# Home\n\n[gone](/missing)\n' })
    expect(checkDocsLinks(dir).problems).toEqual([
      { page: 'index.md', link: '/missing', reason: 'no page at /missing' },
    ])
  })

  it('reports an in-page anchor the page does not have', () => {
    const dir = site({ 'index.md': '# Home\n\n[up](#nowhere)\n' })
    expect(checkDocsLinks(dir).problems).toHaveLength(1)
  })

  it('accepts anchors built the way VitePress builds them', () => {
    const dir = site({
      'self/index.md': '# Self-hosting\n\n## Step 12: Seed the active session(s)\n\n## Cost {#custom-id}\n\n## `Code` and **bold**\n',
      'self/tenants.md': [
        '# Tenants',
        '[a](/self/#step-12-seed-the-active-session-s)',
        '[b](./#custom-id)',
        '[c](/self/#code-and-bold)',
        '[d](#tenants)',
        '[e](./)',
        '[f](/self/tenants)',
        '[g](tenants.md)',
        '[h](/self/tenants.html#tenants)',
      ].join('\n\n'),
    })
    const result = checkDocsLinks(dir)
    expect(result.checked).toBe(8)
    expect(result.problems).toEqual([])
  })

  it('numbers a repeated heading the way VitePress does', () => {
    const dir = site({
      'a.md': '# A\n\n## Notes\n\n## Notes\n\n[first](#notes) [second](#notes-1) [third](#notes-2)\n',
    })
    expect(checkDocsLinks(dir).problems.map(p => p.link)).toEqual(['#notes-2'])
  })

  it('ignores links inside code, external links, and mail links', () => {
    const dir = site({
      'a.md': [
        '# A',
        '`[x](/missing)`',
        '```md\n[y](/missing)\n```',
        '[ext](https://example.org/missing#nope)',
        '[mail](mailto:someone@example.org)',
        '[real](#a)',
      ].join('\n\n'),
    })
    const result = checkDocsLinks(dir)
    expect(result.checked).toBe(1)
    expect(result.problems).toEqual([])
  })

  it('checks raw anchors, which skip the router and carry the /docs/ base', () => {
    const dir = site({
      'a.md': '# A\n\n<a href="/docs/internal/map.html" target="_self">map</a> <a href="/docs/internal/gone.html">gone</a>\n',
      'public/internal/map.html': '<html></html>',
    })
    expect(checkDocsLinks(dir).problems.map(p => p.link)).toEqual(['/docs/internal/gone.html'])
  })

  it('counts what it checked', () => {
    const dir = site({ 'a.md': '# A\n\n[self](#a) [site](/a)\n' })
    expect(checkDocsLinks(dir).checked).toBe(2)
  })
})

describe('the published docs site', () => {
  it('has no broken internal link or anchor', () => {
    const { checked, problems } = checkDocsLinks(resolve(__dirname, '../../docs/content'))
    expect(checked).toBeGreaterThan(30)
    expect(problems).toEqual([])
  })
})
