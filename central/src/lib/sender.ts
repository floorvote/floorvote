import { createSender, type EmailSender, type SenderEnv } from '../../../shared/emailSender'
import { configuredProviders } from '../../../shared/emailProviders'

/**
 * Central's mail goes through the shared purpose-level sender (#705): the
 * dashboard sign-in link as `sign-in`, ops alerts as `operator`. Central keeps
 * no email-health counts, so it supplies no recorder.
 *
 * Only configured providers are tried: with neither a Resend key nor the
 * binding, a send fails at once ("no email provider configured") instead of
 * calling Resend with no credentials. With both, a temporary failure on the
 * first falls back to the second.
 */
export function centralSender(env: SenderEnv): EmailSender {
  return createSender(env, { providers: configuredProviders(env) })
}
