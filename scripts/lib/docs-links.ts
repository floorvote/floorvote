// Internal-link check for the published docs site (docs/content).
//
// VitePress already fails the build on a link to a page that doesn't exist. It
// says nothing about the part after the `#`, so a heading that is renamed or
// moved leaves every link to it quietly pointing at the top of the page. This
// reads the markdown, works out each page's heading anchors the way VitePress
// does, and reports links whose page or anchor is gone. The drift test beside
// this file runs it over the real site, so CI catches the broken anchor.
//
// Checked: markdown links and `<a href>` anchors in page bodies. Not checked:
// external links, links in `config.ts`, and anchors inside the static pages in
// `public/` (the check only confirms those files exist).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

export interface DocsLinkProblem {
  /** The page the link is on, relative to the docs content directory. */
  page: string
  /** The link as written. */
  link: string
  reason: string
}

/**
 * VitePress's heading slug (markdown-it-anchor with @mdit-vue/shared's
 * slugify): accents stripped, punctuation and spaces collapsed to single
 * hyphens, a leading digit prefixed with an underscore, lowercase.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

/** Blank out HTML comments and code fences, which hold no real links or headings. */
function withoutFences(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
}

function withoutCode(md: string): string {
  return withoutFences(md).replace(/`[^`\n]*`/g, blank)
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ')
}

/** Every anchor id a page offers: its headings (numbered if repeated) and any raw `id="..."`. */
export function pageAnchors(md: string): Set<string> {
  const anchors = new Set<string>()
  const body = withoutFences(md)
  for (const m of body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) {
    const custom = m[1].match(/\s*\{#([^}\s]+)\}\s*$/)
    if (custom) {
      anchors.add(custom[1])
      continue
    }
    const slug = slugify(m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/`/g, ''))
    let id = slug
    for (let n = 1; anchors.has(id); n++) id = `${slug}-${n}`
    anchors.add(id)
  }
  for (const m of body.matchAll(/\sid="([^"]+)"/g)) anchors.add(m[1])
  return anchors
}

interface Link {
  href: string
  /** A raw `<a>` skips the router, so it spells out the site's `/docs/` base. */
  raw: boolean
}

function linksIn(md: string): Link[] {
  const body = withoutCode(md)
  const links: Link[] = []
  for (const m of body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) links.push({ href: m[1], raw: false })
  for (const m of body.matchAll(/<a\s[^>]*?href="([^"]+)"/g)) links.push({ href: m[1], raw: true })
  return links
}

function markdownFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (name === 'public' && rel === '') continue
    const path = posix.join(rel, name)
    if (statSync(join(dir, path)).isDirectory()) out.push(...markdownFiles(dir, path))
    else if (name.endsWith('.md')) out.push(path)
  }
  return out
}

/** The URL path a markdown file is served at: `a/b.md` is `/a/b`, `a/index.md` is `/a/`. */
function routeOf(file: string): string {
  return '/' + file.replace(/\.md$/, '').replace(/(^|\/)index$/, '$1')
}

export function checkDocsLinks(contentDir: string): { checked: number; problems: DocsLinkProblem[] } {
  const files = markdownFiles(contentDir)
  const sources = new Map(files.map(f => [f, readFileSync(join(contentDir, f), 'utf8')]))
  const anchorCache = new Map<string, Set<string>>()
  const anchorsOf = (file: string) => {
    if (!anchorCache.has(file)) anchorCache.set(file, pageAnchors(sources.get(file)!))
    return anchorCache.get(file)!
  }

  let checked = 0
  const problems: DocsLinkProblem[] = []

  for (const page of files) {
    for (const { href, raw } of linksIn(sources.get(page)!)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue
      checked++
      const hashAt = href.indexOf('#')
      const path = hashAt === -1 ? href : href.slice(0, hashAt)
      const hash = hashAt === -1 ? '' : decodeURIComponent(href.slice(hashAt + 1))
      const fail = (reason: string) => problems.push({ page, link: href, reason })

      let target: string
      if (path === '') target = '/' + page
      else if (path.startsWith('/')) target = raw ? path.replace(/^\/docs(?=\/|$)/, '') || '/' : path
      else target = posix.join('/', posix.dirname(page), path) + (path.endsWith('/') ? '/' : '')

      // A static file under public/, such as the interactive diagrams.
      if (/\.[a-z0-9]+$/i.test(target) && !target.endsWith('.md') && !target.endsWith('.html')) {
        if (!existsSync(join(contentDir, 'public', target))) fail(`no file at ${target}`)
        continue
      }
      if (target.endsWith('.html') && existsSync(join(contentDir, 'public', target))) continue

      const route = target.replace(/\.(md|html)$/, '')
      const key = route.replace(/^\//, '')
      const found = (route.endsWith('/') ? [] : [`${key}.md`]).concat(posix.join(key, 'index.md')).find(f => sources.has(f))
      if (!found) {
        fail(`no page at ${route}`)
        continue
      }
      if (hash && !anchorsOf(found).has(hash)) fail(`no heading with that anchor on ${routeOf(found)}`)
    }
  }
  return { checked, problems }
}
