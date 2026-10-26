import { clientEntry, ref, type Handle, type SerializableProps } from 'remix/component'

import { RECORDING_STATUS_EVENT, type RecordingStatusDetail } from './recording-events.ts'
import { PROCESSING_WAKE_EVENT } from './processing-events.ts'

interface ProcessingProps extends SerializableProps {
  stateHref: string
  eventsHref?: string
  intervalMs?: number
  reconcileMs?: number
}

type ProcessingItem = {
  id: string
  status: string
  href: string
  revision: number
  updatedAt: string
  readiness: string
  relevant: boolean
}

function processingItemRevision(item: ProcessingItem): string {
  return `${item.status}:${item.revision}:${item.readiness}`
}

/**
 * Coalesces wake-ups without losing one that arrives during an in-flight poll.
 * The next poll runs immediately before the slower recovery interval resumes.
 */
export function createProcessingPollGate(schedule: (delay: number) => void) {
  let polling = false
  let requested = false
  return {
    start() {
      if (polling) {
        requested = true
        return false
      }
      polling = true
      return true
    },
    request(delay = 0) {
      if (polling) {
        requested = true
        return
      }
      schedule(delay)
    },
    finish(continuationDelay?: number) {
      polling = false
      if (requested) {
        requested = false
        schedule(0)
      } else if (continuationDelay !== undefined) {
        schedule(continuationDelay)
      }
    },
  }
}

/**
 * Discovers active work, then tracks only those ids through one terminal
 * observation. Processing feedback belongs to the relevant workspace rather
 * than a global overlay; terminal changes simply refresh that workspace.
 */
