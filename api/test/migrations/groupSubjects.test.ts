import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { resetDb, applyMigrations, seedBill, seedUser } from '../helpers'
import { getDb } from '../../src/db/client'
import { syncBillSubjects } from '../../src/lib/billSubjects'
import { groupByHand, splitFromGroup } from '../../src/lib/companionGroups'

// 0126 keeps, for each companion group, the subjects two or more of its bills hold, with how many bills hold each
// (#1030). The facet that counts subjects counts a group once however many of its bills hold the subject, which it
// reads as the bills less the groups: a subject held by one bill of a group is no correction, so only the shared
// pairs are kept, and a tenant whose groups share nothing has no row at all. The table is kept by triggers, in the
// statement that changes a bill's subject rows, its group key, or the bill itself, so no writer can forget it.

type Pair = { group_key: string; state: string; subject_name: string; n: number }

/** What the table holds, as the table's own rows. */
async function table(): Promise<Pair[]> {
  const { results } = await env.DB.prepare('SELECT group_key, state, subject_name, n FROM group_subjects ORDER BY group_key, state, subject_name').all<Pair>()
  return results
}

/** What it must hold, recomputed from the bills and their subject rows: the pairs two or more bills of a group share. */
async function expected(): Promise<Pair[]> {
  const { results } = await env.DB.prepare(`SELECT b.group_key AS group_key, s.state AS state, s.subject_name AS subject_name, COUNT(*) AS n
    FROM bills b JOIN bill_subjects s ON s.bill_id = b.id WHERE b.group_key IS NOT NULL
    GROUP BY b.group_key, s.state, s.subject_name HAVING COUNT(*) >= 2 ORDER BY b.group_key, s.state, s.subject_name`).all<Pair>()
  return results
}

const bill = (id: string, groupKey: string | null) =>
  env.DB.prepare(`INSERT INTO bills (id, bill_number, title, state, status, session, group_key) VALUES (?, ?, 't', 'NJ', 'Introduced', 's', ?)`).bind(id, id.toUpperCase(), groupKey)
const subject = (id: string, state: string, name: string) =>
  env.DB.prepare('INSERT INTO bill_subjects (bill_id, subject_name, state) VALUES (?, ?, ?)').bind(id, name, state)

