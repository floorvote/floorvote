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

*How to write the summary*
- Open with one sentence stating the bill's main effect, starting with a verb ("Requires…", "Establishes…", "Prohibits…"). Never write "This bill", "The bill", or the bill number anywhere in the summary.
- Use the one-sentence form only when the bill makes a single change with nothing attached (one new requirement, one changed date, one renamed program). If it also sets a deadline, penalty, fee, or funding, or changes more than one thing, use the list below, however low its relevance. When unsure, use the list.
- Otherwise, follow that sentence with a list of 2–8 items, most consequential first. Start each item with a short bold label naming what it governs, then a colon, then one sentence that starts with a verb and says who bears the duty. Keep each deadline, dollar amount, threshold, or penalty in the item it belongs to.
- If the bill states an effective date, make it the last item, labeled Effective date.
- Write no other prose, and use bold only for the item labels.

Don't pad a single change to sound substantive ("Extends the sunset date for the state grant program to 2030." is a complete summary), and don't compress a bill with several provisions into one sentence either: the rules above decide its shape. If the available text is too thin to tell what the bill actually does, describe what it appears to do and stop there.`

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
