// Split a migration into statements on `;`, dropping `--` and `/* */`
// comments first and ignoring semicolons inside quotes, so prose in a comment
// can't leak out as SQL. Not handled: a CREATE TRIGGER body (BEGIN ... END)
// has semicolons of its own and would be split apart.
//
// Pure TypeScript with no Workers imports: the api and central test helpers
// both use it to build their test databases from the migrations directory.
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  const flush = () => {
    const s = current.trim()
    if (s.length > 0) statements.push(s + ';')
    current = ''
  }
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    if (quote) {
      current += c
      if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c
      current += c
    } else if (c === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i)
      i = eol === -1 ? sql.length : eol - 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 1
    } else if (c === ';') {
      flush()
    } else {
      current += c
    }
  }
  flush()
  return statements
}
