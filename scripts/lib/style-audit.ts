export interface RGB { r: number; g: number; b: number }

export function parseHex(value: string): RGB | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

// Redmean perceptual distance — cheap, dependency-free, good enough for clustering.
export function colorDistance(a: string, b: string): number {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return Infinity
  const rmean = (ca.r + cb.r) / 2
  const dr = ca.r - cb.r
  const dg = ca.g - cb.g
  const db = ca.b - cb.b
  return Math.sqrt(
    (2 + rmean / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - rmean) / 256) * db * db,
  )
}

export interface Counted<T> { value: T; count: number }
export interface ColorCluster { canonical: string; members: string[]; totalCount: number }
export interface NumberCluster { canonical: number; members: number[]; totalCount: number }

export function clusterColors(items: Counted<string>[], threshold: number): ColorCluster[] {
  const sorted = [...items].sort((a, b) => b.count - a.count)
  const clusters: ColorCluster[] = []
  for (const item of sorted) {
    const hit = clusters.find((c) => colorDistance(c.canonical, item.value) <= threshold)
    if (hit) {
      hit.members.push(item.value)
      hit.totalCount += item.count
    } else {
      clusters.push({ canonical: item.value, members: [item.value], totalCount: item.count })
    }
  }
  return clusters
}

export function clusterNumbers(items: Counted<number>[], delta: number): NumberCluster[] {
  // Sort by descending count so the most-used value seeds each cluster as its canonical
  // (same strategy as clusterColors).
  const sorted = [...items].sort((a, b) => b.count - a.count)
  const clusters: NumberCluster[] = []
  for (const item of sorted) {
    const hit = clusters.find((c) => Math.abs(c.canonical - item.value) <= delta)
    if (hit) {
      hit.members.push(item.value)
      hit.totalCount += item.count
    } else {
      clusters.push({ canonical: item.value, members: [item.value], totalCount: item.count })
    }
  }
  return clusters
}

export interface ExtractedValues { colors: string[]; radii: number[]; fontSizes: number[] }

export function extractStyleValues(source: string): ExtractedValues {
  const colors = Array.from(source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)).map((m) => m[0])
  const radii = Array.from(source.matchAll(/borderRadius:\s*(\d+)/g)).map((m) => Number(m[1]))
  const fontSizes = Array.from(source.matchAll(/fontSize:\s*(\d+)/g)).map((m) => Number(m[1]))
  return { colors, radii, fontSizes }
}
