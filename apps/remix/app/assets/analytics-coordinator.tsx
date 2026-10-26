import { clientEntry, css, ref, type Handle, type SerializableProps } from 'remix/component'
import { sanitizeAnalyticsRoute as sanitizeRoute } from '../routes.ts'
import { workflowSettledEventName, type WorkflowSettlement } from './workflow-analytics.ts'

export const sanitizeAnalyticsRoute = sanitizeRoute

interface AnalyticsProps extends SerializableProps {
  action: string
  csrfToken?: string
  mode?: string
  enabled?: boolean
  nativeWorkflowSettlement?: 'complete' | 'error'
}
type EventPayload = { type: string; at: string; route: string; metadata?: Record<string, string | number | boolean | null> }
type SequenceStorage = Pick<Storage, 'getItem' | 'setItem'>
type PendingWorkflow = { id: string; workflow: string; studyTask?: string; startedAt: number; sourcePath: string }
type AnalyticsRecord = (type: string, metadata?: EventPayload['metadata'], routePath?: string) => void
type DocumentVitalsMeasurementOptions = {
  includeCls?: boolean
  interactionCount?: number
}
type PerformanceEntryWithValue = PerformanceEntry & {
  value?: number
  hadRecentInput?: boolean
  target?: Node | null
  interactionId?: number
}

export const analyticsSequenceStorageKey = 'handover:usability-event-sequence'

export type LayoutShiftMeasurement = {
  startTime: number
  value: number
  hadRecentInput?: boolean
}

export type InteractionLatencyMeasurement = {
  interactionId: number
  duration: number
}

export function createClsSessionWindowTracker() {
  let sessionStart = 0
  let sessionEnd = 0
  let sessionValue = 0
  let maximumValue = 0
  let hasSession = false

  return {
    add(entries: LayoutShiftMeasurement[]) {
      for (let entry of entries) {
        if (entry.hadRecentInput || !Number.isFinite(entry.value) || entry.value < 0) continue
        let continuesSession = hasSession
          && entry.startTime - sessionEnd < 1_000
          && entry.startTime - sessionStart < 5_000
        if (continuesSession) {
          sessionValue += entry.value
          sessionEnd = entry.startTime
        } else {
          sessionStart = entry.startTime
          sessionEnd = entry.startTime
          sessionValue = entry.value
          hasSession = true
        }
        maximumValue = Math.max(maximumValue, sessionValue)
      }
      return maximumValue
    },
    value() {
      return maximumValue
    },
  }
}

export function createInteractionLatencyTracker() {
  let latencyByInteraction = new Map<number, number>()

  return {
    add(entries: InteractionLatencyMeasurement[]) {
      for (let entry of entries) {
        if (!Number.isSafeInteger(entry.interactionId) || entry.interactionId <= 0 || !Number.isFinite(entry.duration) || entry.duration < 0) continue
        latencyByInteraction.set(
          entry.interactionId,
          Math.max(latencyByInteraction.get(entry.interactionId) ?? 0, entry.duration),
        )
      }
      return this.value()
    },
    value(totalInteractionCount = latencyByInteraction.size) {
      let latencies = [...latencyByInteraction.values()].sort((left, right) => right - left)
      if (!latencies.length) return 0
      // Core Web Vitals uses the worst interaction for short visits, then
      // discards one high outlier per 50 interactions (a p98-style estimate).
      let count = Number.isSafeInteger(totalInteractionCount) && totalInteractionCount >= 0
        ? totalInteractionCount
        : latencyByInteraction.size
      let index = Math.min(latencies.length - 1, Math.floor(count / 50))
      return latencies[index] ?? 0
    },
    count() {
      return latencyByInteraction.size
    },
  }
}

