import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { apiFetch } from '../lib/api'

export interface OperatorConfig {
  name: string
  url: string
  contactEmails: string[]
  /**
   * Operator's own source offer, overriding the SOURCE_URL constant. Three
   * states, so this is deliberately optional rather than defaulted to '':
   * absent = use the built-in default, a URL = the operator's published source,
   * '' = the operator has none to offer. See OperatorBranding.
   */
  sourceUrl?: string
}

export interface AppConfig {
  associationName?: string
  states: string[]
  multiState?: boolean
  modules?: Record<string, boolean>
  orgNoun?: string
  positionVocabulary?: string[]
  tagTaxonomy?: string[]
  instanceDomains?: Record<string, string>
  demoLocked?: boolean
  demoBanner?: string
  operator?: OperatorConfig
  /** Data providers the footer credits, e.g. ["legiscan"] or ["lims"]. Absent = LegiScan. */
  dataSources?: string[]
  accountDeletionEnabled?: boolean
  /**
   * What each covered state's data can do, by state, from the provider central
   * reads it from. A state left out has none. Gate features on these, never on
   * a state's name.
   */
  capabilities?: Record<string, StateCapabilities>
}

export interface StateCapabilities {
  /** The legislature's own calendar (hearings without bills) reaches the instance's calendar. */
  bodyEvents: boolean
  /** Bills carry deadlines as calendar entries. */
  deadlines: boolean
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
  const multiState = config?.multiState ?? false
  return <ConfigContext value={{ config, multiState, loading }}>{children}</ConfigContext>
}

export function useConfig(): ConfigValue {
  return useContext(ConfigContext)
}
export function useMultiState(): boolean {
  return useContext(ConfigContext).multiState
}
