import type { Provider } from '../providers'
import { providerEnv } from './providerContext'
import type { Env } from '../types'

/** Whether this deployment has what a provider needs to run, such as its API key. One without `configured` needs nothing. */
export function providerConfigured(provider: Provider, env: Env): boolean {
  return provider.configured?.(providerEnv(provider, env)) ?? true
}

/** The queue a provider's bills are ingested from: its own binding, when it declares one and it is bound. */
export function ingestQueueFor(provider: Provider, env: Env): Queue {
  return (provider.ingestQueue ? env[provider.ingestQueue] as Queue | undefined : undefined) ?? env.INGESTOR_QUEUE
}