export function createDocumentVitalsAccumulator(documentEntryPath: string) {
  let route = sanitizeAnalyticsRoute(documentEntryPath)
  let largestContentfulPaint = 0
  let cls = createClsSessionWindowTracker()
  let inp = createInteractionLatencyTracker()

  return {
    route,
    addLargestContentfulPaint(entries: Array<{ startTime: number }>) {
      for (let entry of entries) largestContentfulPaint = Math.max(largestContentfulPaint, entry.startTime)
    },
    addLayoutShifts(entries: LayoutShiftMeasurement[]) {
      cls.add(entries)
    },
    addInteractions(entries: InteractionLatencyMeasurement[]) {
      inp.add(entries)
    },
    measurements(options: DocumentVitalsMeasurementOptions = {}) {
      let measurements: Array<{ metric: 'lcp' | 'cls' | 'inp'; value: number; durationMs?: number; route: string }> = []
      if (largestContentfulPaint > 0) {
        let value = Math.round(largestContentfulPaint)
        measurements.push({ metric: 'lcp', value, durationMs: value, route })
      }
      if (options.includeCls ?? true) {
        measurements.push({
          metric: 'cls',
          value: Math.round(cls.value() * 10_000) / 10_000,
          route,
        })
      }
      let inpValue = inp.value(options.interactionCount)
      if (inpValue > 0) {
        let value = Math.round(inpValue)
        measurements.push({ metric: 'inp', value, durationMs: value, route })
      }
      return measurements
    },
  }
}

export const AnalyticsCoordinator = clientEntry(import.meta.url + '#AnalyticsCoordinator', function AnalyticsCoordinator(handle: Handle<AnalyticsProps>) {
  return () => handle.props.enabled === false ? null : <span aria-hidden="true" data-usability-collector="remix" mix={[hidden, ref((_node, signal) => installCollector(handle.props, signal))]}></span>
})

