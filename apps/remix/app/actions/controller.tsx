import { createController } from 'remix/router'

import { assetServer } from '../assets.ts'
import { DataRuntimeKey } from '../middleware/data.ts'
import { UploadStores } from '../middleware/uploads.ts'
import { routes } from '../routes.ts'

function json(value: unknown, init?: ResponseInit) {
  let headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), { ...init, headers })
}

async function readiness(
  runtime: import('../middleware/data.ts').DataRuntime,
  uploads: import('../middleware/uploads.ts').UploadStoresValue,
) {
  try {
    await Promise.all([
      runtime.ready(),
      uploads.audio.healthCheck(),
      uploads.sheets.healthCheck(),
    ])
    return json({ ok: true })
  } catch (error) {
    console.error('Readiness check failed', {
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return json(
      {
        ok: false,
        error: 'Readiness check failed',
      },
      { status: 503 },
    )
  }
}

export default createController(routes, {
  actions: {
    async assets(context) {
      return (
        (await assetServer.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
      )
    },
    health() {
      return json({ ok: true })
    },
    apiHealth() {
      return json({ ok: true })
    },
    ready(context) {
      return readiness(context.get(DataRuntimeKey), context.get(UploadStores))
    },
    apiReady(context) {
      return readiness(context.get(DataRuntimeKey), context.get(UploadStores))
    },
  },
})