describe('migration 0126: the subjects a group shares', () => {
  describe('over an instance that already has groups', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations({ before: '0126_group_subjects' })
      await env.DB.batch([
        bill('a1', 'g1'), bill('a2', 'g1'), bill('a3', 'g1'),
        bill('b1', 'g2'), bill('b2', 'g2'),
        bill('c1', 'g3'),
        bill('d1', null), bill('d2', null),
        bill('e1', 'g4'), bill('e2', 'g4'),
        // g1: S held by three bills, T by two, U by one. The same name under another state is another subject.
        subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'S'), subject('a3', 'NJ', 'S'),
        subject('a1', 'NJ', 'T'), subject('a2', 'NJ', 'T'),
        subject('a3', 'NJ', 'U'),
        // g2: one bill holds the name under NJ, the other under TX, so nothing is shared.
        subject('b1', 'NJ', 'S'), subject('b2', 'TX', 'S'),
        // A group of one bill shares nothing, and bills in no group are in no group's table.
        subject('c1', 'NJ', 'S'),
        subject('d1', 'NJ', 'S'), subject('d2', 'NJ', 'S'),
        // g4: a bill with no subjects.
        subject('e1', 'NJ', 'S'),
      ])
      await applyMigrations()
    })

    it('creates the table keyed by the group and the subject, holding the number of bills', async () => {
      const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info('group_subjects') ORDER BY cid").all<{ name: string }>()
      expect(results.map(r => r.name)).toEqual(['group_key', 'state', 'subject_name', 'n'])
      const pk = await env.DB.prepare("SELECT name FROM pragma_table_info('group_subjects') WHERE pk > 0 ORDER BY pk").all<{ name: string }>()
      expect(pk.results.map(r => r.name)).toEqual(['group_key', 'state', 'subject_name'])
    })

    it('fills in the pairs the groups already share, each with its count, and nothing else', async () => {
      expect(await table()).toEqual([
        { group_key: 'g1', state: 'NJ', subject_name: 'S', n: 3 },
        { group_key: 'g1', state: 'NJ', subject_name: 'T', n: 2 },
      ])
      expect(await table()).toEqual(await expected())
    })
  })

  describe('on a database with no groups that share a subject', () => {
    it('is empty', async () => {
      await resetDb()
      await applyMigrations()
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'T')])
      expect(await table()).toEqual([])
    })
  })

  describe('kept by its triggers', () => {
    beforeEach(async () => {
      await resetDb()
      await applyMigrations()
    })

    it('adds a pair when a second bill of a group takes a subject, and counts a third', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), bill('a3', 'g1'), subject('a1', 'NJ', 'S')])
      expect(await table()).toEqual([])
      await env.DB.batch([subject('a2', 'NJ', 'S')])
      expect(await table()).toEqual([{ group_key: 'g1', state: 'NJ', subject_name: 'S', n: 2 }])
      await env.DB.batch([subject('a3', 'NJ', 'S')])
      expect(await table()).toEqual([{ group_key: 'g1', state: 'NJ', subject_name: 'S', n: 3 }])
    })

    it('drops the pair when a subject row goes and fewer than two bills hold it', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), bill('a3', 'g1'), subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'S'), subject('a3', 'NJ', 'S')])
      await env.DB.prepare("DELETE FROM bill_subjects WHERE bill_id = 'a3'").run()
      expect(await table()).toEqual([{ group_key: 'g1', state: 'NJ', subject_name: 'S', n: 2 }])
      await env.DB.prepare("DELETE FROM bill_subjects WHERE bill_id = 'a2'").run()
      expect(await table()).toEqual([])
    })

    it('keeps a pair per state, since the state is part of a subject', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), subject('a1', 'NJ', 'S'), subject('a2', 'TX', 'S')])
      expect(await table()).toEqual([])
      await env.DB.batch([subject('a1', 'TX', 'S')])
      expect(await table()).toEqual([{ group_key: 'g1', state: 'TX', subject_name: 'S', n: 2 }])
    })

    it('holds nothing for a bill in no group', async () => {
      await env.DB.batch([bill('d1', null), bill('d2', null), subject('d1', 'NJ', 'S'), subject('d2', 'NJ', 'S')])
      expect(await table()).toEqual([])
    })

    it('follows a bill that joins a group, leaves it, or moves to another', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), bill('x1', null), bill('y1', 'g2'),
        subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'T'), subject('x1', 'NJ', 'S'), subject('x1', 'NJ', 'T'), subject('y1', 'NJ', 'S')])
      expect(await table()).toEqual([])
      // x1 joins g1: it shares S with a1 and T with a2.
      await env.DB.prepare("UPDATE bills SET group_key = 'g1' WHERE id = 'x1'").run()
      expect(await table()).toEqual([
        { group_key: 'g1', state: 'NJ', subject_name: 'S', n: 2 },
        { group_key: 'g1', state: 'NJ', subject_name: 'T', n: 2 },
      ])
      // It moves to g2, where it shares only S with y1.
      await env.DB.prepare("UPDATE bills SET group_key = 'g2' WHERE id = 'x1'").run()
      expect(await table()).toEqual([{ group_key: 'g2', state: 'NJ', subject_name: 'S', n: 2 }])
      // It leaves every group.
      await env.DB.prepare("UPDATE bills SET group_key = NULL WHERE id = 'x1'").run()
      expect(await table()).toEqual([])
    })

    it('follows a whole group that is re-keyed, and two groups that merge', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), bill('b1', 'g2'), bill('b2', 'g2'),
        subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'S'), subject('b1', 'NJ', 'S'), subject('b2', 'NJ', 'T')])
      expect(await table()).toEqual([{ group_key: 'g1', state: 'NJ', subject_name: 'S', n: 2 }])
      await env.DB.prepare("UPDATE bills SET group_key = 'g9' WHERE group_key = 'g1'").run()
      expect(await table()).toEqual([{ group_key: 'g9', state: 'NJ', subject_name: 'S', n: 2 }])
      await env.DB.prepare("UPDATE bills SET group_key = 'g9' WHERE group_key = 'g2'").run()
      expect(await table()).toEqual([{ group_key: 'g9', state: 'NJ', subject_name: 'S', n: 3 }])
      expect(await table()).toEqual(await expected())
    })

    it('follows a bill that is deleted, with its subject rows cascading away', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), bill('a3', 'g1'),
        subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'S'), subject('a3', 'NJ', 'S'), subject('a1', 'NJ', 'T'), subject('a2', 'NJ', 'T')])
      await env.DB.prepare("DELETE FROM bills WHERE id = 'a3'").run()
      expect(await table()).toEqual([
        { group_key: 'g1', state: 'NJ', subject_name: 'S', n: 2 },
        { group_key: 'g1', state: 'NJ', subject_name: 'T', n: 2 },
      ])
      await env.DB.prepare("DELETE FROM bills WHERE id = 'a1'").run()
      expect(await table()).toEqual([])
    })

    it('stays right when every table is emptied, as the test helpers and a demo reset do', async () => {
      await env.DB.batch([bill('a1', 'g1'), bill('a2', 'g1'), subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'S')])
      await env.DB.prepare('DELETE FROM bill_subjects').run()
      expect(await table()).toEqual([])
      await env.DB.batch([subject('a1', 'NJ', 'S'), subject('a2', 'NJ', 'S')])
      await env.DB.prepare('DELETE FROM bills').run()
      expect(await table()).toEqual([])
    })

    it('agrees with the bills after a long run of random writes', async () => {
      // A fixed sequence, so a failure replays: 12 bills in 4 groups and some alone, 5 subjects over 2 states.
      let seed = 1030
      const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
      const ids = Array.from({ length: 12 }, (_, i) => `r${i}`)
      const groups = ['g1', 'g2', 'g3', 'g4', null, null]
      await env.DB.batch(ids.map(id => bill(id, groups[rand(groups.length)])))
      for (let step = 0; step < 300; step++) {
        const id = ids[rand(ids.length)]
        const op = rand(6)
        if (op <= 2) {
          await env.DB.prepare('INSERT OR IGNORE INTO bill_subjects (bill_id, subject_name, state) VALUES (?, ?, ?)').bind(id, `S${rand(5)}`, rand(2) ? 'NJ' : 'TX').run()
        } else if (op === 3) {
          await env.DB.prepare('DELETE FROM bill_subjects WHERE bill_id = ? AND subject_name = ?').bind(id, `S${rand(5)}`).run()
        } else if (op === 4) {
          await env.DB.prepare('UPDATE bills SET group_key = ? WHERE id = ?').bind(groups[rand(groups.length)], id).run()
        } else {
          // A resync: the bill's rows replaced in one batch, as the sync does.
          const names = [...new Set(Array.from({ length: rand(4) }, () => `S${rand(5)}`))]
          await env.DB.batch([
            env.DB.prepare('DELETE FROM bill_subjects WHERE bill_id = ?').bind(id),
            ...names.map(n => subject(id, rand(2) ? 'NJ' : 'TX', n)),
          ])
        }
        if (step % 25 === 0) expect(await table(), `after step ${step}`).toEqual(await expected())
      }
      expect(await table()).toEqual(await expected())
    })
  })
})

