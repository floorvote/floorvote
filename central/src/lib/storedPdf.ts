// ── Stored PDFs ───────────────────────────────────────────────────────────
// A stored `.pdf` is served as a PDF only if its bytes are one. The content type
// recorded on the R2 object is whatever the provider sent (an error page often
// arrives as text/html), so it never decides what a browser renders in the app's
// own origin.

const MAGIC = new TextEncoder().encode('%PDF-')

/**
 * Check that `body` starts with `%PDF-`, reading only as far as the first five
 * bytes. Returns a stream with every byte of the original, in order, to serve; or
 * null (and cancels the source) when it isn't a PDF. The rest of the body is read
 * only as the caller pulls it, so a large PDF is never held in memory here.
 */
export async function pdfStreamOrNull(body: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array> | null> {
  const reader = body.getReader()
  const head: Uint8Array[] = []
  let have = 0
  let ended = false

  while (have < MAGIC.length && !ended) {
    const { value, done } = await reader.read()
    if (done) ended = true
    else if (value.length > 0) { head.push(value); have += value.length }
  }

  let isPdf = have >= MAGIC.length
  if (isPdf) {
    let at = 0
    outer: for (const chunk of head) {
      for (const b of chunk) {
        if (b !== MAGIC[at]) { isPdf = false; break outer }
        if (++at === MAGIC.length) break outer
      }
    }
  }
  if (!isPdf) {
    await reader.cancel().catch(() => {})
    return null
  }

  let next = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < head.length) return controller.enqueue(head[next++])
      if (ended) return controller.close()
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
