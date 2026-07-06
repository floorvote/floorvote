// Categorical palette for per-tenant chart lines. Tuned for legibility on the
// light dashboard background (--bg: #f8fafc). The bold blue aggregate uses
// --accent (#1e3a5f), so that hue is intentionally avoided here.
const PALETTE = [
  '#2563eb', // blue
  '#dc2626', // red
  '#16a34a', // green
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#db2777', // pink
  '#65a30d', // lime
  '#ea580c', // orange
  '#4f46e5', // indigo
  '#0d9488', // teal
  '#9333ea', // purple
]

/** Stable color for a tenant by its index in the (full) tenant list. */
export function tenantColor(index: number): string {
  return PALETTE[index % PALETTE.length]
}
