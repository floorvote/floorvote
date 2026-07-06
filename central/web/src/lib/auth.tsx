import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { api, ApiError } from './api'

type Identity = { email: string; name: string }

const AuthContext = createContext<{
  identity: Identity | null
  loading: boolean
  refresh: () => Promise<void>
  logout: () => Promise<void>
} | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const id = await api<Identity>('/admin/dash/auth/me')
      setIdentity(id)
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setIdentity(null)
      } else {
        throw err
      }
    } finally {
      setLoading(false)
    }
  }

  async function logout() {
    await fetch('/admin/dash/auth/logout', { method: 'POST', credentials: 'include' })
    setIdentity(null)
  }

  useEffect(() => { refresh() }, [])

  return <AuthContext.Provider value={{ identity, loading, refresh, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside provider')
  return ctx
}
