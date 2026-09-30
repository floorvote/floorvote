import { describe, it, expect } from 'vitest'
import youthRaw from '../fixtures/dccouncil/committee-youth-affairs.html?raw'
import cowRaw from '../fixtures/dccouncil/committee-of-the-whole.html?raw'
import dirRaw from '../fixtures/dccouncil/council-directory-1.html?raw'
import sitemapRaw from '../fixtures/dccouncil/committees-sitemap.xml?raw'
import indexRaw from '../fixtures/dccouncil/committees-index.html?raw'
import { parseCommitteeIndex, parseCommitteePage, parseDirectoryPage, parseSitemap } from '../../src/lib/dccouncil-directory'

describe('dccouncil.gov parsers', () => {
  it('reads a committee page: chair, members, key staff, agencies', () => {
    const c = parseCommitteePage(youthRaw, 'https://dccouncil.gov/committees/committee-on-youth-affairs/')!
    expect(c.name).toBe('Committee on Youth Affairs')
    expect(c.slug).toBe('committee-on-youth-affairs')
    expect(c.chair).toEqual({ name: 'Ward 5 Councilmember Zachary Parker', url: 'https://dccouncil.gov/council/ward-5-councilmember-zachary-parker/' })
    expect(c.members.map(m => m.name)).toEqual(['Ward 2 Councilmember Brooke Pinto', 'At-Large Councilmember Robert C. White, Jr.'])
    expect(c.staff).toEqual([
      { name: 'Thomas Franco', title: 'Committee Director', email: 'tfranco@dccouncil.gov', phone: '(202) 727-9277', url: 'https://dccouncil.gov/council/thomas-franco/' },
      { name: 'Allison Bailey', title: 'Legislative Assistant', email: 'abailey@dccouncil.gov', phone: '(202) 727-7774', url: 'https://dccouncil.gov/council/allison-bailey/' },
    ])
    expect(c.agencies).toContain('Department of Youth Rehabilitation Services')
    expect(c.agencies).toHaveLength(10)
  })

  it('reads the Committee of the Whole', () => {
    const c = parseCommitteePage(cowRaw, 'https://dccouncil.gov/committees/committee-of-the-whole/')!
    expect(c.name).toBe('Committee of the Whole')
    expect(c.chair?.name).toMatch(/Mendelson/)
    expect(c.members.length).toBeGreaterThanOrEqual(10)
    expect(c.staff.length).toBeGreaterThan(0)
  })

  it('returns null for a page with no roster', () => {
    expect(parseCommitteePage('<html><body><h1>Nope</h1></body></html>', 'https://dccouncil.gov/committees/x/')).toBeNull()
  })

  it('reads a directory page and its page count', () => {
    const { entries, lastPage } = parseDirectoryPage(dirRaw)
    expect(lastPage).toBeGreaterThanOrEqual(5)
    expect(entries.length).toBeGreaterThanOrEqual(15)
    expect(entries[0]).toMatchObject({ kind: 'staff', name: 'LaBrada, Eloy "Elle"', title: 'Deputy Committee Director', office: 'councilmember Pinto', email: 'erodriguezlabrada@dccouncil.gov' })
    expect(entries.every(e => !/<|byline/.test(`${e.name}${e.title ?? ''}${e.office ?? ''}`))).toBe(true)
  })

  it('lists committee URLs from the sitemap', () => {
    const urls = parseSitemap(sitemapRaw)
    expect(urls).toContain('https://dccouncil.gov/committees/committee-on-youth-affairs/')
    expect(urls.length).toBeGreaterThanOrEqual(11)
  })

  it('lists the current committees from the index, without the defunct ones', () => {
    const urls = parseCommitteeIndex(indexRaw)
    expect(urls).toHaveLength(11)
    expect(urls).toContain('https://dccouncil.gov/committees/committee-on-youth-affairs/')
    expect(urls.some(u => /covid|redistricting/.test(u))).toBe(false)
  })

  it('keeps only plain emails and Council profile links', () => {
    const page = youthRaw
      .replace('mailto:tfranco@dccouncil.gov', 'mailto:tfranco@dccouncil.gov?cc=someone@example.com')
      .replace('https://dccouncil.gov/council/ward-5-councilmember-zachary-parker/', 'data:text/html,hi')
    const c = parseCommitteePage(page, 'https://dccouncil.gov/committees/committee-on-youth-affairs/')!
    expect(c.staff[0].email).toBeNull()
    expect(c.chair).toEqual({ name: 'Ward 5 Councilmember Zachary Parker', url: null })
  })
})

