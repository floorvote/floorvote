// Whether this browser can render a PDF inside an iframe. iOS can't: it has no PDF
// renderer for a subframe (Safari hands PDFs to the system viewer only on a top-level
// navigation), and every iOS browser is WebKit, so the blank frame shows in all of them.
// The failure tracks the engine, not the viewport.

export type PdfNavigator = Pick<Navigator, 'userAgent'> & Partial<Pick<Navigator, 'maxTouchPoints' | 'pdfViewerEnabled'>>

function isIos({ userAgent, maxTouchPoints = 0 }: PdfNavigator): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true
  // iPadOS 13+ reports a Macintosh user agent; a real Mac has no touch screen.
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1
}

export function canRenderPdfInline(nav: PdfNavigator = navigator): boolean {
  if (isIos(nav)) return false
  // `false` means the browser has its PDF viewer off or lacks one; undefined means unreported.
  return nav.pdfViewerEnabled !== false
}
