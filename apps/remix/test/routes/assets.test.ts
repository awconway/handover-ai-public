import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createHandoverAssetServer,
  getDocumentAssetHrefs,
} from '../../app/assets.ts'
import { routes } from '../../app/routes.ts'

describe('browser asset deployment policy', () => {
  it('fingerprints production bootstrap modules and CSS with immutable caching', async () => {
    let server = createHandoverAssetServer({
      nodeEnv: 'production',
      watch: false,
    })

    try {
      let hrefs = await getDocumentAssetHrefs(server)
      assert.match(hrefs.entryHref, /^\/assets\/app\/assets\/entry\.@[A-Za-z0-9_-]+\.ts$/)
      assert.match(
        hrefs.stylesheetHref,
        /^\/assets\/app\/ui\/document\.@[A-Za-z0-9_-]+\.css$/,
      )
      assert.ok(hrefs.entryPreloads.length > 0)
      assert.ok(Object.keys(hrefs.entryImportMap.imports ?? {}).length > 0)

      for (let href of [hrefs.entryHref, hrefs.stylesheetHref]) {
        let response = await server.fetch(new Request(`http://localhost${href}`))
        assert.ok(response)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable')
        if (href === hrefs.stylesheetHref) {
          let stylesheet = await response.text()
          assert.match(stylesheet, /@font-face/)
          assert.match(stylesheet, /@layer base\b/)
          assert.match(stylesheet, /@layer rmx\b/)
          assert.ok(stylesheet.indexOf('@layer base') < stylesheet.indexOf('@layer rmx'))
        }
      }
    } finally {
      await server.close()
    }
  })

  it('keeps development bootstrap URLs stable and revalidated', async () => {
    let server = createHandoverAssetServer({
      nodeEnv: 'development',
      watch: false,
    })

    try {
      let hrefs = await getDocumentAssetHrefs(server)
      assert.equal(hrefs.entryHref, '/assets/app/assets/entry.ts')
      assert.equal(hrefs.stylesheetHref, '/assets/app/ui/document.css')

      for (let href of [hrefs.entryHref, hrefs.stylesheetHref]) {
        let response = await server.fetch(new Request(`http://localhost${href}`))
        assert.ok(response)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'no-cache')
      }
    } finally {
      await server.close()
    }
  })

  it('allows browser modules to import the typed route contract', async () => {
    let server = createHandoverAssetServer({
      nodeEnv: 'development',
      watch: false,
    })

    try {
      let analytics = await server.getScriptEntry(
        'apps/remix/app/assets/analytics-coordinator.tsx',
      )
      let analyticsResponse = await server.fetch(
        new Request(`http://localhost${analytics.href}`),
      )
      assert.ok(analyticsResponse)
      assert.equal(analyticsResponse.status, 200)
      // Development modules preserve relative imports between public modules.
      assert.match(await analyticsResponse.text(), /\.\.\/routes\.ts/)
      assert.ok(analytics.preloads.includes('/assets/app/routes.ts'))

      let routesResponse = await server.fetch(
        new Request(
          'http://localhost' + routes.assets.href({ path: 'app/routes.ts' }),
        ),
      )
      assert.ok(routesResponse)
      assert.equal(routesResponse.status, 200)
    } finally {
      await server.close()
    }
  })

  it('resolves the HMR module importer from the app in the monorepo', async () => {
    let channelClosed = false
    let server = createHandoverAssetServer({
      nodeEnv: 'development',
      watch: true,
      hmrChannel: () => ({
        url: 'http://localhost/hmr-events',
        onFileEvents: () => () => {},
        updateWatchedFiles: () => {},
        close: () => { channelClosed = true },
      }),
    })

    try {
      let hrefs = await getDocumentAssetHrefs(server)
      let entryResponse = await server.fetch(new Request(`http://localhost${hrefs.entryHref}`))
      assert.ok(entryResponse)
      assert.equal(entryResponse.status, 200)
      assert.match(await entryResponse.text(), /\/assets\/__remix_hmr\/client\.js/)

      let hmrResponse = await server.fetch(new Request('http://localhost/assets/__remix_hmr/client.js'))
      assert.ok(hmrResponse)
      assert.equal(hmrResponse.status, 200)
      let hmrSource = await hmrResponse.text()
      let importerHref = /import \{ importModule as __remixImport \} from "([^"]+)"/.exec(hmrSource)?.[1]
      assert.ok(importerHref)
      assert.match(importerHref, /^\/assets\/npm\/.+multiple-import-maps-polyfill/)
      let importerResponse = await server.fetch(new Request(`http://localhost${importerHref}`))
      assert.ok(importerResponse)
      assert.equal(importerResponse.status, 200)
      assert.doesNotMatch(hmrSource, /file:\/\//)
    } finally {
      await server.close()
    }
    assert.equal(channelClosed, true)
  })

  it('updates dependency mappings across releases while reusing unchanged asset URLs', async () => {
    let rootDir = await mkdtemp(path.join(os.tmpdir(), 'handover-assets-'))
    let sourceDir = path.join(rootDir, 'apps/remix/app/assets')
    let stylesheetDir = path.join(rootDir, 'apps/remix/app/ui')
    let server: ReturnType<typeof createHandoverAssetServer> | undefined
    try {
      await mkdir(sourceDir, { recursive: true })
      await mkdir(stylesheetDir, { recursive: true })
      await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), path.join(rootDir, 'node_modules'), 'dir')
      await writeFile(path.join(sourceDir, 'entry.ts'), "export { revision } from './revision.ts'\n")
      await writeFile(path.join(sourceDir, 'revision.ts'), "export const revision = 'first release'\n")
      await writeFile(path.join(stylesheetDir, 'document.css'), 'body { color: black }\n')
      server = createHandoverAssetServer({ nodeEnv: 'production', rootDir })
      let first = await getDocumentAssetHrefs(server)
      let firstDependency = await server.getHref('apps/remix/app/assets/revision.ts')
      await server.close()

      await writeFile(path.join(sourceDir, 'revision.ts'), "export const revision = 'second release'\n")
      server = createHandoverAssetServer({ nodeEnv: 'production', rootDir })
      let second = await getDocumentAssetHrefs(server)
      let secondDependency = await server.getHref('apps/remix/app/assets/revision.ts')

      assert.equal(second.entryHref, first.entryHref)
      assert.equal(second.stylesheetHref, first.stylesheetHref)
      assert.notEqual(secondDependency, firstDependency)
      assert.equal(second.entryImportMap.imports?.['/assets/app/assets/revision.ts'], secondDependency)
      assert.ok(second.entryPreloads.includes(secondDependency))
      assert.equal(second.entryPreloads.includes(firstDependency), false)

      let currentResponse = await server.fetch(new Request(`http://localhost${secondDependency}`))
      assert.ok(currentResponse)
      assert.equal(currentResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable')
      assert.match(await currentResponse.text(), /second release/)
      // Never serve new contents at a URL browsers may already cache forever.
      assert.equal(await server.fetch(new Request(`http://localhost${firstDependency}`)), null)
    } finally {
      await server?.close()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('keeps server source and unrelated packages outside the browser asset boundary', async () => {
    let server = createHandoverAssetServer({ nodeEnv: 'development', watch: false })
    try {
      for (let source of ['apps/remix/app/router.ts', 'apps/remix/app/data/runtime.ts', 'apps/remix/node_modules/pg/lib/index.js']) {
        await assert.rejects(() => server.getHref(source))
      }
    } finally {
      await server.close()
    }
  })
})
