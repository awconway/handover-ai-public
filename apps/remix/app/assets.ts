import { createAssetServer, type AssetServer, type BrowserHmrChannel } from 'remix/assets'
import { componentHmr } from 'remix/component-hmr/assets'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '../remix.json' with { type: 'json' }

// Browser source and pnpm-resolved Remix modules both live below the repository
// root, so this is the stable asset boundary for scripts and tests.
const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const nodeEnv = process.env.NODE_ENV ?? 'development'

type HandoverAssetServerOptions = {
  nodeEnv?: string
  rootDir?: string
  watch?: boolean
  hmrChannel?: () => BrowserHmrChannel | Promise<BrowserHmrChannel>
}

export function createHandoverAssetServer(
  options: HandoverAssetServerOptions = {},
): AssetServer {
  let configuredNodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? 'development'
  let isDevelopment = configuredNodeEnv === 'development'
  let isProduction = configuredNodeEnv === 'production'
  let isHmr = Boolean(isDevelopment && (options.hmrChannel || process.env.REMIX_NODE_HMR))

  return createAssetServer({
    ...config.assets,
    rootDir: options.rootDir ?? rootDir,
    sourceMaps: isDevelopment ? 'external' : undefined,
    minify: !isDevelopment,
    watch: options.watch ?? isDevelopment,
    hmr: isHmr
      ? {
          channel: options.hmrChannel ?? (async () => (await import('remix/node-hmr/runtime')).createBrowserHmrChannel()),
          // The asset root is the monorepo; Remix is installed in this app.
          moduleImporter: fileURLToPath(import.meta.resolve('remix/multiple-import-maps-polyfill')),
        }
      : undefined,
    scripts: { loaders: isHmr ? [componentHmr()] : undefined },
    fingerprint: isProduction,
  })
}

export async function getDocumentAssetHrefs(server: AssetServer) {
  let [entry, stylesheetHref] = await Promise.all([
    server.getScriptEntry('apps/remix/app/assets/entry.ts'),
    server.getHref('apps/remix/app/ui/document.css'),
  ])

  return {
    entryHref: entry.href,
    entryImportMap: entry.importMap,
    entryPreloads: entry.preloads,
    stylesheetHref,
  }
}

export const assetServer = createHandoverAssetServer({ nodeEnv })
export const documentAssetHrefs = await getDocumentAssetHrefs(assetServer)
