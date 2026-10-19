import { describe, it, expect } from 'vitest'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import * as schema from '../../src/db/schema'
import { billLinkedTables, coverageProblems, schemaTableNames } from './billTableCoverage'
import { TREATMENT } from './billTableTreatment'

// Link (POST /bills/:id/link) and draft delete (DELETE /bills/:id) in
// src/routes/billsApi/draftRoutes.ts each keep a hand-written list of the
// tables that point at a bill. A new bill-linked table is silently missed by
// both unless someone remembers (#240, the custom-field loss in 7432644).
// This test makes forgetting fail: add the table to TREATMENT, and decide there
// what Link and delete do with it.
describe('bill-linked table coverage for draft Link and delete', () => {
  it('finds the tables that hold a bill id, from the schema', () => {
    const linked = billLinkedTables(schema)
    expect(linked).toEqual(expect.arrayContaining(['team_events', 'comments', 'calendar_event_bills', 'bill_group_overrides', 'public_reports']))
    expect(linked).not.toContain('bills')
  })

  it('has every bill-linked table classified, and no classification for a missing table', () => {
    expect(coverageProblems(billLinkedTables(schema), TREATMENT, schemaTableNames(schema))).toEqual([])
  })

  it('fails naming a bill-linked table that is not classified', () => {
    const billWatchers = sqliteTable('bill_watchers', { id: text('id').primaryKey(), billId: text('bill_id').notNull() })
    const withNew = { ...schema, billWatchers }
    const problems = coverageProblems(billLinkedTables(withNew), TREATMENT, schemaTableNames(withNew))
    expect(problems.join('\n')).toContain('bill_watchers')
  })

  it('fails naming a classified table that no longer exists', () => {
    const stale = { ...TREATMENT, removed_table: { link: 'moved', delete: 'deleted', reason: 'x' } } as const
    const problems = coverageProblems(billLinkedTables(schema), stale, schemaTableNames(schema))
    expect(problems.join('\n')).toContain('removed_table')
  })

  it('gives every classification a reason', () => {
    for (const [table, t] of Object.entries(TREATMENT)) expect(t.reason.trim(), table).not.toBe('')
  })
})
