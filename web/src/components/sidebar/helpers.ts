export function calendarChipLabel(count: number | null | undefined): string | null {
  if (!count || count < 1) return null
  return `${count} upcoming`
}

export function showCustomizeControl(role: string | undefined): boolean {
  return role === 'admin' || role === 'owner'
}
