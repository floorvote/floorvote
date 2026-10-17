/**
 * One vote vocabulary for every provider's roll calls. Providers say the same
 * thing in different words (LegiScan "Yea"/"NV", DC "Yes"/"No", Virginia "Not
 * Voting"), so the bill page maps each word onto a group and shows the groups in
 * one order: Yea, Nay, Not voting, Absent, then any other word (Present, Recused,
 * Abstain, or one nobody has seen yet) as its own group, never dropped.
 */

export type VoteTone = 'yea' | 'nay' | 'neutral'

export interface VoteGroup {
  /** Same for every word that maps to this group; the words "Yes" and "Aye" share one. */
  key: string
  /** What the page shows. A known word's label is canonical; an unknown word's is as given, trimmed. */
  label: string
  /** Green for yea, red for nay, gray for the rest. */
  tone: VoteTone
  /** Sort order: 0-3 are the main four; every other group is 4, ordered by label. */
  rank: number
}

const YEA: VoteGroup = { key: 'yea', label: 'Yea', tone: 'yea', rank: 0 }
const NAY: VoteGroup = { key: 'nay', label: 'Nay', tone: 'nay', rank: 1 }
const NOT_VOTING: VoteGroup = { key: 'not-voting', label: 'Not voting', tone: 'neutral', rank: 2 }
const ABSENT: VoteGroup = { key: 'absent', label: 'Absent', tone: 'neutral', rank: 3 }
const OTHER_RANK = 4

const KNOWN: Record<string, VoteGroup> = {
  yea: YEA, aye: YEA, yes: YEA, y: YEA,
  nay: NAY, no: NAY, n: NAY,
  nv: NOT_VOTING, 'not voting': NOT_VOTING, 'not-voting': NOT_VOTING,
  absent: ABSENT, excused: ABSENT,
  present: { key: 'present', label: 'Present', tone: 'neutral', rank: OTHER_RANK },
  abstain: { key: 'abstain', label: 'Abstain', tone: 'neutral', rank: OTHER_RANK },
  recused: { key: 'recused', label: 'Recused', tone: 'neutral', rank: OTHER_RANK },
}

/** Shown for a vote with no word at all, so the voter still appears under a label. */
const BLANK_LABEL = 'No vote recorded'

/** Map a provider's vote word onto its group. A word this doesn't know is its own gray group, as given. */
export function normalizeVoteWord(word: string): VoteGroup {
  const trimmed = word.trim().replace(/\s+/g, ' ')
  const known = KNOWN[trimmed.toLowerCase()]
  if (known) return known
  const label = trimmed || BLANK_LABEL
  return { key: `other:${label.toLowerCase()}`, label, tone: 'neutral', rank: OTHER_RANK }
}

/** Group voters by normalized vote word, in display order. Names keep the order they arrived in. */
export function groupVotes(votes: readonly { name: string; vote: string }[]): { group: VoteGroup; names: string[] }[] {
  const byKey = new Map<string, { group: VoteGroup; names: string[] }>()
  for (const v of votes) {
    const group = normalizeVoteWord(v.vote)
    const entry = byKey.get(group.key)
    if (entry) entry.names.push(v.name)
    else byKey.set(group.key, { group, names: [v.name] })
  }
  return [...byKey.values()].sort((a, b) => a.group.rank - b.group.rank || a.group.label.localeCompare(b.group.label))
}