function installCollector(config: AnalyticsProps, signal: AbortSignal) {
  let routeStartedAt = performance.now()
  let documentEntryPath = location.pathname
  let activePath = documentEntryPath
  let sequence = createAnalyticsSequenceCounter(sessionStorage)
  let buffer: EventPayload[] = []
  let inFlightBatches = new Set<EventPayload[]>()
  let finalDeliveryBatches = new Set<EventPayload[]>()
  let pendingByForm = new WeakMap<HTMLFormElement, string>()
  let lastClick = { signature: '', at: 0, count: 0 }
  let routeViewRecorded = false
  let finalizing = false
  let stopped = false
  let resizeTimer = 0
  let lastViewport = `${window.innerWidth}x${window.innerHeight}`
  let originalFetch = window.fetch
  let nativeFetch = originalFetch.bind(window)
  let flushTimer = window.setInterval(() => void flush(false), 8_000)

  let record: AnalyticsRecord = (type, metadata, routePath = location.pathname) => {
    if (stopped) return
    buffer.push({ type, at: new Date().toISOString(), route: sanitizeAnalyticsRoute(routePath), metadata: { sequence: sequence.next(), mode: config.mode ?? null, ...metadata } })
    if (!finalizing && buffer.length >= 20) void flush(false)
  }
  let targetMeta = (target: EventTarget | null): Record<string, string | number | boolean | null> => {
    if (!(target instanceof Element)) return {}
    let el = target.closest<HTMLElement>('button,a,input,select,textarea,[role=button]')
    if (!el) return {}
    return {
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      name: el.getAttribute('name'),
      analyticsId: sanitizeTargetIdentifier(el.dataset.analyticsId),
      testId: sanitizeTargetIdentifier(el.dataset.testid),
      type: el.getAttribute('type'),
      textLength: (el.textContent ?? '').trim().length,
    }
  }
  let onClick = (event: MouseEvent) => {
    let meta = targetMeta(event.target)
    let signature = `${meta.tagName}:${meta.analyticsId}:${meta.testId}:${meta.name}`
    let now = performance.now()
    if (signature === lastClick.signature && now - lastClick.at < 1_200) lastClick.count++
    else lastClick = { signature, at: now, count: 1 }
    if (lastClick.count === 3) record('rage_click', { ...meta, count: lastClick.count })
    record('click', meta)
  }
  let onSubmit = (event: SubmitEvent) => {
    let form = event.target instanceof HTMLFormElement ? event.target : null
    let workflow = form?.dataset.workflow
    record('form_submit', { ...targetMeta(event.submitter), action: form ? sanitizeAnalyticsRoute(new URL(form.action || location.href).pathname) : null, workflow: workflow ?? null, studyTask: form?.dataset.studyTask ?? null })
    if (workflow) {
      record('workflow_start', { workflow, studyTask: form?.dataset.studyTask ?? null })
      let attempt: PendingWorkflow = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        workflow,
        studyTask: form?.dataset.studyTask,
        startedAt: Date.now(),
        sourcePath: location.pathname,
      }
      if (form) pendingByForm.set(form, attempt.id)
      writePendingWorkflows([...readPendingWorkflows(), attempt])
    }
  }
  let onInvalid = (event: Event) => record('validation_error', targetMeta(event.target))
  let onFocus = (event: FocusEvent) => { if (isDataEntryTarget(event.target)) record('input_focus', targetMeta(event.target)) }
  let onBlur = (event: FocusEvent) => { if (isDataEntryTarget(event.target)) record('input_blur', targetMeta(event.target)) }
  let onChange = (event: Event) => record('input_change', targetMeta(event.target))
  let onError = (event: ErrorEvent) => record('client_error', clientErrorMetadata(event.error, event.message, event.filename ? sanitizeAnalyticsRoute(new URL(event.filename, location.href).pathname) : 'window-error'))
  let onRejection = (event: PromiseRejectionEvent) => {
    let message = String(event.reason instanceof Error ? event.reason.message : event.reason)
    record('client_error', clientErrorMetadata(event.reason, message, 'unhandled-rejection'))
  }
  let onVisibility = () => record('visibility_change', { state: document.visibilityState })
  let onResize = () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      let viewport = `${window.innerWidth}x${window.innerHeight}`
      if (viewport === lastViewport) return
      lastViewport = viewport
      record('viewport_change', {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        source: 'resize',
      })
    }, 150)
  }
  let onWorkflowSettled = (event: Event) => {
    let detail = (event as CustomEvent<WorkflowSettlement>).detail
    if (!detail?.form || (detail.status !== 'complete' && detail.status !== 'error')) return
    let attemptId = pendingByForm.get(detail.form)
    if (!attemptId) return
    let pending = readPendingWorkflows()
    let attempt = pending.find((item) => item.id === attemptId)
    if (!attempt) return
    record(detail.status === 'complete' ? 'workflow_complete' : 'workflow_error', {
      workflow: attempt.workflow,
      studyTask: attempt.studyTask ?? null,
      durationMs: Date.now() - attempt.startedAt,
      reason: detail.status === 'error' ? 'mutation-failed' : null,
    })
    writePendingWorkflows(pending.filter((item) => item.id !== attemptId))
    pendingByForm.delete(detail.form)
  }

  document.addEventListener('click', onClick, { capture: true, signal })
  document.addEventListener('submit', onSubmit, { capture: true, signal })
  document.addEventListener('invalid', onInvalid, { capture: true, signal })
  document.addEventListener('focusin', onFocus, { capture: true, signal })
  document.addEventListener('focusout', onBlur, { capture: true, signal })
  document.addEventListener('change', onChange, { capture: true, signal })
  document.addEventListener(workflowSettledEventName, onWorkflowSettled, { signal })
  document.addEventListener('visibilitychange', onVisibility, { signal })
  window.addEventListener('error', onError, { signal })
  window.addEventListener('unhandledrejection', onRejection, { signal })
  window.addEventListener('resize', onResize, { signal })
  window.addEventListener('popstate', () => recordRouteView(), { signal })
  window.addEventListener('hashchange', () => recordRouteView(), { signal })
  let performanceObservers = installPerformanceObservers(record, targetMeta, documentEntryPath)
  let restoreFetch = installFetchObserver(config.action, originalFetch, nativeFetch, record)
  let restoreConsoleError = installConsoleErrorObserver(record)
  let routeObserver = new MutationObserver(() => queueMicrotask(recordRouteView))
  routeObserver.observe(document.documentElement, { childList: true, subtree: true })
  window.addEventListener('pagehide', (event) => {
    if (stopped) {
      void flush(true)
      return
    }
    finalizing = true
    performanceObservers.report()
    recordActiveRouteDuration()
    void flush(true)
    if (!event.persisted) stopped = true
  }, { signal })
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      performanceObservers.restart(location.pathname)
      finalizing = false
      stopped = false
    }
    recordRouteView()
  }, { signal })

  function recordRouteView() {
    let nextPath = location.pathname
    if (routeViewRecorded && nextPath === activePath) return
    recordActiveRouteDuration()
    let previousPath = activePath
    routeViewRecorded = true
    activePath = nextPath
    routeStartedAt = performance.now()
    let viewKey = `${performance.timeOrigin}:${nextPath}`
    if (sessionStorage.getItem('handover:last-route-view') !== viewKey) {
      sessionStorage.setItem('handover:last-route-view', viewKey)
      record('route_change', {
        referrerPath: previousPath !== nextPath ? sanitizeAnalyticsRoute(previousPath) : safeReferrerPath(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }, nextPath)
    }
    let pending = readPendingWorkflows()
    let settlement = config.nativeWorkflowSettlement
    if (settlement && pending.length) {
      // A native navigation can submit only one form. Settle the most recent
      // attempt using the server-provided result and leave unrelated attempts
      // intact instead of treating every new document as success.
      let attempt = pending[pending.length - 1]!
      record(settlement === 'complete' ? 'workflow_complete' : 'workflow_error', {
        workflow: attempt.workflow,
        studyTask: attempt.studyTask ?? null,
        durationMs: Date.now() - attempt.startedAt,
        reason: settlement === 'error' ? 'mutation-failed' : null,
      })
      writePendingWorkflows(pending.slice(0, -1))
    }
  }

  function recordActiveRouteDuration() {
    if (!routeViewRecorded || stopped) return
    record('route_duration', { durationMs: Math.round(performance.now() - routeStartedAt) }, activePath)
    routeViewRecorded = false
  }

  queueMicrotask(() => {
    // Hydration commonly runs after the initial pageshow event, so record the
    // first view explicitly while retaining pageshow for bfcache restores.
    recordRouteView()
    let timingKey = String(performance.timeOrigin)
    if (sessionStorage.getItem('handover:last-page-load-time-origin') !== timingKey) {
      sessionStorage.setItem('handover:last-page-load-time-origin', timingKey)
      let nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      record('page_load_timing', nav ? { domInteractiveMs: Math.round(nav.domInteractive), loadMs: Math.round(nav.loadEventEnd), responseMs: Math.round(nav.responseEnd) } : undefined)
    }
  })

  signal.addEventListener('abort', () => {
    finalizing = true
    clearInterval(flushTimer)
    clearTimeout(resizeTimer)
    routeObserver.disconnect()
    restoreFetch()
    restoreConsoleError()
    performanceObservers.report()
    performanceObservers.disconnect()
    recordActiveRouteDuration()
    void flush(true)
    stopped = true
  }, { once: true })

  async function flush(unloading: boolean) {
    if (unloading) {
      let activeBatches = [...inFlightBatches]
      for (let batch of activeBatches) finalDeliveryBatches.add(batch)
      let events = [...activeBatches.flat(), ...buffer.splice(0)]
      for (let offset = 0; offset < events.length; offset += 50) {
        let batch = events.slice(offset, offset + 50)
        let data = analyticsFormData(batch, config.csrfToken)
        if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(config.action, data)) continue
        try {
          let response = await nativeFetch(config.action, { method: 'POST', body: data, credentials: 'same-origin', keepalive: true })
          if (!response.ok) throw new Error(`Analytics request failed (${response.status})`)
        } catch {
          if (!stopped) buffer.unshift(...batch)
        }
      }
      return
    }

    if (finalizing || stopped || !buffer.length) return
    let events = buffer.splice(0, 50)
    inFlightBatches.add(events)
    let data = analyticsFormData(events, config.csrfToken)
    try {
      let response = await nativeFetch(config.action, { method: 'POST', body: data, credentials: 'same-origin', signal })
      if (!response.ok) throw new Error(`Analytics request failed (${response.status})`)
    } catch {
      if (!finalDeliveryBatches.has(events) && !finalizing && !stopped) buffer.unshift(...events)
    } finally {
      inFlightBatches.delete(events)
      finalDeliveryBatches.delete(events)
    }
  }
}

