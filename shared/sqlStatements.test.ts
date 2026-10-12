import { describe, it, expect } from 'vitest'
import { splitStatements } from './sqlStatements'

describe('splitStatements', () => {
  it('ignores semicolons in comments and string literals', () => {
    const sql = [
      '-- a full scan; slow',
      'CREATE TABLE t (a TEXT); -- trailing; comment',
      "/* block; comment */ INSERT INTO t VALUES ('x;y', 'it''s');",
      'CREATE INDEX i ON t(a)',
    ].join('\n')
    expect(splitStatements(sql)).toEqual([
      'CREATE TABLE t (a TEXT);',
      "INSERT INTO t VALUES ('x;y', 'it''s');",
      'CREATE INDEX i ON t(a);',
    ])
  })

  it('returns nothing for a file that is only comments', () => {
    expect(splitStatements('-- nothing to run\n/* here either */\n')).toEqual([])
  })
})
