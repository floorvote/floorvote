/**
 * The URL if it is an absolute http(s) URL, else null. For links that come
 * from a provider's feed and end up in an href, where anything else (a
 * `javascript:` URL, a relative path) must never be rendered as a link.
 */
export function httpUrl(value: string | null | undefined): string | null {
  const url = value?.trim()
  if (!url) return null
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' ? url : null
  } catch {
    return null
  }
}