function analyticsFormData(events: EventPayload[], csrfToken?: string) {
  let data = new FormData()
  data.set('events', JSON.stringify(events))
  if (csrfToken) data.set('_csrf', csrfToken)
  return data
}

function installFetchObserver(
  analyticsAction: string,
  originalFetch: typeof window.fetch,
  nativeFetch: typeof window.fetch,
  record: AnalyticsRecord,
) {
  let analyticsPath = new URL(analyticsAction, location.href).pathname
  let observedFetch: typeof window.fetch = async (input, init) => {
    let rawUrl = input instanceof Request ? input.url : String(input)
    let url: URL
    try { url = new URL(rawUrl, location.href) } catch { return nativeFetch(input, init) }
    if (url.origin !== location.origin || url.pathname === analyticsPath) return nativeFetch(input, init)

    let method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase().slice(0, 12)
    let path = sanitizeAnalyticsRoute(url.pathname)
    let requestRoute = location.pathname
    let startedAt = performance.now()
    try {
      let response = await nativeFetch(input, init)
      let durationMs = Math.max(0, Math.round(performance.now() - startedAt))
      record(response.ok ? 'api_request' : 'api_error', {
        action: path,
        path,
        method,
        status: response.status,
        durationMs,
        reason: response.ok ? null : 'http-error',
      }, requestRoute)
      return response
    } catch (error) {
      record('api_error', {
        action: path,
        path,
        method,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        reason: error instanceof DOMException && error.name === 'AbortError' ? 'aborted' : 'network-error',
      }, requestRoute)
      throw error
    }
  }
  window.fetch = observedFetch
  return () => {
    if (window.fetch === observedFetch) window.fetch = originalFetch
  }
}

