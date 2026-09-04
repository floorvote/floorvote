/**
 * Multi-select custom field values are stored as a JSON array string in
 * `bill_custom_field_values.value` (e.g. `["urgent","monitor"]`). Legacy or
 * single-select rows hold a bare string, so a value that does not parse as a
 * JSON array is treated as a single-element selection.
 */
export function parseStoredMulti(raw: string | undefined | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
  } catch { /* fall through */ }
  return [raw]
}
