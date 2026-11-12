// Stub: the shared one-retry helper arrives with the green change.
export function overloadDelayMs(_err: unknown): number | null { return null }
export function useOverloadRetry() {
  return {
    start: (): number => 0,
    isCurrent: (_seq: number): boolean => true,
    clear: (): void => {},
    schedule: (_seq: number, _ms: number, _run: () => void): void => {},
  }
}
