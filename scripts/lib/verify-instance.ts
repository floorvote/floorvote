// STUB — replaced in the green commit.
export type CheckStatus = 'pass' | 'fail' | 'skipped'
export type CheckId = 'health' | 'registration' | 'delivery' | 'ai' | 'email'
export interface CheckResult { id: CheckId; label: string; status: CheckStatus; detail: string; cause?: string; stage?: string }
export interface VerifyConfig {
  slug: string
  centralUrl: string
  adminSecret: string
  appUrl: string | null
  workerUrl: string | null
  to: string | null
  ai: boolean
  expectBuild: string | null
  expectStates: string[]
  resume: { cmd: string; steps: Record<string, number> } | null
}
export interface ConfigIo { readFile(path: string): string | null; gitSha(): string | null; repoRoot: string }
export interface Deps { fetch: typeof fetch; sleep(ms: number): Promise<void>; now(): number }
export class UsageError extends Error {}
export function resolveConfig(_argv: string[], _env: Record<string, string | undefined>, _io: ConfigIo): VerifyConfig {
  return {} as VerifyConfig
}
export async function runChecks(_cfg: VerifyConfig, _deps: Deps): Promise<CheckResult[]> {
  const ids: CheckId[] = ['health', 'registration', 'delivery', 'ai', 'email']
  return ids.map(id => ({ id, label: id, status: 'skipped' as const, detail: '' }))
}
export function formatReport(_results: CheckResult[], _cfg: VerifyConfig): string { return '' }
export function exitCode(_results: CheckResult[]): number { return 0 }
