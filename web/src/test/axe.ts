import { expect } from 'vitest'
import * as matchers from 'vitest-axe/matchers'
import type { AxeMatchers } from 'vitest-axe/matchers'
import { axe } from 'vitest-axe'

expect.extend(matchers)

// vitest-axe (v0.1.0) ships its own `vitest-axe/extend-expect` type augmentation,
// but it targets the legacy global `Vi.Assertion` namespace from Vitest <2.
// Vitest 4 (used here) no longer has that namespace — matcher types are
// declared via `Assertion`/`AsymmetricMatchersContaining` re-exported from the
// `vitest` module itself — so that augmentation is a silent no-op under this
// project's Vitest version. Augment the current interfaces directly, reusing
// vitest-axe's own `AxeMatchers` type so the return type stays accurate.
declare module 'vitest' {
  // `T` must match `Assertion<T = any>`'s own type parameter name and default
  // exactly — TS requires identical type parameters across merged declarations
  // of the same interface — even though AxeMatchers doesn't use it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<T = any> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

export { axe }
