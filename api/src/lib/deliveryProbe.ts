// STUB — replaced in the green commit.
import type { AppDb, Env, TenantQueueMessage } from '../types'

export interface DeliveryProbeRecord { nonce: string; billId: string; receivedAt: string; readStatus: number }

export async function recordDeliveryProbe(_msg: TenantQueueMessage, _env: Env, _db: AppDb): Promise<void> {}

export async function readDeliveryProbe(_db: AppDb): Promise<DeliveryProbeRecord | null> { return null }
