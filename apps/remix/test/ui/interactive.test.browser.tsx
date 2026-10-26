import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { type Handle, type RemixNode } from 'remix/component'
import { render } from 'remix/component/test'

import { ChecklistEditor } from '../../app/assets/checklist-editor.tsx'
import { RichTextEditor } from '../../app/assets/rich-text-editor.tsx'
import { AnalyticsCoordinator } from '../../app/assets/analytics-coordinator.tsx'
import { settleEnhancedWorkflow } from '../../app/assets/workflow-analytics.ts'
import { routes } from '../../app/routes.ts'
import { frameMutationRequestHeader, frameMutationRequestValue } from '../../app/utils/frame-mutation.ts'

function ChecklistFrameHarness(handle: Handle<{ children?: RemixNode; reload: () => Promise<AbortSignal> }>) {
  handle.frame.src = `${window.location.origin}${routes.workspace.handover.href({ handoverId: 'checklist' })}`
  handle.frame.reload = () => handle.props.reload()
  return () => handle.props.children
}

type CapturedAnalyticsEvent = {
  type: string
  route: string
  metadata?: Record<string, unknown>
}

function installMockPerformanceObserver(supportedEntryTypes: string[]) {
  let originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'PerformanceObserver')
  let instances: Array<{ type?: string; records: PerformanceEntry[] }> = []

  class MockPerformanceObserver {
    static supportedEntryTypes = supportedEntryTypes
    type?: string
    records: PerformanceEntry[] = []

    constructor(_callback: PerformanceObserverCallback) {
      instances.push(this)
    }

    observe(options: PerformanceObserverInit) {
      this.type = (options as PerformanceObserverInit & { type?: string }).type
    }

    takeRecords() {
      return this.records.splice(0)
    }

    disconnect() {}
  }

  Object.defineProperty(globalThis, 'PerformanceObserver', {
    configurable: true,
    writable: true,
    value: MockPerformanceObserver,
  })

  return {
    queue(type: string, entries: Array<Record<string, unknown>>) {
      let observer = instances.find((candidate) => candidate.type === type)
      assert.ok(observer)
      observer.records.push(...entries as unknown as PerformanceEntry[])
    },
    restore() {
      if (originalDescriptor) Object.defineProperty(globalThis, 'PerformanceObserver', originalDescriptor)
      else Reflect.deleteProperty(globalThis, 'PerformanceObserver')
    },
  }
}

