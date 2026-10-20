// Central's entry file under its old, LegiScan-named path. Central runs every
// provider, so its entry is src/index.ts. This alias keeps a central/wrangler.toml
// that names `main = "src/index-legiscan.ts"` deploying the same worker; it goes
// away in a later release, so point new configs at src/index.ts.
export * from './index'
export { default } from './index'
