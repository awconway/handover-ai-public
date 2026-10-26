import { run } from 'remix/component'
import {
  detectMultipleImportMapSupport,
  importModule,
  preloadShim,
} from 'remix/multiple-import-maps-polyfill'

import { createFrameRequest, frameMarkupOrDocumentNavigation } from './frame-response.ts'

let app = run({
  async loadModule(moduleUrl, exportName) {
    let mod = await importModule(moduleUrl)
    let Component = mod[exportName]
    if (typeof Component !== 'function') {
      throw new Error(`Unknown component: ${moduleUrl}#${exportName}`)
    }
    return Component
  },
  async processClientEntryPreloads(preloads) {
    if (await detectMultipleImportMapSupport()) return preloads

    preloadShim(preloads)
    return []
  },
  async resolveFrame(src, options) {
    let response = await fetch(createFrameRequest(src, options, window.location.href))
    let isHtml = response.headers.get('Content-Type')?.toLowerCase().includes('text/html')
    if (response.status >= 500 || (response.status >= 300 && !isHtml)) {
      return `<pre>Frame error: ${response.status} ${response.statusText}</pre>`
    }

    // A streamed client-side Frame update is applied chunk by chunk. The
    // summary header can arrive before its four SBAR sections, so aborting a
    // navigation or overlapping it with a processing refresh can otherwise
    // leave a partially rendered summary in the workspace. Buffer navigation
    // responses so each Frame replacement is committed as one complete unit.
    // Initial document rendering still streams on the server.
    return await frameMarkupOrDocumentNavigation(
      response,
      src,
      options?.target,
      (href) => window.location.assign(href),
    )
  },
})

if (import.meta.hot) {
  import.meta.hot.on('server:update', async () => {
    try {
      await app.ready()
      await app.frames.top.reload()
    } catch (error) {
      console.error('Error reloading top frame on server update', error)
    }
  })
}

app.addEventListener('error', (event) => console.error('Remix UI error', event.error))
await app.ready()
