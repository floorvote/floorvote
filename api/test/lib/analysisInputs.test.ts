import { describe, it, expect } from 'vitest'
import { env } from 'cloudflare:test'
import { stubFetch } from '../helpers'
import { loadBillTextForAi } from '../../src/lib/analysisInputs'
import type { Env } from '../../src/types'

// The document the model reads is the one central's GET /bills/:id/text serves.
// Claim sources are pinned to it (#568), so the text loader passes on the doc
// id and text hash central sends beside the content, and tolerates an older
// central that sends neither.

const testEnv = { ...env, CENTRAL_API_URL: 'https://central.test' } as unknown as Env
const bill = { number: 'HB 1', title: 'An Act', abstract: 'About boxes' }

function centralText(body: unknown, status = 200) {
  stubFetch(url => url.includes('/text')
    ? new Response(JSON.stringify(body), { status })
    : new Response('{}', { status: 404 }))
}

describe('loadBillTextForAi', () => {
  it('returns the doc id and text hash central served with HTML', async () => {
    centralText({ type: 'html', content: '<p>Section 1.</p>', docId: '3301', textHash: 'abc123' })
    const r = await loadBillTextForAi(testEnv, 'legiscan:1', bill)
    expect(r).toMatchObject({ hasFullText: true, textDocId: '3301', textHash: 'abc123' })
    expect(r.billText).toContain('Section 1.')
    expect(r.billPdfBase64).toBeUndefined()
  })

  it('returns the doc id and text hash central served with a PDF', async () => {
    centralText({ type: 'pdf', content: btoa('%PDF'), docId: '3302', textHash: 'def456' })
    const r = await loadBillTextForAi(testEnv, 'legiscan:1', bill)
    expect(r).toMatchObject({ hasFullText: true, textDocId: '3302', textHash: 'def456', billPdfBase64: btoa('%PDF') })
  })

  it('reads a numeric doc id as the string the instance stores doc ids as', async () => {
    centralText({ type: 'html', content: '<p>x</p>', docId: 3303, textHash: 'h' })
    expect((await loadBillTextForAi(testEnv, 'legiscan:1', bill)).textDocId).toBe('3303')
  })

  it('tolerates an older central that sends neither field', async () => {
    centralText({ type: 'html', content: '<p>Section 1.</p>' })
    const r = await loadBillTextForAi(testEnv, 'legiscan:1', bill)
    expect(r).toMatchObject({ hasFullText: true, textDocId: null, textHash: null })
    expect(r.billText).toContain('Section 1.')
  })

  it.each([
    ['null', null, null],
    ['an empty string', '', ''],
    ['an object', { id: 1 }, { h: 1 }],
    ['a boolean', true, false],
    ['a fractional number', 1.5, 2],
  ])('treats a doc id and hash that are %s as absent', async (_label, docId, textHash) => {
    centralText({ type: 'html', content: '<p>x</p>', docId, textHash })
    const r = await loadBillTextForAi(testEnv, 'legiscan:1', bill)
    expect(r).toMatchObject({ hasFullText: true, textDocId: null, textHash: null })
  })

  it('keeps the doc id when central has no hash for the document', async () => {
    centralText({ type: 'html', content: '<p>x</p>', docId: '3304', textHash: null })
    expect(await loadBillTextForAi(testEnv, 'legiscan:1', bill)).toMatchObject({ textDocId: '3304', textHash: null })
  })

  it('has no doc id when central has no text, and the model reads the title and abstract', async () => {
    centralText({ error: 'no text available' }, 404)
    const r = await loadBillTextForAi(testEnv, 'legiscan:1', bill)
    expect(r).toEqual({ billText: 'An Act. About boxes', billPdfBase64: undefined, hasFullText: false, textDocId: null, textHash: null })
  })
})
