import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'

export interface OperatorConfig {
  name: string
  url: string
  contactEmails: string[]
}

export interface AppConfig {
  associationName?: string
  states: string[]
  modules?: Record<string, boolean>
  orgNoun?: string
  positionVocabulary?: string[]
  instanceDomains?: Record<string, string>
  demoLocked?: boolean
  operator?: OperatorConfig
}

interface ConfigValue {
  config: AppConfig | null
  multiState: boolean
  loading: boolean
}

export const ConfigContext = createContext<ConfigValue>({ config: null, multiState: false, loading: true })

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    apiFetch<AppConfig>('/config')
      .then(setConfig)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])
  const multiState = (config?.states?.length ?? 0) > 1
  return <ConfigContext value={{ config, multiState, loading }}>{children}</ConfigContext>
}

export function useConfig(): ConfigValue {
  return useContext(ConfigContext)
}
export function useMultiState(): boolean {
  return useContext(ConfigContext).multiState
}
