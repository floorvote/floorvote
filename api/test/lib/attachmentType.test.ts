import { describe, it, expect } from 'vitest'
import { checkAttachmentName, checkAttachmentBytes } from '../../src/lib/attachmentType'

const bytes = (...parts: (string | number[])[]) => {
  const out: number[] = []
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0))
    else out.push(...p)
  }
  return new Uint8Array(out)
}

const PDF = bytes('%PDF-1.7\n%âãÏÓ\n1 0 obj')
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'IHDR')
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], '[Content_Types].xml')
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const EXE = bytes('MZ', [0x90, 0x00, 0x03])
const ELF = bytes([0x7f], 'ELF', [2, 1, 1])
const GZIP = bytes([0x1f, 0x8b, 0x08, 0x00])

describe('checkAttachmentName', () => {
  it('allows a PDF and names its content type', () => {
    expect(checkAttachmentName('Testimony.pdf')).toEqual({ ok: true, name: 'Testimony.pdf', contentType: 'application/pdf' })
  })

  it('serves an unknown extension as an octet stream', () => {
    expect(checkAttachmentName('notes.eml')).toMatchObject({ ok: true, contentType: 'application/octet-stream' })
  })

  it.each([
    'setup.exe', 'run.sh', 'page.html', 'page.HTM', 'logo.svg', 'app.js', 'budget.xlsm', 'memo.docm', 'files.zip', 'backup.tar.gz', 'archive.7z',
    'help.chm', 'run.jse', 'disk.vhdx', 'notebook.one',
    // Windows drops trailing dots and spaces when it saves a file.
    'run.bat.', 'run.bat . ',
    // Dots alternating with Unicode spaces (NBSP, ideographic space).
    'run.bat. .　. ',
    // A right-to-left override would show this as "reporttab.pdf".
    'report‮fdp.bat',
  ])(
    'blocks %s',
    (name) => {
      const r = checkAttachmentName(name)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/can't be attached/)
    },
  )

  it('keeps only the last path segment and strips control characters', () => {
    expect(checkAttachmentName('C:\\Users\\x\\..\\re\u0000port.pdf')).toMatchObject({ ok: true, name: 'report.pdf' })
  })

  it('strips bidi controls from the name it keeps', () => {
    expect(checkAttachmentName('a‮b⁦.pdf')).toMatchObject({ ok: true, name: 'ab.pdf' })
  })

  it('treats an extension named like an object property as unknown', () => {
    expect(checkAttachmentName('x.constructor')).toMatchObject({ ok: true, contentType: 'application/octet-stream' })
    expect(checkAttachmentBytes('x.__proto__', new TextEncoder().encode('plain'))).toMatchObject({ ok: true, contentType: 'application/octet-stream' })
  })

  it('refuses an empty name', () => {
    expect(checkAttachmentName('  ').ok).toBe(false)
  })
})

describe('checkAttachmentBytes', () => {
  it('accepts a PDF whose bytes are a PDF, and lets it open inline', () => {
    expect(checkAttachmentBytes('a.pdf', PDF)).toEqual({ ok: true, contentType: 'application/pdf', inline: true })
  })

  it('accepts images inline', () => {
    expect(checkAttachmentBytes('a.png', PNG)).toMatchObject({ ok: true, inline: true })
    expect(checkAttachmentBytes('a.jpg', JPEG)).toMatchObject({ ok: true, contentType: 'image/jpeg', inline: true })
  })

  it('accepts an Office document as a download', () => {
    expect(checkAttachmentBytes('a.docx', ZIP)).toMatchObject({ ok: true, inline: false })
    expect(checkAttachmentBytes('a.xls', OLE)).toMatchObject({ ok: true, inline: false })
  })

  it('accepts plain text as a download', () => {
    expect(checkAttachmentBytes('a.csv', bytes('name,count\nA,1\n'))).toEqual({ ok: true, contentType: 'text/csv', inline: false })
  })

  it('refuses bytes that do not match the stated type', () => {
    const r = checkAttachmentBytes('a.pdf', PNG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/doesn't match its file type/)
  })

  it('refuses a known type hiding behind another extension', () => {
    expect(checkAttachmentBytes('a.png', PDF).ok).toBe(false)
  })

  it.each([
    ['a program renamed to a PDF', 'a.pdf', EXE],
    ['a program with an unknown extension', 'a.dat', ELF],
    ['an archive with an unknown extension', 'a.dat', ZIP],
    ['a gzip archive', 'a.dat', GZIP],
    ['a script', 'a.txt', bytes('#!/bin/sh\nrm -rf /\n')],
    ['a web page saved as text', 'a.txt', bytes('\uFEFF  <!DOCTYPE html><html>')],
    ['an SVG saved as text', 'a.txt', bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ['an HTML page with an unknown extension', 'a.dat', bytes('<html><script>alert(1)</script>')],
    ['binary bytes in a text file', 'a.txt', bytes('abc', [0, 1, 2])],
  ])('refuses %s', (_label, name, head) => {
    const r = checkAttachmentBytes(name, head)
    expect(r.ok).toBe(false)
  })

  it('refuses a blocked extension even when the bytes are harmless', () => {
    expect(checkAttachmentBytes('a.html', bytes('hello')).ok).toBe(false)
  })

  it('accepts an unknown extension whose bytes are nothing in particular', () => {
    expect(checkAttachmentBytes('a.eml', bytes('From: a@b.c\nSubject: hi\n'))).toEqual({ ok: true, contentType: 'application/octet-stream', inline: false })
  })
})