// The writers that really change what the table summarizes: the sync that replaces a bill's subject rows, and the
// grouping a person does by hand, which moves bills into, out of, and between groups.
describe('the group subjects after the writers that change them (#1030)', () => {
  let admin: string
  const db = () => getDb(env.DB)

  beforeEach(async () => {
    await resetDb()
    await applyMigrations()
    admin = await seedUser({ role: 'admin' })
    await seedBill({ id: 'a1', billNumber: 'H1', state: 'NJ', externalId: 'legiscan:1' })
    await seedBill({ id: 'a2', billNumber: 'S1', state: 'NJ', externalId: 'legiscan:2' })
    await seedBill({ id: 'a3', billNumber: 'H3', state: 'NJ', externalId: 'legiscan:3' })
  })

  it('follows a subject resync of a grouped bill: the rows replaced, some kept, some new, some gone', async () => {
    await groupByHand(db(), 'a1', 'a2', admin)
    await syncBillSubjects(db(), 'a1', 'NJ', ['Water', 'Roads', 'Parks'])
    await syncBillSubjects(db(), 'a2', 'NJ', ['Roads', 'Parks', 'Schools'])
    const key = (await env.DB.prepare("SELECT group_key AS k FROM bills WHERE id = 'a1'").first<{ k: string }>())!.k
    expect(await table()).toEqual([
      { group_key: key, state: 'NJ', subject_name: 'Parks', n: 2 },
      { group_key: key, state: 'NJ', subject_name: 'Roads', n: 2 },
    ])
    // A resync with a different list: Parks gone, Water now shared.
    await syncBillSubjects(db(), 'a2', 'NJ', ['Roads', 'Water'])
    expect(await table()).toEqual([
      { group_key: key, state: 'NJ', subject_name: 'Roads', n: 2 },
      { group_key: key, state: 'NJ', subject_name: 'Water', n: 2 },
    ])
    // A resync with none.
    await syncBillSubjects(db(), 'a1', 'NJ', [])
    expect(await table()).toEqual([])
    expect(await table()).toEqual(await expected())
  })

  it('follows a bill grouped by hand with others, and split from them again', async () => {
    await syncBillSubjects(db(), 'a1', 'NJ', ['Water', 'Roads'])
    await syncBillSubjects(db(), 'a2', 'NJ', ['Water'])
    await syncBillSubjects(db(), 'a3', 'NJ', ['Water', 'Roads'])
    expect(await table()).toEqual([])
    await groupByHand(db(), 'a1', 'a2', admin)
    expect((await table()).map(r => [r.subject_name, r.n])).toEqual([['Water', 2]])
    await groupByHand(db(), 'a3', 'a1', admin)
    expect((await table()).map(r => [r.subject_name, r.n])).toEqual([['Roads', 2], ['Water', 3]])
    expect(await table()).toEqual(await expected())
    // Splitting a3 off takes its rows out of the group's counts.
    expect(await splitFromGroup(db(), 'a3', admin)).toBe(true)
    expect((await table()).map(r => [r.subject_name, r.n])).toEqual([['Water', 2]])
    expect(await table()).toEqual(await expected())
  })

  it('follows a grouped bill that is deleted', async () => {
    await groupByHand(db(), 'a1', 'a2', admin)
    await syncBillSubjects(db(), 'a1', 'NJ', ['Water'])
    await syncBillSubjects(db(), 'a2', 'NJ', ['Water'])
    expect(await table()).toHaveLength(1)
    await env.DB.prepare("DELETE FROM bills WHERE id = 'a2'").run()
    expect(await table()).toEqual([])
  })
})
