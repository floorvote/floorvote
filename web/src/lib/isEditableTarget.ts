/**
 * True when an event target is an editable field: a native input/textarea, or
 * any element inside (or being) a contenteditable region (e.g. a TipTap editor).
 * Uses both `isContentEditable` (reliable in browsers) and an attribute-based
 * `closest` check (reliable in jsdom).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return true
    if (target.closest('[contenteditable=""], [contenteditable="true"]')) return true
  }
  return false
}
