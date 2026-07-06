import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  },
}))

import { apiFetch } from '../lib/api'
const mockFetch = vi.mocked(apiFetch)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('useAuth', () => {
  it('returns user when /auth/me succeeds', async () => {
    mockFetch.mockResolvedValue({ id: '1', email: 'a@b.com', name: 'A', role: 'member' })
    const { AuthProvider, useAuth } = await import('../context/AuthContext')
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => React.createElement(AuthProvider, null, children),
    })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user?.email).toBe('a@b.com')
  })

  it('returns null when /auth/me returns 401', async () => {
    const { ApiError } = await import('../lib/api')
    mockFetch.mockRejectedValue(new ApiError(401, 'Not authenticated'))
    const { AuthProvider, useAuth } = await import('../context/AuthContext')
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => React.createElement(AuthProvider, null, children),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(result.current.authError).toBe(false)
  })

  it('sets authError on non-401 errors without logging user out', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    const { AuthProvider, useAuth } = await import('../context/AuthContext')
    const { result } = renderHook(() => useAuth(), {
      wrapper: ({ children }) => React.createElement(AuthProvider, null, children),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(result.current.authError).toBe(true)
  })
})
