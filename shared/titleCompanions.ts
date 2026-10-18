// Stub for the red tests. Replaced with the matcher in the next commit.
export const MIN_TITLE_LENGTH = 30

export function normalizeTitle(_title: string): string {
  return ''
}

export interface TitleKeyInput {
  title: string
  billType: string | null
  chamber: string | null
}

export function titleKey(_bill: TitleKeyInput, _billTypes: readonly string[]): string | null {
  return null
}

export interface KeyedBill {
  id: string
  sessionId: string | null
  chamber: string | null
  titleKey: string | null
}

export function titleCompanionPairs<T extends KeyedBill>(_bills: readonly T[]): Array<[T, T]> {
  return []
}

export interface TitleMatchBill extends TitleKeyInput {
  id: string
  sessionId: string | null
}

export function matchTitleCompanions<T extends TitleMatchBill>(_bills: readonly T[], _billTypes: readonly string[]): Array<[T, T]> {
  return []
}
