// Stub for the red step of #647.
export const HANDLE_FORM_TTL_MS = 60_000
export async function sendsNeutralHandles(_env: object, _tenantId: string, _now = Date.now()): Promise<boolean> {
  return false
}
