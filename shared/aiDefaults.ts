/**
 * Default AI instruction text, shared by the API (prompt construction) and the
 * web admin UI (ghost placeholder + personalization hint).
 *
 * These defaults are deliberately RUNNABLE: a tenant that never edits them still
 * gets honest, well-formatted, generic summaries. Nothing here is written to
 * association_config — the fields stay empty and these act as fallbacks, so
 * "still on defaults" is simply "blank" and a later association rename is picked
 * up on the next prompt with no stored state to migrate.
 *
 * Never put bracketed placeholder text (e.g. "[FILL THIS IN]") in this file.
 * It would reach the model verbatim, which is worse than generic output.
 */

/** The value seeded by migrations/0001_initial.sql when no ASSOCIATION_NAME is set. */
export const ASSOCIATION_NAME_PLACEHOLDER = 'My Association'

export const AI_CONTEXT_TEMPLATE = `You are analyzing a bill for {name}.

When writing the summary, start directly with an action verb or gerund phrase — do not begin with "This bill", "The bill", or the bill number. For example, you could start with "Requires community water systems to...", "Establishes a grant program for...", etc.

Scale the description to the bill's complexity and relevance. For less relevant, simple, or narrow bills 1–2 plain sentences should suffice. For bills that are longer and more relevant, you might write a paragraph or two. For a bill with multiple distinct provisions, you might also—or instead—use a list of 2–8 items, with the most impactful provisions first (unless there is some other order that would be more logical). Each item should start with a verb and be one sentence. You should aim to minimize redundancy in the description.`

export const RELEVANCE_QUESTION_TEMPLATE =
  "Rate this bill's relevance to {name}'s legislative priorities."

function resolveName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim()
  return trimmed.length > 0 ? trimmed : ASSOCIATION_NAME_PLACEHOLDER
}

export function buildDefaultAiContext(name: string | null | undefined): string {
  // Function replacer, not a string one: a string replacement argument is
  // subject to $&/$$/$`/$'/$<n> special-pattern substitution, so an
  // association name containing e.g. "$$" would corrupt the interpolated
  // prompt. A function replacer's return value is inserted verbatim.
  return AI_CONTEXT_TEMPLATE.replace('{name}', () => resolveName(name))
}

export function buildDefaultRelevanceQuestion(name: string | null | undefined): string {
  return RELEVANCE_QUESTION_TEMPLATE.replace('{name}', () => resolveName(name))
}

/**
 * True when a stored AI config value is absent or blank — i.e. the tenant is
 * running on the generic default. Drives the personalization hint in the admin
 * UI and the operator-side signal at central. A false negative costs a missing
 * hint, never lost AI, which is why a trivial emptiness check is sufficient.
 */
export function isAiConfigDefault(stored: string | null | undefined): boolean {
  return (stored ?? '').trim().length === 0
}
