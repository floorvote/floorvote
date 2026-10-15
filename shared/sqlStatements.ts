// Split a migration into statements where wrangler does, dropping `--` and
// `/* */` comments and ignoring semicolons inside quotes, so prose in a comment
// can't leak out as SQL. This is wrangler's D1 splitter (wrangler-dist/cli.js,
// `findCompleteStatementEnd`, in 4.149), a port of SQLite's sqlite3_complete:
// a `;` ends a statement, except inside a CREATE [TEMP] TRIGGER, which ends at
// the first `;`, whitespace, END (any case), whitespace, `;`. Nothing else, a
// CASE included, is special.
//
// Pure TypeScript with no Workers imports: the api and central test helpers
// both use it to build their test databases from the migrations directory.
type SplitToken = 'semi' | 'ws' | 'other' | 'explain' | 'create' | 'temp' | 'trigger' | 'end'
type SplitState = 'invalid' | 'start' | 'normal' | 'explain' | 'create' | 'trigger' | 'semi' | 'end'
const SPLIT_TOKENS: SplitToken[] = ['semi', 'ws', 'other', 'explain', 'create', 'temp', 'trigger', 'end']
// The next state for each token, in SPLIT_TOKENS' order: wrangler's transition table.
const SPLIT_NEXT: Record<SplitState, SplitState[]> = {
  invalid: ['start', 'invalid', 'normal', 'explain', 'create', 'normal', 'normal', 'normal'],
  start: ['start', 'start', 'normal', 'explain', 'create', 'normal', 'normal', 'normal'],
  normal: ['start', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal'],
  explain: ['start', 'explain', 'explain', 'normal', 'create', 'normal', 'normal', 'normal'],
  create: ['start', 'create', 'normal', 'normal', 'normal', 'create', 'trigger', 'normal'],
  trigger: ['semi', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger'],
  semi: ['semi', 'semi', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger', 'end'],
  end: ['start', 'end', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger', 'trigger'],
}
const KEYWORD_TOKENS: Record<string, SplitToken> = {
  explain: 'explain', create: 'create', temp: 'temp', temporary: 'temp', trigger: 'trigger', end: 'end',
}
const NAME_CHAR = /[A-Za-z0-9_$\u0080-￿]/

export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let state: SplitState = 'invalid'
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]
    let token: SplitToken = 'other'
    let text = c
    if (c === ';') {
      token = 'semi'
    } else if (/[ \r\t\n\f]/.test(c)) {
      token = 'ws'
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 1
      token = 'ws'
      text = ''
    } else if (c === '-' && sql[i + 1] === '-') {
      // Up to the line's end, which is read next as whitespace.
      const eol = sql.indexOf('\n', i)
      i = eol === -1 ? sql.length : eol - 1
      token = 'ws'
      text = ''
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = sql.indexOf(c === '[' ? ']' : c, i + 1)
      const end = close === -1 ? sql.length - 1 : close
      text = sql.slice(i, end + 1)
      i = end
    } else if (NAME_CHAR.test(c)) {
      let end = i
      while (end + 1 < sql.length && NAME_CHAR.test(sql[end + 1])) end++
      text = sql.slice(i, end + 1)
      i = end
      token = KEYWORD_TOKENS[text.toLowerCase()] ?? 'other'
    }
    state = SPLIT_NEXT[state][SPLIT_TOKENS.indexOf(token)]
    if (state === 'start' && token === 'semi') {
      const s = current.trim()
      if (s.length > 0) statements.push(s + ';')
      current = ''
    } else {
      current += text
    }
  }
  const rest = current.trim()
  if (rest.length > 0) statements.push(rest + ';')
  return statements
}
