/** Comment HTML as plain text, for previews: tags removed, ends trimmed. */
export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}