function installConsoleErrorObserver(record: AnalyticsRecord) {
  let originalConsoleError = console.error
  let observedConsoleError = (...values: unknown[]) => {
    let error = values.find((value) => value instanceof Error)
    let messageLength = values.reduce<number>((total, value) => total + String(value instanceof Error ? value.message : value).length, 0)
    record('client_error', clientErrorMetadata(error, ''.padEnd(Math.min(10_000, messageLength)), 'console-error'))
    originalConsoleError.apply(console, values)
  }
  console.error = observedConsoleError
  return () => {
    if (console.error === observedConsoleError) console.error = originalConsoleError
  }
}

function clientErrorMetadata(error: unknown, message: string, source: string): EventPayload['metadata'] {
  let errorName = error instanceof Error || error instanceof DOMException ? error.name : null
  let errorCategory = error instanceof DOMException
    ? 'dom-exception'
    : error instanceof Error
      ? 'runtime-error'
      : 'unknown-client-error'
  return {
    messageLength: Math.min(10_000, message.length),
    source,
    errorName: errorName?.slice(0, 80) ?? null,
    errorCategory,
  }
}

function installPerformanceObservers(
  record: AnalyticsRecord,
  targetMeta: (target: EventTarget | null) => Record<string, string | number | boolean | null>,
  documentEntryPath: string,
) {
  let observers: Array<{
    observer: PerformanceObserver
    addEntries: (entries: PerformanceEntryWithValue[]) => void
  }> = []
  let vitals = createDocumentVitalsAccumulator(documentEntryPath)
  let reported = false
  let interactionCountBaseline = 0
  let supported = globalThis.PerformanceObserver?.supportedEntryTypes ?? []

  let observe = (type: string, callback: (entries: PerformanceEntryWithValue[]) => void, options: Record<string, unknown> = {}) => {
    if (!supported.includes(type)) return false
    let observer = new PerformanceObserver((list) => callback(list.getEntries() as PerformanceEntryWithValue[]))
    try {
      observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit)
      observers.push({ observer, addEntries: callback })
      return true
    } catch {
      observer.disconnect()
      return false
    }
  }

  observe('largest-contentful-paint', (entries) => {
    vitals.addLargestContentfulPaint(entries)
  })
  let includeCls = observe('layout-shift', (entries) => {
    vitals.addLayoutShifts(entries.flatMap((entry) =>
      typeof entry.value === 'number'
        ? [{ startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput }]
        : [],
    ))
  })
  observe('longtask', (entries) => {
    for (let entry of entries) {
      record('long_task', {
        durationMs: Math.round(entry.duration),
        source: 'performance-observer',
      })
    }
  })
  observe('event', (entries) => {
    vitals.addInteractions(entries.flatMap((entry) =>
      typeof entry.interactionId === 'number'
        ? [{ interactionId: entry.interactionId, duration: entry.duration }]
        : [],
    ))
    for (let entry of entries) {
      if (entry.duration >= 200) {
        record('slow_interaction', {
          ...targetMeta(entry.target ?? null),
          durationMs: Math.round(entry.duration),
          source: 'performance-observer',
        })
      }
    }
  }, { durationThreshold: 40 })

  let report = () => {
    if (reported) return
    reported = true
    for (let registration of observers) {
      registration.addEntries(registration.observer.takeRecords() as PerformanceEntryWithValue[])
    }
    let interactionCount = readPerformanceInteractionCount()
    for (let measurement of vitals.measurements({
      includeCls,
      interactionCount: interactionCount == null ? undefined : Math.max(0, interactionCount - interactionCountBaseline),
    })) {
      record('web_vital', {
        metric: measurement.metric,
        value: measurement.value,
        durationMs: measurement.durationMs ?? null,
      }, measurement.route)
    }
  }

  return {
    report,
    restart(entryPath: string) {
      for (let registration of observers) registration.observer.takeRecords()
      vitals = createDocumentVitalsAccumulator(entryPath)
      interactionCountBaseline = readPerformanceInteractionCount() ?? 0
      reported = false
    },
    disconnect() {
      for (let registration of observers) registration.observer.disconnect()
    },
  }
}