describe('hydrated clinical controls', () => {
  it('does not mount the collector when analytics is disabled', () => {
    let result = render(<AnalyticsCoordinator action={routes.resources.analytics.href()} enabled={false} />)
    assert.equal(result.$('[data-usability-collector="remix"]'), null)
    result.cleanup()
  })

  it('includes an in-flight threshold batch in final abort delivery', async () => {
    let originalFetch = window.fetch
    let originalSendBeacon = navigator.sendBeacon
    let batches: CapturedAnalyticsEvent[][] = []
    let abortedRequests = 0
    window.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      let rejectAsAborted = () => {
        abortedRequests++
        reject(new DOMException('Collector stopped', 'AbortError'))
      }
      if (init?.signal?.aborted) rejectAsAborted()
      else init?.signal?.addEventListener('abort', rejectAsAborted, { once: true })
    })
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    sessionStorage.clear()

    try {
      let result = render(<div>
        <AnalyticsCoordinator action={routes.resources.analytics.href()} />
        <button>Exercise collector</button>
      </div>)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      await result.act(() => {
        for (let index = 0; index < 25; index++) result.$('button')?.click()
      })
      result.cleanup()
      await new Promise((resolve) => setTimeout(resolve, 0))

      assert.ok(abortedRequests >= 1)
      assert.equal(batches.flat().filter((event) => event.type === 'click').length, 25)
      assert.equal(batches.flat().filter((event) => event.type === 'route_duration').length, 1)
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      window.fetch = originalFetch
      sessionStorage.clear()
    }
  })

  it('drains final observer records, uses total interactions for INP, and omits unsupported CLS', async () => {
    let originalSendBeacon = navigator.sendBeacon
    let interactionCountDescriptor = Object.getOwnPropertyDescriptor(performance, 'interactionCount')
    let performanceObservers = installMockPerformanceObserver(['largest-contentful-paint', 'event'])
    let batches: CapturedAnalyticsEvent[][] = []
    Object.defineProperty(performance, 'interactionCount', { configurable: true, value: 50 })
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    sessionStorage.clear()

    try {
      let result = render(<AnalyticsCoordinator action={routes.resources.analytics.href()} />)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      performanceObservers.queue('largest-contentful-paint', [{
        name: 'largest-contentful-paint',
        entryType: 'largest-contentful-paint',
        startTime: 712.6,
        duration: 0,
      }])
      performanceObservers.queue('event', [
        { name: 'click', entryType: 'event', startTime: 100, duration: 250, interactionId: 1 },
        { name: 'keydown', entryType: 'event', startTime: 200, duration: 200, interactionId: 2 },
      ])
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))

      let vitals = batches.flat().filter((event) => event.type === 'web_vital')
      assert.ok(vitals.some((event) => event.metadata?.metric === 'lcp' && event.metadata?.value === 713))
      assert.ok(vitals.some((event) => event.metadata?.metric === 'inp' && event.metadata?.value === 200))
      assert.equal(vitals.some((event) => event.metadata?.metric === 'cls'), false)
      result.cleanup()
      assert.equal(batches.flat().filter((event) => event.type === 'route_duration').length, 1)
    } finally {
      performanceObservers.restore()
      if (interactionCountDescriptor) Object.defineProperty(performance, 'interactionCount', interactionCountDescriptor)
      else Reflect.deleteProperty(performance, 'interactionCount')
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      sessionStorage.clear()
    }
  })

  it('starts a fresh vitals accumulator after a BFCache restoration', async () => {
    let originalSendBeacon = navigator.sendBeacon
    let performanceObservers = installMockPerformanceObserver(['layout-shift'])
    let batches: CapturedAnalyticsEvent[][] = []
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    sessionStorage.clear()

    try {
      let result = render(<AnalyticsCoordinator action={routes.resources.analytics.href()} />)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      performanceObservers.queue('layout-shift', [{
        name: 'layout-shift',
        entryType: 'layout-shift',
        startTime: 100,
        duration: 0,
        value: 0.1,
        hadRecentInput: false,
      }])
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
      performanceObservers.queue('layout-shift', [{
        name: 'layout-shift',
        entryType: 'layout-shift',
        startTime: 200,
        duration: 0,
        value: 0.2,
        hadRecentInput: false,
      }])
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))

      assert.deepEqual(
        batches.flat()
          .filter((event) => event.type === 'web_vital' && event.metadata?.metric === 'cls')
          .map((event) => event.metadata?.value),
        [0.1, 0.2],
      )
      result.cleanup()
    } finally {
      performanceObservers.restore()
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      sessionStorage.clear()
    }
  })

  it('attributes API telemetry to the route where the request started', async () => {
    let originalFetch = window.fetch
    let originalSendBeacon = navigator.sendBeacon
    let originalPath = `${location.pathname}${location.search}${location.hash}`
    let batches: CapturedAnalyticsEvent[][] = []
    let resolveRequest: ((response: Response) => void) | undefined
    window.fetch = () => new Promise<Response>((resolve) => { resolveRequest = resolve })
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    history.replaceState({}, '', routes.workspace.shift.href({ shiftId: 'request-source' }))
    sessionStorage.clear()

    try {
      let result = render(<AnalyticsCoordinator action={routes.resources.analytics.href()} />)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      let request = window.fetch(routes.actions.updateTask.href({ taskId: 'private-task-id' }))
      history.replaceState({}, '', routes.workspace.individual.href())
      assert.ok(resolveRequest)
      resolveRequest(new Response(null, { status: 204 }))
      await request
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))

      let apiRequest = batches.flat().find((event) => event.type === 'api_request')
      assert.equal(apiRequest?.route, '/shift/:id')
      result.cleanup()
    } finally {
      history.replaceState({}, '', originalPath)
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      window.fetch = originalFetch
      sessionStorage.clear()
    }
  })

  it('records API failures, handled client errors, and viewport changes without raw target ids', async () => {
    let originalFetch = window.fetch
    let originalSendBeacon = navigator.sendBeacon
    let originalInnerWidth = window.innerWidth
    let batches: Array<{ type: string; metadata?: Record<string, unknown> }[]> = []
    window.fetch = async () => new Response('Unavailable', { status: 503 })
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    sessionStorage.clear()

    try {
      let result = render(<div>
        <AnalyticsCoordinator action={routes.resources.analytics.href()} />
        <button data-testid="task-edit-private-task-id">Edit</button>
      </div>)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      await result.act(() => result.$('button')?.click())
      await assert.rejects(() => window.fetch(routes.actions.updateTask.href({ taskId: 'private-task-id' })).then((response) => {
        if (!response.ok) throw new Error('Request failed')
      }))
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'Cannot insert before a doctype',
        error: new DOMException('Cannot insert before a doctype', 'HierarchyRequestError'),
      }))
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
      window.dispatchEvent(new Event('resize'))
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 175)) })
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))

      let events = batches.flat()
      assert.ok(events.some((event) => event.type === 'api_error' && event.metadata?.status === 503))
      assert.ok(events.some((event) => event.type === 'client_error' && event.metadata?.errorName === 'HierarchyRequestError'))
      assert.ok(events.some((event) => event.type === 'viewport_change' && event.metadata?.viewportWidth === 390))
      assert.ok(events.some((event) => event.type === 'click' && event.metadata?.testId === 'task-edit-:id'))
      result.cleanup()
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      window.fetch = originalFetch
      sessionStorage.clear()
    }
  })

  it('records enhanced same-route mutations as completed workflows', async () => {
    let originalSendBeacon = navigator.sendBeacon
    let batches: Array<{ type: string; metadata?: Record<string, unknown> }[]> = []
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    sessionStorage.clear()

    try {
      let result = render(<div>
        <AnalyticsCoordinator action={routes.resources.analytics.href()} />
        <form method="post" action={routes.actions.updateTask.href({ taskId: 't1' })} data-workflow="update-task-reminder">
          <button type="submit">Toggle reminder</button>
        </form>
      </div>)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      let form = result.$('form') as HTMLFormElement
      form.addEventListener('submit', (event) => event.preventDefault())

      await result.act(() => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: result.$('button') })))
      await result.act(() => settleEnhancedWorkflow(form, 'complete'))
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))

      let events = batches.flat()
      assert.equal(events.filter((event) => event.type === 'workflow_start').length, 1)
      assert.equal(events.filter((event) => event.type === 'workflow_complete').length, 1)
      assert.equal(events.filter((event) => event.type === 'workflow_error').length, 0)
      result.cleanup()
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      sessionStorage.clear()
    }
  })

  it('uses the server settlement for a native form instead of assuming navigation succeeded', async () => {
    let originalSendBeacon = navigator.sendBeacon
    let batches: Array<{ type: string; metadata?: Record<string, unknown> }[]> = []
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: (_url: string, data: FormData) => {
      batches.push(JSON.parse(String(data.get('events'))))
      return true
    } })
    sessionStorage.clear()
    sessionStorage.setItem('handover:pending-workflows', JSON.stringify([{
      id: 'native-attempt', workflow: 'delete-task', startedAt: Date.now() - 50, sourcePath: routes.workspace.shift.href({ shiftId: 's1' }),
    }]))

    try {
      let result = render(<AnalyticsCoordinator action={routes.resources.analytics.href()} nativeWorkflowSettlement="error" />)
      await result.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      await result.act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))

      let events = batches.flat()
      assert.equal(events.filter((event) => event.type === 'workflow_complete').length, 0)
      assert.equal(events.filter((event) => event.type === 'workflow_error').length, 1)
      assert.equal(sessionStorage.getItem('handover:pending-workflows'), null)
      result.cleanup()
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: originalSendBeacon })
      sessionStorage.clear()
    }
  })

  it('keeps the summary in a normal named form field', async () => {
    let result = render(<RichTextEditor name="summary" label="Situation" value="Initial summary" />)
    await result.act(() => result.$('button[aria-label="Edit situation summary"]')?.click())
    let editor = result.$('[role="textbox"]') as HTMLDivElement
    editor.textContent = 'Updated summary'
    await result.act(() => editor.dispatchEvent(new InputEvent('input', { bubbles: true })))
    assert.equal((result.$('input[name="summary"]') as HTMLInputElement | null)?.value, 'Updated summary')
    result.cleanup()
  })

  it('renders the covered checklist status with the same double-check icon as React', async () => {
    let result = render(<ChecklistEditor items={[{ id: 'identity', label: 'id_check', status: 'addressed', detail: 'Identity confirmed' }]} />)
    let coveredIcon = result.$('[data-checklist-status-icon="covered"] svg[data-icon="check-check"]')

    assert.deepEqual(
      Array.from(coveredIcon?.querySelectorAll('path') ?? []).map((path) => path.getAttribute('d')),
      ['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'],
    )
    let checkbox = result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement
    let labelId = checkbox.getAttribute('aria-labelledby')
    let statusId = checkbox.getAttribute('aria-describedby')
    assert.equal(result.$(`#${labelId}`)?.textContent, 'Identity confirmed')
    assert.equal(result.$(`#${statusId}`)?.textContent?.trim(), 'Covered')

    result.root.render(<ChecklistEditor items={[{ id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' }]} />)
    result.root.flush()

    assert.ok(result.$('[data-checklist-status-icon="mandatory"]'))
    assert.equal((result.$('input[name="checklistItemId"]') as HTMLInputElement).value, 'identity')
    assert.equal((result.$('input[name="covered"]') as HTMLInputElement).checked, false)
    result.cleanup()
  })

  it('reconciles checklist state when a preserved client entry receives new Frame props', () => {
    let result = render(<ChecklistEditor items={[
      { id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' },
    ]} />)

    assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, false)
    result.root.render(<ChecklistEditor items={[
      { id: 'identity', label: 'id_check', status: 'addressed', detail: 'Identity confirmed' },
    ]} />)
    result.root.flush()

    assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, true)
    assert.match(result.container.textContent ?? '', /1 of 1 items covered/)
    result.cleanup()
  })

  it('preserves a pending checklist choice while reconciling other server updates', async () => {
    let originalFetch = window.fetch
    let finishRequest: ((response: Response) => void) | undefined
    window.fetch = () => new Promise<Response>((resolve) => { finishRequest = resolve })
    let result = render(<ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[
      { id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' },
      { id: 'allergies', label: 'bg_allergies', status: 'missing', detail: 'Allergies not confirmed' },
    ]} />)

    try {
      await result.act(() => (result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).click())
      assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, true)

      result.root.render(<ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[
        { id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' },
        { id: 'allergies', label: 'bg_allergies', status: 'addressed', detail: 'Allergies confirmed' },
      ]} />)
      result.root.flush()

      assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, true)
      assert.equal((result.$('[data-testid="checklist-toggle-allergies"]') as HTMLInputElement).checked, true)
      finishRequest?.(new Response('Unavailable', { status: 503 }))
      await result.act(async () => { await Promise.resolve() })
    } finally {
      result.cleanup()
      window.fetch = originalFetch
    }
  })

  it('force-syncs the current server props after an optimistic checklist save settles', async () => {
    let originalFetch = window.fetch
    let reloads = 0
    let requestHeaders = new Headers()
    window.fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers)
      return new Response(null, { status: 204 })
    }
    let result = render(<ChecklistFrameHarness reload={async () => {
      reloads++
      return new AbortController().signal
    }}><ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[
      { id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' },
    ]} /></ChecklistFrameHarness>)

    try {
      await result.act(async () => {
        ;(result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.equal(reloads, 1)
      assert.equal(requestHeaders.get(frameMutationRequestHeader), frameMutationRequestValue)
      assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, false)
      assert.match(result.container.textContent ?? '', /0 of 1 items covered/)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
    }
  })

  it('keeps an accepted optimistic checklist value when Frame refresh fails', async () => {
    let originalFetch = window.fetch
    window.fetch = async () => new Response(null, { status: 204 })
    let result = render(<ChecklistFrameHarness reload={async () => { throw new Error('Refresh unavailable') }}><ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[
      { id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' },
    ]} /></ChecklistFrameHarness>)

    try {
      await result.act(async () => {
        ;(result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, true)
      assert.match(result.$('[role="alert"]')?.textContent ?? '', /saved, but the page could not be refreshed/i)

      result.root.render(<ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[
        { id: 'identity', label: 'id_check', status: 'addressed', detail: 'Identity confirmed' },
      ]} />)
      result.root.flush()
      result.root.render(<ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[
        { id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' },
      ]} />)
      result.root.flush()
      assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, false)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
    }
  })

  it('disables a recommenced-handover checklist without an additional processing card', () => {
    let result = render(<ChecklistEditor disabled withHeader items={[{
      id: 'identity', label: 'id_check', status: 'addressed', detail: 'Identity confirmed',
    }]} />)

    assert.equal(result.$('[data-testid="checklist-processing-lock"]'), null)
    assert.equal(result.$('[data-testid="checklist-editor"]')?.getAttribute('aria-disabled'), 'true')
    assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).disabled, true)
    assert.equal(result.$('form[data-checklist-item-label="id_check"]')?.getAttribute('aria-disabled'), 'true')
    result.cleanup()
  })

  it('edits an SBAR section by clicking its content card and submits the containing form', async () => {
    let result = render(<RichTextEditor name="value" section="assessment" label="Assessment" value="Oxygenation is improving." />)
    let form = result.$('[data-testid="inline-editor-assessment"]') as HTMLFormElement
    let submits = 0
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submits += 1
    })

    assert.ok(result.$('button[aria-label="Edit assessment summary"]'))
    assert.equal(result.$('[role="textbox"]'), null)

    await result.act(() => result.$('button[aria-label="Edit assessment summary"]')?.click())
    let editor = result.$('[role="textbox"][aria-label="Assessment summary editor"]') as HTMLDivElement
    editor.innerText = 'Oxygenation has improved.'
    await result.act(() => editor.dispatchEvent(new InputEvent('input', { bubbles: true })))
    await result.act(() => editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body })))
    assert.equal(submits, 0)
    assert.ok(result.$('[role="textbox"][aria-label="Assessment summary editor"]'))
    await result.act(() => result.$('[data-editing] button:last-of-type')?.click())

    assert.equal(submits, 1)
    assert.equal((result.$('input[name="value"]') as HTMLInputElement).value, 'Oxygenation has improved.')
    assert.equal((result.$('input[name="section"]') as HTMLInputElement).value, 'assessment')
    assert.equal(result.$('[role="textbox"]'), null)
    result.cleanup()
  })

  it('restores a checklist selection when immediate persistence fails', async () => {
    let originalFetch = window.fetch
    window.fetch = async () => new Response('Unavailable', { status: 503 })
    try {
      let result = render(<ChecklistEditor action={routes.actions.updateChecklist.href({ handoverId: 'h1' })} items={[{ id: 'identity', label: 'id_check', status: 'missing', detail: 'Identity not confirmed' }]} />)

      await result.act(async () => {
        ;(result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.equal((result.$('[data-testid="checklist-toggle-identity"]') as HTMLInputElement).checked, false)
      assert.match(result.$('[role="alert"]')?.textContent ?? '', /previous selection has been restored/i)
      assert.equal((result.$('input[name="checklistItemId"]') as HTMLInputElement).value, 'identity')
      assert.equal((result.$('input[name="covered"]') as HTMLInputElement).checked, false)
      result.cleanup()
    } finally {
      window.fetch = originalFetch
    }
  })

  it('cancels an inline SBAR edit on Escape without submitting it', async () => {
    let result = render(<RichTextEditor name="background" label="Background" value="Admitted with pneumonia." action={routes.actions.updateSummary.href({ handoverId: 'h1' })} />)
    let submits = 0
    result.$('form')?.addEventListener('submit', (event) => {
      event.preventDefault()
      submits += 1
    })

    await result.act(() => result.$('button[aria-label="Edit background summary"]')?.click())
    let editor = result.$('[role="textbox"]') as HTMLDivElement
    editor.innerText = 'Temporary edit'
    await result.act(() => editor.dispatchEvent(new InputEvent('input', { bubbles: true })))
    await result.act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))

    assert.equal(submits, 0)
    assert.equal(result.$('[role="textbox"]'), null)
    assert.equal((result.$('input[name="background"]') as HTMLInputElement).value, 'Admitted with pneumonia.')
    result.cleanup()
  })
})
