import type { SendResult } from '../../../shared/emailSender'

type Failed = Extract<SendResult, { ok: false }>

/**
 * One line saying why a send failed, for a log: the provider that failed and
 * its error, or just the reason when no provider was tried (an invalid
 * address, or none configured).
 */
export function describeSendFailure(r: Failed): string {
  return r.provider ? `Email send failed (${r.provider}): ${r.error}` : r.error
}

/**
 * Log a failed send. A send that went out, or that demo mode suppressed, logs
 * nothing: neither is a failure.
 */
export function logSendFailure(r: SendResult): void {
  if (!r.ok) console.error(describeSendFailure(r))
}
