/**
 * Drain the tenants' shared dead-letter queue.
 *
 * Every tenant worker names a `dead_letter_queue` on its consumer, so a message
 * that exhausts its retry budget lands there instead of vanishing. Nothing was
 * reading that queue, which made it a slower kind of vanishing: 410 messages
 * accumulated across two incidents before anyone looked, and a queue nobody
 * drains cannot serve as a signal either — its depth only ever goes up, so it
 * says the same thing whether today was healthy or catastrophic.
 *
 * WHY THIS ONLY LOGS
 *
 * The dead-letter queue is shared by every tenant, but a worker is bound to one
 * database. Whoever consumes it therefore receives messages it cannot act on:
 * marking the bill failed would only work for the fraction belonging to the
 * consuming tenant. Central has no tenant database at all, which is precisely
 * why it is the right host — it is honest about only being able to observe.
 *
 * Recovery is handled upstream of here instead. The tenant records the failure
 * on the bill before the message ever dead-letters, so a bill that ran out of
 * retries already shows an ai_error and can be re-queued by the existing
 * per-bill reprocess. This consumer's job is narrower: leave a trail, and keep
 * the depth meaningful.
 *
 * ACKING IS DELETION. A dead letter that is logged and acked is gone. That is
 * the intended behaviour — the alternative is unbounded growth — but it means
 * the log line is the only surviving record, so it carries everything needed to
 * find the bill again.
 */

/** The shape tenants publish; unknown fields are tolerated rather than trusted. */
type DeadLetter = {
  tenantId?: unknown
  billId?: unknown
}

function describe(body: unknown): string {
  const b = (body ?? {}) as DeadLetter
  const tenant = typeof b.tenantId === 'string' ? b.tenantId : 'unknown-tenant'
  const bill = typeof b.billId === 'string' ? b.billId : 'unknown-bill'
  return `${tenant}/${bill}`
}

/**
 * Log every dead letter in the batch and acknowledge it.
 *
 * Acks individually rather than via `ackAll()` so that a body which fails to
 * serialise into the log cannot take the rest of the batch down with it: the
 * whole point is that this queue drains.
 */
export function processDeadLetterQueue(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    try {
      console.warn(
        `[dead-letter] ${describe(message.body)}`
        + ` queued ${message.timestamp.toISOString()}`
        + ` after ${message.attempts} attempt(s)`,
      )
    } catch (err) {
      console.error('[dead-letter] could not describe a message:', err)
    }
    message.ack()
  }
  console.warn(`[dead-letter] drained ${batch.messages.length} message(s) from ${batch.queue}`)
}
