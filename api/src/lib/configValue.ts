/**
 * Decode a text value from association_config.
 *
 * Values are written JSON-encoded (PUT /admin/config does JSON.stringify), so a
 * raw read yields a quoted string with escaped newlines. Reading raw was a live
 * bug: the AI system instruction reached the model wrapped in literal quotes with
 * "\n" instead of paragraph breaks. Some older rows hold a bare string, so fall
 * back to the raw value when it is not valid JSON.
 */
export function readConfigString(row: { value: string } | undefined | null): string | undefined {
  if (!row) return undefined
  try {
    const parsed = JSON.parse(row.value)
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return row.value
  }
}
