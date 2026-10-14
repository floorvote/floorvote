export type MentionViewer = { id: string; role: 'member' | 'admin' | 'owner' }

export function mentionSuggestionItems(_args: unknown): Array<{ type: string; memberCount?: number }> {
  return []
}
