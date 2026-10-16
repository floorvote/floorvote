// ── Stored HTML bill text → string ────────────────────────────────────────
// Some states publish bill HTML as windows-1252, and `obj.text()` always reads
// bytes as UTF-8, so curly quotes, section signs, and dashes became U+FFFD in
// both the bill text panel and every analysis prompt. Everything that turns a
// stored HTML object into a string goes through here instead.
//
// Order of preference:
//   1. The declared charset: the stored Content-Type first (ingest copies the
//      server's header, or a sniffed <meta>, onto the R2 object), then a
//      <meta charset> / http-equiv tag near the top of the document.
//   2. UTF-8, when the bytes are valid UTF-8.
//   3. windows-1252, which is what an HTML byte stream with no usable
//      declaration most likely is (and what browsers assume).
//
// PDFs never come through here: they are binary and are served as bytes.

const FALLBACK_ENCODING = 'windows-1252'

// The HTML spec only looks 1024 bytes in for a <meta> charset. A little more
// leaves room for the long comment or doctype some state systems emit first,
// while still never reading markup quoted deep inside a bill.
const META_SNIFF_BYTES = 4096

const CONTENT_TYPE_CHARSET = /charset\s*=\s*["']?([^\s;"']+)/i
// Matches <meta charset=x> and <meta http-equiv=Content-Type content="...; charset=x">.
const META_CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?([^\s;"'>/]+)/i

/**
 * The canonical TextDecoder name for a charset label, or null when the runtime
 * does not know it (or it names the spec's inert "replacement" encoding).
 */
function canonicalEncoding(label: string | undefined): string | null {
  if (!label) return null
  try {
    const encoding = new TextDecoder(label).encoding
    return encoding === 'replacement' ? null : encoding
  } catch {
    return null
  }
}

function declaredEncoding(bytes: Uint8Array, contentType: string | null | undefined): string | null {
  const fromHeader = canonicalEncoding(contentType?.match(CONTENT_TYPE_CHARSET)?.[1])
  if (fromHeader) return fromHeader

  const head = new TextDecoder(FALLBACK_ENCODING).decode(bytes.subarray(0, META_SNIFF_BYTES))
  const fromMeta = canonicalEncoding(head.match(META_CHARSET)?.[1])
  // A UTF-16 <meta> tag cannot have been read from a byte stream, so it can only
  // have been written in an ASCII-compatible encoding; browsers read it as UTF-8.
  if (fromMeta === 'utf-16le' || fromMeta === 'utf-16be') return 'utf-8'
  return fromMeta
}

/** Decode strictly: null instead of U+FFFD when the bytes are invalid in `encoding`. */
function decodeStrict(bytes: Uint8Array, encoding: string): string | null {
  try {
    // ignoreBOM is false (the default: a leading BOM is dropped); the Workers
    // typings declare the option required alongside fatal.
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return null
  }
}

export function decodeStoredHtml(input: ArrayBuffer | Uint8Array, contentType?: string | null): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const declared = declaredEncoding(bytes, contentType)

  if (declared && declared !== 'utf-8') {
    // Servers mislabel UTF-8 files as ISO-8859-1 (which the encoding spec folds
    // into windows-1252). Those decode correctly as UTF-8 today, so valid UTF-8
    // wins over a windows-1252 label: text that is genuinely windows-1252 is
    // almost never also well-formed UTF-8 once it has a non-ASCII byte.
    if (declared === FALLBACK_ENCODING) {
      const asUtf8 = decodeStrict(bytes, 'utf-8')
      if (asUtf8 !== null) return asUtf8
    }
    // Any other declaration is taken at its word, lossy bytes and all.
    return decodeStrict(bytes, declared) ?? new TextDecoder(declared).decode(bytes)
  }

  // Declared UTF-8 or undeclared. A declaration that lies (UTF-8 over
  // windows-1252 bytes) lands in the fallback just like no declaration at all.
  return decodeStrict(bytes, 'utf-8') ?? new TextDecoder(FALLBACK_ENCODING).decode(bytes)
}
