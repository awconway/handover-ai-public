import { Client, type ClientConfig, type Notification } from 'pg'
import { sql, type Database } from 'remix/data-table'

export const HANDOVER_PROCESSING_CHANNEL = 'handover_processing_changed'

type ListenerConnectionConfig = string | ClientConfig

type ListenerClient = {
  connect(): Promise<unknown>
  query(statement: string): Promise<unknown>
  end(): Promise<void>
  on(event: 'notification', listener: (message: Notification) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'end', listener: () => void): unknown
  removeListener(event: 'notification', listener: (message: Notification) => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'end', listener: () => void): unknown
}

export type HandoverProcessingChangeListener = (handoverId: string | null) => void

export type HandoverProcessingChanges = {
  start(): Promise<void>
  subscribe(listener: HandoverProcessingChangeListener): () => void
  close(): Promise<void>
}

type ProcessingChangeOptions = {
  reconnectMs?: number
  onUnavailable?: (error: unknown) => void
  createClient?: (config: ListenerConnectionConfig) => ListenerClient
}

/** Emits only after the caller's transaction commits. */
export async function notifyHandoverProcessingChanged(db: Database, handoverId: string): Promise<void> {
  await db.exec(sql`select pg_notify(${HANDOVER_PROCESSING_CHANNEL}, ${handoverId})`)
}

/**
 * Shares one dedicated PostgreSQL LISTEN connection across all SSE clients in
 * this web process. A null notification asks subscribers to reconcile after a
 * listener reconnect, closing the gap left by notifications missed offline.
 */
export function createHandoverProcessingChanges(
  config: ListenerConnectionConfig,
  options: ProcessingChangeOptions = {},
): HandoverProcessingChanges {
  let reconnectMs = options.reconnectMs ?? 1_000
  if (!Number.isSafeInteger(reconnectMs) || reconnectMs <= 0) {
    throw new RangeError('reconnectMs must be a positive integer')
  }

  let client: ListenerClient | null = null
  let listeningClient: ListenerClient | null = null
  let connecting: Promise<void> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closing: Promise<void> | null = null
  let closed = false
  let unavailableReported = false
  let endedClients = new WeakSet<object>()
  let listeners = new Set<HandoverProcessingChangeListener>()
  let createClient = options.createClient
    ?? ((connectionConfig: ListenerConnectionConfig) => new Client(connectionConfig) as unknown as ListenerClient)

  function publish(handoverId: string | null) {
    for (let listener of [...listeners]) {
      try { listener(handoverId) } catch { /* One stream cannot break the shared listener. */ }
    }
  }

  function handleNotification(message: Notification) {
    if (message.channel !== HANDOVER_PROCESSING_CHANNEL || closed) return
    let handoverId = message.payload?.trim() ?? ''
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(handoverId)) return
    publish(handoverId)
  }

  function detach(activeClient: ListenerClient) {
    activeClient.removeListener('notification', handleNotification)
    activeClient.removeListener('error', handleError)
    activeClient.removeListener('end', handleEnd)
  }

  function invalidate(activeClient: ListenerClient) {
    detach(activeClient)
    if (client === activeClient) client = null
    if (listeningClient === activeClient) listeningClient = null
  }

  async function end(activeClient: ListenerClient) {
    invalidate(activeClient)
    if (endedClients.has(activeClient)) return
    endedClients.add(activeClient)
    try { await activeClient.end() } catch { /* The socket may already be closed. */ }
  }

  function scheduleReconnect(error?: unknown) {
    if (closed || reconnectTimer) return
    if (error !== undefined && !unavailableReported) {
      unavailableReported = true
      options.onUnavailable?.(error)
    }
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null
      let activeSetup = connecting
      if (activeSetup) await activeSetup
      if (!closed && !client) await connect()
    }, reconnectMs)
    reconnectTimer.unref?.()
  }

  function handleError(error: Error) {
    let activeClient = client
    if (activeClient) void end(activeClient)
    scheduleReconnect(error)
  }

  function handleEnd() {
    let activeClient = client
    if (activeClient) {
      endedClients.add(activeClient)
      invalidate(activeClient)
    }
    scheduleReconnect(new Error('PostgreSQL processing listener connection ended.'))
  }

  async function connect(): Promise<void> {
    if (closed || client || connecting) return connecting ?? Promise.resolve()
    let setup = Promise.resolve().then(async () => {
      let nextClient: ListenerClient | null = null
      try {
        nextClient = createClient(config)
        client = nextClient
        nextClient.on('notification', handleNotification)
        nextClient.on('error', handleError)
        nextClient.on('end', handleEnd)
        await nextClient.connect()
        if (closed || client !== nextClient) return
        await nextClient.query(`listen ${HANDOVER_PROCESSING_CHANNEL}`)
        if (closed || client !== nextClient) return
        listeningClient = nextClient
        unavailableReported = false
        publish(null)
      } catch (error) {
        if (nextClient && client === nextClient) await end(nextClient)
        scheduleReconnect(error)
      } finally {
        if (connecting === setup) connecting = null
      }
    })
    connecting = setup
    return setup
  }

  return {
    async start() {
      await connect()
    },

    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    close() {
      if (closing) return closing
      closed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      closing = (async () => {
        let activeClient = client
        if (activeClient && listeningClient !== activeClient) await end(activeClient)
        await connecting
        activeClient = client
        if (activeClient) {
          try { await activeClient.query(`unlisten ${HANDOVER_PROCESSING_CHANNEL}`) }
          catch { /* Ending the connection is sufficient during shutdown. */ }
          finally { await end(activeClient) }
        }
        listeners.clear()
      })()
      return closing
    },
  }
}
