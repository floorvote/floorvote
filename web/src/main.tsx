import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/mobile.css'
import App from './App'

// Stale-deploy recovery for lazily-loaded chunks (e.g. LegalPage, ImportEvents).
// After a deploy rotates hashes, a page left open can request a chunk that no
// longer exists; reload once to pull the current build. The entry bundle is
// handled by the watchdog in index.html. Guarded to one reload per 10s to avoid
// loops (shares its sessionStorage key with that watchdog).
window.addEventListener('vite:preloadError', () => {
  try {
    const KEY = 'fv:asset-reload-at'
    const now = Date.now()
    if (now - parseInt(sessionStorage.getItem(KEY) ?? '0', 10) < 10_000) return
    sessionStorage.setItem(KEY, String(now))
  } catch {
    return
  }
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
