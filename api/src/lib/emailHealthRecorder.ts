import type { AppDb } from '../types'
import type { HealthRecorder } from '../../../shared/emailSender'

export function emailHealthRecorder(_db: AppDb): HealthRecorder {
  return { record: async () => {} }
}
