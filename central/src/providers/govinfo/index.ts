import type { Provider } from '../sdk'

// STUB for the red run (removed in the same ticket by the real provider).
export const govinfo: Provider = {
  id: 'govinfo',
  displayName: 'GovInfo Bill Status',
  attribution: { name: 'GovInfo', url: 'https://www.govinfo.gov' },
  coverage: { maintainers: ['wtadler'] },
  envKeys: [],
  states: ['US'],
  async listSessions() { return [] },
  selectSessions(sessions) { return sessions },
  async snapshot() { return { records: [] } },
  async toEntry() { throw new Error('stub') },
  async fetchMeasure() { throw new Error('stub') },
  vocabulary: { statuses: {}, billTypes: {}, eventTypes: {} },
}
