/* eslint-disable @typescript-eslint/no-explicit-any */
export type VoteTone = 'yea' | 'nay' | 'neutral'
export interface VoteGroup { key: string; label: string; tone: VoteTone; rank: number }
export function normalizeVoteWord(_word: string): VoteGroup { return undefined as any }
export function groupVotes(_votes: { name: string; vote: string }[]): { group: VoteGroup; names: string[] }[] { return undefined as any }
