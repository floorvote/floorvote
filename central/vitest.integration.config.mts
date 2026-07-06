import { defineConfig } from 'vitest/config'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function loadDevVars(): Record<string, string> {
  try {
    const content = readFileSync(resolve(__dirname, '.dev.vars'), 'utf-8')
    return Object.fromEntries(
      content.split('\n')
        .filter(l => l.includes('=') && !l.startsWith('#'))
        .map(l => {
          const idx = l.indexOf('=')
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]
        })
    )
  } catch {
    return {}
  }
}

const devVars = loadDevVars()

export default defineConfig({
  test: {
    environment: 'node',
    env: devVars,
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30000,
  },
})
