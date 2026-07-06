import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { extractMentions, stripHtml, mentionEmailsEnabled } from '../../src/lib/mentions'
import { resetDb, applyMigrations } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'

describe('extractMentions', () => {
  it('extracts user mentions', () => {
    const html = '<p>Hey <span data-type="mention" data-id="user:abc123" data-label="Jane Smith">@Jane Smith</span> check this</p>'
    const mentions = extractMentions(html)
    expect(mentions).toEqual([{ type: 'user', id: 'abc123', label: 'Jane Smith' }])
  })

  it('extracts role mentions', () => {
    const html = '<p>Attention <span data-type="mention" data-id="role:xyz789" data-label="Elections Committee">@Elections Committee</span></p>'
    const mentions = extractMentions(html)
    expect(mentions).toEqual([{ type: 'role', id: 'xyz789', label: 'Elections Committee' }])
  })

  it('extracts multiple mentions', () => {
    const html = '<p><span data-type="mention" data-id="user:a1" data-label="Alice">@Alice</span> and <span data-type="mention" data-id="user:b2" data-label="Bob">@Bob</span></p>'
    const mentions = extractMentions(html)
    expect(mentions).toHaveLength(2)
    expect(mentions[0]).toEqual({ type: 'user', id: 'a1', label: 'Alice' })
    expect(mentions[1]).toEqual({ type: 'user', id: 'b2', label: 'Bob' })
  })

  it('handles mixed user and role mentions', () => {
    const html = '<p><span data-type="mention" data-id="user:u1" data-label="Alice">@Alice</span> and <span data-type="mention" data-id="role:r1" data-label="Finance">@Finance</span></p>'
    const mentions = extractMentions(html)
    expect(mentions).toHaveLength(2)
    expect(mentions[0].type).toBe('user')
    expect(mentions[1].type).toBe('role')
  })

  it('returns empty array for plain text', () => {
    const html = '<p>No mentions here</p>'
    expect(extractMentions(html)).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(extractMentions('')).toEqual([])
  })

  it('handles attributes in different order', () => {
    const html = '<p><span data-id="user:abc" data-label="Jane" data-type="mention">@Jane</span></p>'
    const mentions = extractMentions(html)
    expect(mentions).toEqual([{ type: 'user', id: 'abc', label: 'Jane' }])
  })

  it('deduplicates repeated mentions of the same user', () => {
    const html = '<p><span data-type="mention" data-id="user:abc" data-label="Jane">@Jane</span> and again <span data-type="mention" data-id="user:abc" data-label="Jane">@Jane</span></p>'
    expect(extractMentions(html)).toHaveLength(1)
  })

  it('extracts an everyone mention', () => {
    const html = '<p>Heads up <span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>'
    const mentions = extractMentions(html)
    expect(mentions).toEqual([{ type: 'everyone', id: 'all', label: 'everyone' }])
  })

  it('handles everyone alongside user and role mentions', () => {
    const html = '<p><span data-type="mention" data-id="user:u1" data-label="Alice">@Alice</span> <span data-type="mention" data-id="role:r1" data-label="Finance">@Finance</span> <span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>'
    const mentions = extractMentions(html)
    expect(mentions).toHaveLength(3)
    expect(mentions.map(m => m.type)).toEqual(['user', 'role', 'everyone'])
  })

  it('deduplicates repeated everyone mentions', () => {
    const html = '<p><span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span> <span data-type="mention" data-id="everyone:all" data-label="everyone">@everyone</span></p>'
    expect(extractMentions(html)).toHaveLength(1)
  })
})

describe('stripHtml', () => {
  it('strips HTML tags', () => {
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })

  it('trims whitespace', () => {
    expect(stripHtml('  <p>  text  </p>  ')).toBe('text')
  })

  it('handles empty string', () => {
    expect(stripHtml('')).toBe('')
  })
})

describe('mentionEmailsEnabled', () => {
  beforeEach(async () => { await resetDb(); await applyMigrations() })

  it('defaults to true when the flag is unset', async () => {
    expect(await mentionEmailsEnabled(getDb(env.DB))).toBe(true)
  })
  it('is false only when explicitly set to false', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'mention_emails_enabled', value: JSON.stringify(false) })
    expect(await mentionEmailsEnabled(db)).toBe(false)
  })
  it('is true when explicitly set to true', async () => {
    const db = getDb(env.DB)
    await db.insert(associationConfig).values({ key: 'mention_emails_enabled', value: JSON.stringify(true) })
    expect(await mentionEmailsEnabled(db)).toBe(true)
  })
})
