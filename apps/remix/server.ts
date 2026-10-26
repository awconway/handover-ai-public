import 'dotenv/config'
import * as http from 'node:http'
import { createRequestListener } from 'remix/node-fetch-server'

import { assetServer } from './app/assets.ts'
import { data, processingEvents, router } from './app/router.ts'

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8787
const publicPort = process.env.HMR_PROXY_PORT ?? port

await Promise.all([data.ready(), processingEvents.start()])

const server = http.createServer(
  createRequestListener(async (request) => {
    try {
      return await router.fetch(request)
    } catch (error) {
      if (!(request.signal.aborted && error === request.signal.reason)) {
        console.error(error)
      }
      return new Response('Internal Server Error', { status: 500 })
    }
  }),
)

server.listen(port, () => {
  if (process.env.REMIX_NODE_HMR) {
    import('remix/node-hmr/runtime').then((nodeHmr) => nodeHmr.emitServerReady())
  }
  console.log(`Server listening on http://localhost:${publicPort}`)
})

let shuttingDown = false

async function shutdown() {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  let forceTimer = setTimeout(() => server.closeAllConnections(), 10_000)
  forceTimer.unref()
  let closed = new Promise<void>((resolve) => server.close(() => resolve()))
  if (process.env.NODE_ENV === 'development') server.closeAllConnections()
  else server.closeIdleConnections()
  await closed
  clearTimeout(forceTimer)
  await Promise.allSettled([processingEvents.close(), assetServer.close(), data.close()])
  // The HMR child keeps an IPC channel open after app resources close.
  if (process.env.REMIX_NODE_HMR) process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
