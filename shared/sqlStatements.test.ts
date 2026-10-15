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

// The test helpers must split a migration where wrangler does (its D1 splitter,
// a port of SQLite's sqlite3_complete), or the tests run different statements
// than an instance does. A CREATE TRIGGER ends at the first `;`, whitespace,
// END, whitespace, `;`. A CASE inside its body changes nothing.
describe('splitStatements, where wrangler splits', () => {
  it('keeps a trigger whole when its body has a CASE right after a parenthesis', () => {
    const sql = `CREATE TRIGGER t AFTER INSERT ON x BEGIN
  UPDATE x SET a = (CASE WHEN NEW.b IS NULL THEN 1 ELSE 2 END);
END;
SELECT 1;`
    expect(splitStatements(sql)).toEqual([
      `CREATE TRIGGER t AFTER INSERT ON x BEGIN
  UPDATE x SET a = (CASE WHEN NEW.b IS NULL THEN 1 ELSE 2 END);
END;`,
      'SELECT 1;',
    ])
  })

  it('keeps a trigger whole when its body has a CASE right after a comma', () => {
    const sql = `CREATE TEMP TRIGGER t AFTER UPDATE ON x BEGIN UPDATE x SET a = 1,CASE_COL = 2, c = COALESCE(1,CASE WHEN 1 THEN 2 END); end ;
DROP TABLE y;`
    expect(splitStatements(sql)).toEqual([
      'CREATE TEMP TRIGGER t AFTER UPDATE ON x BEGIN UPDATE x SET a = 1,CASE_COL = 2, c = COALESCE(1,CASE WHEN 1 THEN 2 END); end;',
      'DROP TABLE y;',
    ])
  })

  it('splits a CASE outside a trigger at its own semicolon, and drops comments', () => {
    const sql = `-- a note
UPDATE x SET a = CASE WHEN b THEN 1 ELSE 2 END, c = 'semi; colon';
/* block */ INSERT INTO y VALUES (1);`
    expect(splitStatements(sql)).toEqual([
      "UPDATE x SET a = CASE WHEN b THEN 1 ELSE 2 END, c = 'semi; colon';",
      'INSERT INTO y VALUES (1);',
    ])
  })
})
