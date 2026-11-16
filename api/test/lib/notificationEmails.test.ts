import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { clearDb } from '../helpers'
import { getDb } from '../../src/db/client'
import { associationConfig } from '../../src/db/schema'
import { notificationEmailsEnabled, readWeekAheadDay, digestDayForNewPeople } from '../../src/lib/notificationEmails'

const save = (key: string, value: string) => getDb(env.DB).insert(associationConfig).values({ key, value })

describe('notificationEmailsEnabled', () => {
  beforeEach(async () => { await clearDb() })

  it('is true when nothing is saved', async () => {
    expect(await notificationEmailsEnabled(getDb(env.DB))).toBe(true)
  })
  it('is false when saved as false', async () => {
    await save('notification_emails_enabled', 'false')
    expect(await notificationEmailsEnabled(getDb(env.DB))).toBe(false)
  })
  it('is true when saved as true', async () => {
    await save('notification_emails_enabled', 'true')
    expect(await notificationEmailsEnabled(getDb(env.DB))).toBe(true)
  })
  it('is true when the saved value cannot be read', async () => {
    await save('notification_emails_enabled', 'not json')
    expect(await notificationEmailsEnabled(getDb(env.DB))).toBe(true)
  })
})

describe('readWeekAheadDay', () => {
  beforeEach(async () => { await clearDb() })

  it('is Friday when nothing is saved', async () => {
    expect(await readWeekAheadDay(getDb(env.DB))).toBe(5)
  })
  it.each([['0', 0], ['3', 3], ['6', 6]])('is the saved day %s', async (saved, day) => {
    await save('week_ahead_day', saved)
    expect(await readWeekAheadDay(getDb(env.DB))).toBe(day)
  })
  it.each(['7', '-1', '2.5', '"3"', 'null', 'not json'])('is Friday when %s is saved', async (saved) => {
    await save('week_ahead_day', saved)
    expect(await readWeekAheadDay(getDb(env.DB))).toBe(5)
  })
})

describe('digestDayForNewPeople', () => {
  beforeEach(async () => { await clearDb() })

  it('is null when nothing is saved', async () => {
    expect(await digestDayForNewPeople(getDb(env.DB))).toBeNull()
  })
  it.each([['0', 0], ['5', 5], ['6', 6]])('is the saved day %s', async (saved, day) => {
    await save('digest_weekly_day_for_new_people', saved)
    expect(await digestDayForNewPeople(getDb(env.DB))).toBe(day)
  })
  it.each(['7', '-1', '2.5', '"5"', 'not json'])('is null when %s is saved', async (saved) => {
    await save('digest_weekly_day_for_new_people', saved)
    expect(await digestDayForNewPeople(getDb(env.DB))).toBeNull()
  })
})
