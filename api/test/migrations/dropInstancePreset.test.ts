import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations } from '../helpers'
import migrationSql61 from '../../migrations/0061_drop_instance_preset.sql?raw'

// applyMigrations() applies every migration up to and including 0061 once, during
// beforeEach. The harness (applyD1Migrations) tracks applied migration names in a
// d1_migrations table and skips repeats, so calling applyMigrations() a second
// time after seeding a legacy row would be a no-op — 0061 would never re-run
// against it. To exercise the migration against pre-existing data, this test
// executes 0061's own SQL directly, using the same comment-stripping split
// applyMigrations() itself uses for hand-written migrations elsewhere in this
// suite (see helpers.ts: 0049, 0054, 0057).
function statementsOf(sql: string): string[] {
  return sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0)
}

describe('0061_drop_instance_preset', () => {
  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
  })

  it('removes instance_preset but leaves functional AI config byte-identical', async () => {
    const aiContext = JSON.stringify('Analyze for county clerks.\n\nSecond paragraph.')
    const relevanceQuestion = JSON.stringify('Does this affect county clerks?')
    const tagTaxonomy = JSON.stringify(['Elections', 'Ballot Access'])
    const keywords = JSON.stringify(['election', 'ballot'])
    await env.DB.prepare(
      `INSERT OR REPLACE INTO association_config (key, value) VALUES
        ('instance_preset', ?), ('ai_context', ?), ('relevance_question', ?), ('tag_taxonomy', ?), ('keywords', ?)`,
    ).bind(JSON.stringify('election_officials'), aiContext, relevanceQuestion, tagTaxonomy, keywords).run()

    for (const statement of statementsOf(migrationSql61)) {
      await env.DB.prepare(statement).run()
    }

    const preset = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'instance_preset'`,
    ).first()
    expect(preset).toBeNull()

    const ctx = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'ai_context'`,
    ).first<{ value: string }>()
    expect(ctx?.value).toBe(aiContext)

    const question = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'relevance_question'`,
    ).first<{ value: string }>()
    expect(question?.value).toBe(relevanceQuestion)

    const taxonomy = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'tag_taxonomy'`,
    ).first<{ value: string }>()
    expect(taxonomy?.value).toBe(tagTaxonomy)

    const kw = await env.DB.prepare(
      `SELECT value FROM association_config WHERE key = 'keywords'`,
    ).first<{ value: string }>()
    expect(kw?.value).toBe(keywords)
  })
})
