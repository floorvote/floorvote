// Which files may be attached to a comment (#465), as pure functions.
//
// Any file is allowed except programs and scripts, anything a browser would
// render as a page (HTML, SVG, JavaScript, XML), macro-enabled Office files,
// and archives. Two checks:
//
//   - checkAttachmentName, before the upload: the extension against the
//     blocklist, and the content type the upload is signed for.
//   - checkAttachmentBytes, after it: the file's first bytes. Bytes that are a
//     program, an archive, or a page are refused whatever the name says, and
//     bytes that are a known type must match the extension's type (a PDF named
//     .png, or a .pdf that isn't one, is refused).
//
// Only PDFs and images open in the browser. Everything else is served as a
// download, and an unknown extension as application/octet-stream.

type NameResult = { ok: true; name: string; contentType: string } | { ok: false; error: string }
type BytesResult = { ok: true; contentType: string; inline: boolean } | { ok: false; error: string }

/** How many leading bytes checkAttachmentBytes wants (tar's magic sits at 257). */
export const SNIFF_BYTES = 4096

const MAX_NAME_LENGTH = 200

const BLOCKED_EXTENSIONS = new Set([
  // Programs and installers
  'exe', 'msi', 'msix', 'appx', 'com', 'scr', 'dll', 'sys', 'cpl', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'ipa', 'jar', 'bin', 'iso', 'img',
  // Scripts and shortcuts
  'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'sh', 'bash', 'zsh', 'command', 'py', 'pyc', 'rb', 'pl', 'php', 'lnk', 'reg', 'url', 'webloc', 'desktop', 'inf', 'scf',
  // Pages a browser renders
  'html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'swf',
  // Macro-enabled Office files
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppsm', 'ppam', 'sldm',
  // Archives
  'zip', 'zipx', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'lz', 'lzma', 'zst', 'cab', 'arj', 'z',
])

type Sniffed = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'ole' | 'rtf' | 'program' | 'archive' | 'page' | null

// What each allowed, known extension holds: its content type, the signature
// its bytes must carry ('text' means readable text with no signature), and
// whether it opens in the browser.
const KNOWN: Record<string, { type: string; sig: Sniffed | 'text'; inline?: true }> = {
  pdf: { type: 'application/pdf', sig: 'pdf', inline: true },
  png: { type: 'image/png', sig: 'png', inline: true },
  jpg: { type: 'image/jpeg', sig: 'jpeg', inline: true },
  jpeg: { type: 'image/jpeg', sig: 'jpeg', inline: true },
  gif: { type: 'image/gif', sig: 'gif', inline: true },
  webp: { type: 'image/webp', sig: 'webp', inline: true },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sig: 'zip' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sig: 'zip' },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sig: 'zip' },
  odt: { type: 'application/vnd.oasis.opendocument.text', sig: 'zip' },
  ods: { type: 'application/vnd.oasis.opendocument.spreadsheet', sig: 'zip' },
  odp: { type: 'application/vnd.oasis.opendocument.presentation', sig: 'zip' },
  doc: { type: 'application/msword', sig: 'ole' },
  xls: { type: 'application/vnd.ms-excel', sig: 'ole' },
  ppt: { type: 'application/vnd.ms-powerpoint', sig: 'ole' },
  rtf: { type: 'application/rtf', sig: 'rtf' },
  txt: { type: 'text/plain', sig: 'text' },
  csv: { type: 'text/csv', sig: 'text' },
  md: { type: 'text/markdown', sig: 'text' },
}

const OCTET_STREAM = 'application/octet-stream'

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function blockedMessage(name: string): string {
  return `"${name}" can't be attached: programs, scripts, web pages, macro-enabled Office files, and archives aren't allowed.`
}

function cleanName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? ''
  return last.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH)
}

export function checkAttachmentName(raw: string): NameResult {
  const name = cleanName(String(raw ?? ''))
  if (!name) return { ok: false, error: 'The file needs a name.' }
  const ext = extensionOf(name)
  if (BLOCKED_EXTENSIONS.has(ext)) return { ok: false, error: blockedMessage(name) }
  return { ok: true, name, contentType: KNOWN[ext]?.type ?? OCTET_STREAM }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)
const ascii = (s: string) => [...s].map(c => c.charCodeAt(0))

// Tags a browser's content sniffing treats as a page, at the start of the text.
const PAGE_PREFIXES = ['<!doctype html', '<html', '<head', '<body', '<script', '<iframe', '<svg', '<?xml', '<!--', '<style', '<title', '<a ', '<div', '<table', '<img', '<p>', '<br', '<h1', '<font', '<b>']

function sniff(b: Uint8Array): Sniffed {
  if (startsWith(b, ascii('%PDF-'))) return 'pdf'
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'gif'
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'webp'
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'
  if (startsWith(b, ascii('{\\rtf'))) return 'rtf'
  // Windows, Linux, and macOS programs, Java classes, and scripts.
  if (startsWith(b, ascii('MZ')) || startsWith(b, [0x7f, 0x45, 0x4c, 0x46])
    || startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf])
    || startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe])
    || startsWith(b, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(b, ascii('#!'))) return 'program'
  // Archives other than zip, which Office files are built on.
  if (startsWith(b, [0x1f, 0x8b]) || startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    || startsWith(b, ascii('Rar!')) || startsWith(b, ascii('BZh')) || startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
    || startsWith(b, [0x28, 0xb5, 0x2f, 0xfd]) || startsWith(b, ascii('MSCF')) || startsWith(b, ascii('ustar'), 257)) return 'archive'
  if (looksLikePage(b)) return 'page'
  return null
}

function looksLikePage(b: Uint8Array): boolean {
  const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(b.subarray(0, 1024))
  const start = text.replace(/^﻿/, '').trimStart().toLowerCase()
  return PAGE_PREFIXES.some(p => start.startsWith(p))
}

function isText(b: Uint8Array): boolean {
  if (b.includes(0)) return false
  try {
    // A multi-byte character cut off at the end of the sample is fine.
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b.subarray(0, Math.max(0, b.length - 3)))
    return true
  } catch {
    return false
  }
}

const MISMATCH = (name: string) => `"${name}" doesn't match its file type, so it wasn't attached.`

export function checkAttachmentBytes(name: string, head: Uint8Array): BytesResult {
  const ext = extensionOf(name)
  if (BLOCKED_EXTENSIONS.has(ext)) return { ok: false, error: blockedMessage(name) }
  const found = sniff(head)
  if (found === 'program' || found === 'archive' || found === 'page') return { ok: false, error: blockedMessage(name) }

  const known = KNOWN[ext]
  if (!known) {
    // An unknown extension may hold anything but a known type: zip bytes here
    // are an archive, and a PDF named .bin is a mismatch.
    if (found === 'zip') return { ok: false, error: blockedMessage(name) }
    if (found) return { ok: false, error: MISMATCH(name) }
    return { ok: true, contentType: OCTET_STREAM, inline: false }
  }
  const matches = known.sig === 'text' ? found === null && isText(head) : found === known.sig
  if (!matches) return { ok: false, error: MISMATCH(name) }
  return { ok: true, contentType: known.type, inline: known.inline === true }
}