function readPerformanceInteractionCount() {
  let count = (performance as Performance & { interactionCount?: number }).interactionCount
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function readPendingWorkflows(): PendingWorkflow[] {
  let raw = sessionStorage.getItem('handover:pending-workflows')
  if (!raw) {
    // Read the pre-migration singleton once so an in-flight native form is not lost.
    raw = sessionStorage.getItem('handover:pending-workflow')
    sessionStorage.removeItem('handover:pending-workflow')
    if (raw) raw = `[${raw}]`
  }
  if (!raw) return []
  try {
    let value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is PendingWorkflow => item && typeof item.id === 'string' && typeof item.workflow === 'string' && typeof item.startedAt === 'number' && typeof item.sourcePath === 'string')
  } catch { return [] }
}

function writePendingWorkflows(items: PendingWorkflow[]) {
  if (items.length) sessionStorage.setItem('handover:pending-workflows', JSON.stringify(items))
  else sessionStorage.removeItem('handover:pending-workflows')
}

export function createAnalyticsSequenceCounter(storage: SequenceStorage) {
  let local = readStoredSequence(storage)
  return {
    next(): number {
      // Re-read on every event so overlapping collector instances cannot each
      // advance from the same setup-time snapshot.
      local = Math.max(local, readStoredSequence(storage)) + 1
      storage.setItem(analyticsSequenceStorageKey, String(local))
      return local
    },
    current(): number {
      return Math.max(local, readStoredSequence(storage))
    },
  }
}

function readStoredSequence(storage: SequenceStorage): number {
  let raw = storage.getItem(analyticsSequenceStorageKey)
  if (raw == null || !/^\d+$/.test(raw)) return 0
  let value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function sanitizeTargetIdentifier(value: string | undefined): string | null {
  if (!value) return null
  let normalized = value.trim().slice(0, 120)
  if (!/^[a-zA-Z0-9:_-]+$/.test(normalized)) return null
  let dynamicPrefix = [
    'patient-card',
    'patient-task-row',
    'handover-row',
    'shift-card',
    'sheet-field',
    'task-toggle',
    'task-edit',
    'task-delete',
    'task-due-picker',
    'task-reminder',
    'task-status',
    'checklist-toggle',
    'new-task-due-picker-day',
  ].find((prefix) => normalized.startsWith(`${prefix}-`))
  if (dynamicPrefix) return `${dynamicPrefix}-:id`
  if (/\d{4}-\d{2}-\d{2}/.test(normalized)) return normalized.replace(/\d{4}-\d{2}-\d{2}.*/, ':id')
  if (/[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(normalized)) return normalized.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/i, ':id')
  return normalized
}

function isDataEntryTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
}

function safeReferrerPath() { try { return document.referrer ? sanitizeAnalyticsRoute(new URL(document.referrer).pathname) : null } catch { return null } }
const hidden = css({ position: 'fixed', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' })
