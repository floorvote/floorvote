/**
 * D1 rejects any statement with more than 100 bound parameters, so a list that
 * becomes one parameter per item (an IN list, or a multi-row insert's values)
 * has to be split.
 */
export const D1_MAX_PARAMS = 100

/** Splits `items` into consecutive slices of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be at least 1, got ${size}`)
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
