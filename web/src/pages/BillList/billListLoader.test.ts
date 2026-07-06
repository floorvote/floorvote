import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as api from '../../lib/api'
import { billListLoader } from './index'

function loaderArgs(url: string) {
  return { params: {}, request: new Request(url), context: {} } as never
}

beforeEach(() => { vi.restoreAllMocks() })

describe('billListLoader', () => {
  it('prefetches the bills list for the current URL params before render', async () => {
    const spy = vi.spyOn(api, 'apiFetch').mockResolvedValue(
      { bills: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } } as never,
    )
    await billListLoader(loaderArgs('http://localhost/bills?status=Introduced'))
    expect(spy).toHaveBeenCalled()
    const calledPath = String(spy.mock.calls[0][0])
    expect(calledPath.startsWith('/bills?')).toBe(true)
    expect(calledPath).toContain('Introduced')
  })

  it('does not throw if the prefetch fails — the component surfaces its own error state', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new Error('network'))
    await expect(billListLoader(loaderArgs('http://localhost/bills'))).resolves.toBeNull()
  })
})
