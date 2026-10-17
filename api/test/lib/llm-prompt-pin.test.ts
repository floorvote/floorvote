import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pins the prompt text the analysis call sends, byte for byte (#568).
//
// Claim sources are asked for only through the response schema's field
// descriptions. #347 measured that putting the same request in the prompt
// shifted summaries toward lists (p = 0.003) and the schema-only form did not,
// so the prompt built by buildPrompt and composeSystemInstruction must not
// change when claim sources are added. The snapshots below were captured from
// the code before claim sources existed. Do not update them to make a claim
// sources change pass: a diff here means the prompt moved.

const geminiGenerateMock = vi.hoisted(() => vi.fn())
vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return { models: { generateContent: geminiGenerateMock } }
  }),
  ServiceTier: { FLEX: 'flex', STANDARD: 'standard', PRIORITY: 'priority', UNSPECIFIED: 'unspecified' },
}))

import { processBill } from '../../src/lib/llm'
import type { Env } from '../../src/types'

const env = { GEMINI_API_KEY: 'k', TENANT_ID: 't' } as unknown as Env

const base = {
  billNumber: 'HB 1234',
  title: 'An Act Relating to Ballot Drop Boxes',
  text: 'Section 1. Each county shall provide one drop box.',
  taxonomy: [{ name: 'Voting Access' }, { name: 'Local Government', description: 'counties and towns' }],
  aiContext: 'Summarize for a team of county clerks.',
  relevanceQuestion: 'Rate how relevant this bill is to drop boxes.',
}

function sent(i = 0) {
  const call = geminiGenerateMock.mock.calls[i][0]
  const parts = call.contents[0].parts as Array<{ text?: string }>
  return { prompt: parts.map(p => p.text ?? '<inlineData>').join('\n|\n'), system: call.config.systemInstruction as string }
}

beforeEach(() => {
  geminiGenerateMock.mockReset()
  geminiGenerateMock.mockResolvedValue({ text: JSON.stringify({ affectedCitations: [], summary: 's', tags: [], relevanceScore: 5 }) })
})

describe('the analysis prompt is unchanged by claim sources', () => {
  it('sends the same HTML prompt as before, with claim sources asked for or not', async () => {
    await processBill(base, env)
    await processBill({ ...base, claimSources: true }, env)
    expect(sent(1).prompt).toBe(sent(0).prompt)
    expect(sent().prompt).toMatchInlineSnapshot(`
      "Bill number: HB 1234
      Title: An Act Relating to Ballot Drop Boxes

      Your task:
      1. List every statutory citation this bill affects, exactly as printed in the bill — the "Sections Affected" list near the top is usually the quickest place to find them. Do this before assigning tags.
      2. Write a summary of this bill following your system instructions.
      3. Assign tags from the list below. Where a tag carries a description, that description defines the test for that tag and overrides the general guidance in this step. For a tag with no description, assign it when the bill substantively addresses its topic — changes, regulates, funds, or establishes it — not for an incidental mention or shared procedure. Assigning no tags is correct only if none apply. Select only from this list:
      - Voting Access
      - Local Government: counties and towns
      4. Rate how relevant this bill is to drop boxes. Give an integer 1–10. Anchor: 1 = no genuine connection to this subject (an incidental mention or shared procedure is not a connection); 5 = partially or indirectly bears on it; 10 = squarely and substantially about it. Judge by what the bill does, not surface keywords.

      Full text:
      Section 1. Each county shall provide one drop box."
    `)
  })

  it('sends the same PDF prompt as before, with claim sources asked for or not', async () => {
    await processBill({ ...base, pdfBase64: btoa('%PDF fake') }, env)
    await processBill({ ...base, pdfBase64: btoa('%PDF fake'), claimSources: true }, env)
    expect(sent(1).prompt).toBe(sent(0).prompt)
    expect(sent().prompt).toMatchInlineSnapshot(`
      "<inlineData>
      |
      Bill number: HB 1234
      Title: An Act Relating to Ballot Drop Boxes

      Your task:
      1. List every statutory citation this bill affects, exactly as printed in the bill — the "Sections Affected" list near the top is usually the quickest place to find them. Do this before assigning tags.
      2. Write a summary of this bill following your system instructions.
      3. Assign tags from the list below. Where a tag carries a description, that description defines the test for that tag and overrides the general guidance in this step. For a tag with no description, assign it when the bill substantively addresses its topic — changes, regulates, funds, or establishes it — not for an incidental mention or shared procedure. Assigning no tags is correct only if none apply. Select only from this list:
      - Voting Access
      - Local Government: counties and towns
      4. Rate how relevant this bill is to drop boxes. Give an integer 1–10. Anchor: 1 = no genuine connection to this subject (an incidental mention or shared procedure is not a connection); 5 = partially or indirectly bears on it; 10 = squarely and substantially about it. Judge by what the bill does, not surface keywords."
    `)
  })

  it('sends the same system instruction as before, with claim sources asked for or not', async () => {
    await processBill(base, env)
    await processBill({ ...base, claimSources: true }, env)
    expect(sent(1).system).toBe(sent(0).system)
    expect(sent().system).toMatchInlineSnapshot(`
      "Summarize for a team of county clerks.

      Formatting:
      If you present multiple items as a list, format it as a Markdown unordered list: write each item on its own line beginning with a hyphen and a space ("- "). Use only "- " as the marker — never the "•" character, asterisks, numbers, HTML tags, or the literal word "bullet", and never put more than one item on a single line. If you include a lead-in sentence before the list, put it on its own line above the list. Otherwise write plain prose; you may use **bold** sparingly to flag a key term and use no other formatting."
    `)
  })
})
