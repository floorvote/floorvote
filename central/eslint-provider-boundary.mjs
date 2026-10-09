import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The provider boundary, in both directions (see src/providers/types.ts).
// Provider code under src/providers/<id>/ may import its own directory,
// src/providers/sdk, and npm packages. Core may import a provider only through
// the registry, src/providers/index. The boundary files at the root of
// src/providers/ (index, sdk, types) may import either side, and no other file
// may live there. Each path is resolved against the importing file, so the
// rule holds at any depth and for any spelling of the path. Checked by
// scripts/check-provider-boundary.mjs, which `npm run lint` runs.

const PROVIDERS = fileURLToPath(new URL('./src/providers', import.meta.url))
const SDK = path.join(PROVIDERS, 'sdk')
const REGISTRY = path.join(PROVIDERS, 'index')
const BOUNDARY_FILES = new Set(['index', 'sdk', 'types'])
const withoutExt = p => p.replace(/\.(ts|js|mjs)$/, '')

/** The import path a node names, or null when it is computed at runtime. */
function specifierOf(source) {
  if (source?.type === 'Literal' && typeof source.value === 'string') return source.value
  if (source?.type === 'TemplateLiteral' && source.expressions.length === 0) return source.quasis[0].value.cooked
  return null
}

export const providerBoundary = {
  meta: { type: 'problem', schema: [] },
  create(context) {
    const file = context.filename
    const rel = path.relative(PROVIDERS, file)
    const segments = rel.startsWith('..') || path.isAbsolute(rel) ? [] : rel.split(path.sep)
    const providerDir = segments.length > 1 ? path.join(PROVIDERS, segments[0]) : null
    const isBoundaryFile = segments.length === 1

    function check(node, source) {
      if (!source || isBoundaryFile) return
      const spec = specifierOf(source)
      if (spec === null) {
        context.report({ node, message: 'An import whose path is computed at runtime can\'t be checked against the provider boundary.' })
        return
      }
      if (!spec.startsWith('.') && !spec.startsWith('/')) return // an npm package or runtime module
      const target = withoutExt(path.resolve(path.dirname(file), spec))
      if (providerDir) {
        if (target === SDK || target === providerDir || target.startsWith(providerDir + path.sep)) return
        context.report({ node, message: `Provider code reaches core only through src/providers/sdk.ts, not '${spec}'. If a provider needs another core helper, export it from sdk.ts.` })
      } else if (target.startsWith(PROVIDERS + path.sep) && target !== REGISTRY) {
        context.report({ node, message: `Core reaches a provider only through the registry, src/providers/index.ts, not '${spec}'.` })
      }
    }

    return {
      Program(node) {
        if (isBoundaryFile && !BOUNDARY_FILES.has(withoutExt(segments[0]))) {
          context.report({ node, message: 'Only index.ts, sdk.ts, and types.ts live at the root of src/providers/. Put provider code in src/providers/<id>/.' })
        }
      },
      ImportDeclaration: node => check(node, node.source),
      ExportNamedDeclaration: node => check(node, node.source),
      ExportAllDeclaration: node => check(node, node.source),
      ImportExpression: node => check(node, node.source),
      TSImportType: node => check(node, node.source ?? node.argument?.literal),
      TSExternalModuleReference: node => check(node, node.expression),
    }
  },
}