export const ProcessingCoordinator = clientEntry(
  import.meta.url + '#ProcessingCoordinator',
  function ProcessingCoordinator(handle: Handle<ProcessingProps>) {
    let initialized = false

    return () => <span hidden aria-hidden="true" data-testid="processing-coordinator" mix={ref((node, signal) => {
        if (initialized) return
        initialized = true
        let tracked = new Map<string, ProcessingItem>()
        // Active handovers are also marked in the server-rendered workspace.
        // Seeding them here closes the race where a job becomes terminal after
        // SSR but before this coordinator's first poll: tracked terminal rows
        // are deliberately returned by the resource so the stale Frame can be
        // refreshed exactly once.
        let seeded = new Set<string>()
        let timer: number | undefined
        let submittingForms = new Set<string>()
        let eventSource: EventSource | null = null
        let sseAvailable = Boolean(handle.props.eventsHref && typeof EventSource !== 'undefined')
        node.dataset.processingTransport = sseAvailable ? 'sse' : 'poll'
        let nextReconciliationDelay = () => sseAvailable
          ? handle.props.reconcileMs ?? 15_000
          : handle.props.intervalMs ?? 1_000

        let seedRenderedHandovers = () => {
          for (let marker of document.querySelectorAll<HTMLElement>(
            '[data-processing-handover-id][data-processing-active="true"]',
          )) {
            let id = marker.getAttribute('data-processing-handover-id')
            if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !tracked.has(id)) seeded.add(id)
          }
        }

        let schedule = (delay: number) => {
          if (signal.aborted) return
          if (timer !== undefined) window.clearTimeout(timer)
          timer = window.setTimeout(poll, delay)
        }

        // Do not discard an SSE wake-up that arrives while the authoritative
        // state request is still in flight. The response may have been read
        // just before the transaction that emitted the notification committed;
        // without this latch the UI can remain stale until the recovery poll.
        let pollGate = createProcessingPollGate(schedule)

        let poll = async () => {
          if (signal.aborted) return
          if (!pollGate.start()) return
          let continuationDelay: number | undefined
          try {
            seedRenderedHandovers()
            let requestUrl = new URL(handle.props.stateHref, window.location.origin)
            requestUrl.searchParams.set('path', window.location.pathname)
            for (let id of new Set([...tracked.keys(), ...seeded])) requestUrl.searchParams.append('track', id)
            let response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
              cache: 'no-store',
              headers: { Accept: 'application/json' },
              signal,
            })
            if (!response.ok) throw new Error(String(response.status))
            let payload = await response.json() as { items?: ProcessingItem[] }
            let items = Array.isArray(payload.items) ? payload.items : []
            let returnedIds = new Set(items.map((item) => item.id))
            let relevantRevisionChanged = false
            for (let item of items) {
              let previous = tracked.get(item.id)
              let wasSeeded = seeded.delete(item.id)
              let active = item.status === 'queued' || item.status === 'transcribing' || item.status === 'analysing'
              if (active) {
                if (previous && processingItemRevision(previous) !== processingItemRevision(item) && item.relevant) {
                  relevantRevisionChanged = true
                }
                // An active row without a matching server-rendered marker
                // started after this workspace document was rendered. Refresh
                // once so controls and processing feedback immediately reflect
                // the newly queued/recommenced handover.
                if (!previous && !wasSeeded && item.relevant) relevantRevisionChanged = true
                tracked.set(item.id, item)
                continue
              }
              if (!previous && !wasSeeded) continue
              tracked.delete(item.id)
              if (item.relevant) relevantRevisionChanged = true
            }

            for (let [id, previous] of [...tracked]) {
              if (returnedIds.has(id)) continue
              tracked.delete(id)
              if (previous.relevant) relevantRevisionChanged = true
            }

            for (let id of [...seeded]) {
              if (returnedIds.has(id)) continue
              seeded.delete(id)
              // The current workspace rendered this handover as active, so a
              // missing row is itself a terminal/removal transition.
              relevantRevisionChanged = true
            }

            if (relevantRevisionChanged && !signal.aborted) await handle.frames.get('workspace')?.reload()
            // SSE is the low-latency trigger. This slower reconciliation closes
            // gaps caused by a dropped notification or listener outage.
            if (tracked.size || seeded.size) continuationDelay = nextReconciliationDelay()
          } catch {
            // Transient monitor failures are intentionally silent. EventSource
            // reconnects independently and the next reconciliation retries.
            if (tracked.size || seeded.size) continuationDelay = Math.min(nextReconciliationDelay(), 10_000)
          } finally {
            pollGate.finish(signal.aborted ? undefined : continuationDelay)
          }
        }

        if (sseAvailable && handle.props.eventsHref) {
          eventSource = new EventSource(handle.props.eventsHref)
          let reconcile = () => pollGate.request()
          eventSource.addEventListener('ready', reconcile)
          eventSource.addEventListener('processing', reconcile)
          eventSource.addEventListener('error', () => {
            // EventSource reconnects automatically; reconcile soon in case the
            // connection dropped immediately after a committed transition.
            if (tracked.size || seeded.size) pollGate.request(2_000)
          })
        }
        void poll()
        let onRecordingStatus = (event: Event) => {
          let detail = (event as CustomEvent<RecordingStatusDetail>).detail
          if (!detail?.formId) return
          if (detail.status === 'submitting') submittingForms.add(detail.formId)
          if (detail.status === 'error') submittingForms.delete(detail.formId)
          if (detail.status === 'idle' && submittingForms.delete(detail.formId)) pollGate.request()
        }
        window.addEventListener(RECORDING_STATUS_EVENT, onRecordingStatus)
        let onProcessingWake = () => pollGate.request()
        window.addEventListener(PROCESSING_WAKE_EVENT, onProcessingWake)
        signal.addEventListener('abort', () => {
          if (timer !== undefined) window.clearTimeout(timer)
          eventSource?.close()
          window.removeEventListener(RECORDING_STATUS_EVENT, onRecordingStatus)
          window.removeEventListener(PROCESSING_WAKE_EVENT, onProcessingWake)
        }, { once: true })
      })} />
  },
)
