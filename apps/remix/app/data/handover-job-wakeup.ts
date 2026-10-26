import { Client, type ClientConfig, type Notification } from 'pg'
import { sql, type Database } from 'remix/data-table'

export const HANDOVER_JOB_QUEUE_CHANNEL = 'handover_jobs_queued'

export type HandoverJobWakeResult = 'notified' | 'timeout' | 'closed'

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

type WakeupOptions = {
  reconnectMs?: number
  onUnavailable?: (error: unknown) => void
  createClient?: (config: ListenerConnectionConfig) => ListenerClient
}

type Waiter = {
  finish(result: HandoverJobWakeResult): void
}

/**
 * Emits the queue signal from the caller's transaction. PostgreSQL delivers a
 * NOTIFY only after that transaction commits, so a worker can never wake for
 * a job that later rolls back.
 */
export async function notifyHandoverJobQueued(db: Database, jobId: string): Promise<void> {
  await db.exec(sql`select pg_notify(${HANDOVER_JOB_QUEUE_CHANNEL}, ${jobId})`)
}

/**
 * Keeps one dedicated PostgreSQL session listening for queue notifications.
 * Notifications only reduce claim latency: timed waits remain authoritative
 * when LISTEN is unavailable, a notification is lost, or the connection is
 * being re-established.
 */
export function createHandoverJobQueueWakeup(config: ListenerConnectionConfig, options: WakeupOptions = {}) {
  let reconnectMs = options.reconnectMs ?? 1_000
  if (!Number.isSafeInteger(reconnectMs) || reconnectMs <= 0) {
    throw new RangeError('reconnectMs must be a positive integer')
  }

  let client: ListenerClient | null = null
  let listeningClient: ListenerClient | null = null
  let connecting: Promise<void> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let waiter: Waiter | null = null
  let closing: Promise<void> | null = null
  let pending = false
  let closed = false
  let unavailableReported = false
  let endedClients = new WeakSet<object>()
  let createClient = options.createClient
    ?? ((connectionConfig: ListenerConnectionConfig) => new Client(connectionConfig) as unknown as ListenerClient)

  function finishWait(result: HandoverJobWakeResult) {
    let active = waiter
    waiter = null
    active?.finish(result)
  }

  function handleNotification(message: Notification) {
    if (message.channel !== HANDOVER_JOB_QUEUE_CHANNEL || closed) return
    if (waiter) finishWait('notified')
    else pending = true
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
    try {
      await activeClient.end()
    } catch {
      // A connection that emitted error may already have closed its socket.
    }
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
    scheduleReconnect(new Error('PostgreSQL queue listener connection ended.'))
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
        await nextClient.query(`listen ${HANDOVER_JOB_QUEUE_CHANNEL}`)
        // An error/end event may have invalidated this candidate while LISTEN
        // was pending even if a driver or test double subsequently resolves it.
        if (closed || client !== nextClient) return
        listeningClient = nextClient
        unavailableReported = false
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
    async start(): Promise<void> {
      await connect()
    },

    wait(timeoutMs: number): Promise<HandoverJobWakeResult> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(new RangeError('timeoutMs must be a positive integer'))
      }
      if (closed) return Promise.resolve('closed')
      if (pending) {
        pending = false
        return Promise.resolve('notified')
      }
      if (waiter) return Promise.reject(new Error('Only one queue wake wait may be active.'))

      return new Promise((resolve) => {
        let timer = setTimeout(() => {
          if (waiter === current) waiter = null
          resolve('timeout')
        }, timeoutMs)
        let current: Waiter = {
          finish(result) {
            clearTimeout(timer)
            resolve(result)
          },
        }
        waiter = current
      })
    },

    close(): Promise<void> {
      if (closing) return closing
      closed = true
      pending = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      finishWait('closed')
      closing = (async () => {
        // End an in-flight candidate before awaiting setup so shutdown cannot
        // hang behind a connection or LISTEN request that has stopped making progress.
        let activeClient = client
        if (activeClient && listeningClient !== activeClient) await end(activeClient)
        await connecting
        activeClient = client
        if (!activeClient) return
        try {
          await activeClient.query(`unlisten ${HANDOVER_JOB_QUEUE_CHANNEL}`)
        } catch {
          // Ending the dedicated connection is sufficient during shutdown.
        } finally {
          await end(activeClient)
        }
      })()
      return closing
    },
  }
}
