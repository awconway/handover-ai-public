import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { ProcessingCoordinator } from '../../app/assets/processing-coordinator.tsx'
import { RECORDING_STATUS_EVENT } from '../../app/assets/recording-events.ts'
import { PROCESSING_WAKE_EVENT } from '../../app/assets/processing-events.ts'
import { ProcessingTimeline } from '../../app/assets/processing-timeline.tsx'
import { routes } from '../../app/routes.ts'
import { computedStyle, resolvedColor } from './styles.ts'

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function handoverDetailsHref(handoverId: string) {
  return routes.workspace.handoverReview.href({
    handoverId,
    reviewTab: 'details',
  })
}

const processingAllHref = routes.resources.processingAll.href()
const processingEventsHref = routes.resources.processingEvents.href()

describe('processing UI parity', () => {
  it('ticks elapsed time live and shows React\'s two-minute warning', async () => {
    let originalNow = Date.now
    let now = originalNow()
    Date.now = () => now
    try {
      let result = render(<ProcessingTimeline
        handoverId="handover-live-clock"
        status="analysing"
        startedAt={new Date(now - 119_000).toISOString()}
        updatedAt="2026-07-13T06:00:00.000Z"
        tickMs={5}
      />)
      assert.match(result.container.textContent ?? '', /1m 59s elapsed/)
      assert.equal(result.container.textContent?.includes('Taking longer than usual'), false)
      assert.doesNotMatch(result.container.textContent ?? '', /Extracting the summary|Queued for transcription|review is ready/i)

      now += 2_000
      await result.act(() => wait(20))

      assert.match(result.container.textContent ?? '', /2m 1s elapsed/)
      assert.match(result.container.textContent ?? '', /Taking longer than usual/)
      assert.equal(result.$('[aria-label="Dismiss processing timeline"]'), null)
      result.cleanup()
    } finally {
      Date.now = originalNow
    }
  })

  it('does not mistake the handover age for a completed processing duration', () => {
    let result = render(<ProcessingTimeline
      handoverId="handover-complete-without-start"
      status="completed"
      updatedAt="2026-07-13T06:20:00.000Z"
    />)
    assert.match(result.container.textContent ?? '', /Complete/)
    assert.doesNotMatch(result.container.textContent ?? '', /elapsed/)
    result.cleanup()
  })

  it('keeps the timeline visible without a dismissal control', () => {
    let result = render(<ProcessingTimeline
      handoverId="handover-always-visible"
      status="analysing"
      startedAt="2026-07-13T05:59:30.000Z"
      updatedAt="2026-07-13T06:00:01.000Z"
    />)

    assert.ok(result.$('[aria-label="Processing timeline"]'))
    assert.equal(result.$('[aria-label="Dismiss processing timeline"]'), null)
    result.cleanup()

    result = render(<ProcessingTimeline
      handoverId="handover-always-visible"
      status="completed"
      startedAt="2026-07-13T05:59:30.000Z"
      updatedAt="2026-07-13T06:00:00.000Z"
    />)
    assert.ok(result.$('[aria-label="Processing timeline"]'))
    assert.equal(result.$('[aria-label="Dismiss processing timeline"]'), null)
    result.cleanup()
  })

  it('attributes a failure to analysis when a transcript is already available', async () => {
    let result = render(<ProcessingTimeline
      handoverId="handover-analysis-failed"
      status="failed"
      transcriptAvailable
      updatedAt="2026-07-13T06:00:00.000Z"
      retryAction={routes.actions.retryHandover.href({
        handoverId: 'handover-analysis-failed',
      })}
      discardAction={routes.actions.discardFailedHandover.href({
        handoverId: 'handover-analysis-failed',
      })}
      csrfToken="csrf"
    />)

    let steps = result.$$('[data-testid="processing-step-list"] > div')
    assert.match(steps[0]?.textContent ?? '', /Transcribed/)
    assert.equal(computedStyle(steps[0]).color, resolvedColor('var(--color-slate-700)'))
    assert.match(steps[1]?.textContent ?? '', /Analysing/)
    assert.equal(computedStyle(steps[1]).color, resolvedColor('var(--color-rose-900)'))
    assert.doesNotMatch(result.container.textContent ?? '', /Transcribing/)
    assert.match(result.$('[data-testid="discard-failed-handover"]')?.textContent ?? '', /Discard attempt/)
    await result.act(() => result.$('[data-testid="discard-failed-handover"]')?.click())
    assert.match(result.container.textContent ?? '', /Discard failed attempt\?/)
    assert.match(result.container.textContent ?? '', /last completed handover will be kept/)
    assert.equal(
      result.$('form[data-workflow="discard-failed-handover-attempt"]')?.getAttribute('action'),
      routes.actions.discardFailedHandover.href({ handoverId: 'handover-analysis-failed' }),
    )
    assert.equal(result.$('form[data-workflow="discard-failed-handover-attempt"] input[name="_csrf"]')?.getAttribute('value'), 'csrf')
    result.cleanup()
  })

  it('keeps active jobs and failures out of global overlays', async () => {
    let originalFetch = window.fetch
    let state: 'active' | 'failed' | 'unavailable' = 'active'
    window.fetch = async () => {
      if (state === 'unavailable') return new Response('Unavailable', { status: 503 })
      return new Response(JSON.stringify({
        items: [{
          id: 'handover-1',
          status: state === 'failed' ? 'failed' : 'analysing',
          href: handoverDetailsHref('handover-1'),
          revision: 1,
          updatedAt: state === 'failed' ? '2026-07-13T06:00:01.000Z' : '2026-07-13T06:00:00.000Z',
          readiness: state === 'failed' ? '1111111111' : '1100000000',
          relevant: true,
        }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    try {
      let result = render(<ProcessingCoordinator stateHref={processingAllHref} intervalMs={5} />)
      await result.act(() => wait(20))
      assert.equal(result.$('[data-testid="processing-failure-toast"]'), null)
      assert.equal((result.container.textContent ?? '').trim(), '')

      state = 'failed'
      await result.act(() => wait(20))
      assert.equal(result.$('[data-testid="processing-failure-toast"]'), null)
      assert.equal((result.container.textContent ?? '').trim(), '')

      state = 'unavailable'
      await result.act(() => wait(20))
      assert.doesNotMatch(result.container.textContent ?? '', /temporarily unavailable/i)
      result.cleanup()
    } finally {
      window.fetch = originalFetch
    }
  })

  it('does not surface an untracked historic failure and sleeps while idle until recording submission queues work', async () => {
    let originalFetch = window.fetch
    let calls = 0
    let historicFailure = true
    window.fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({
        items: historicFailure ? [{
          id: 'historic-failure',
          status: 'failed',
          href: handoverDetailsHref('historic-failure'),
          revision: 1,
          updatedAt: '2026-07-13T06:00:00.000Z',
          readiness: '',
          relevant: true,
        }] : [],
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    try {
      let result = render(<ProcessingCoordinator stateHref={processingAllHref} intervalMs={5} />)
      await result.act(() => wait(15))
      assert.equal(calls, 1)
      assert.equal(result.$('[data-testid="processing-failure-toast"]'), null)

      historicFailure = false
      window.dispatchEvent(new CustomEvent(RECORDING_STATUS_EVENT, {
        detail: { formId: 'new-handover', status: 'submitting' },
      }))
      window.dispatchEvent(new CustomEvent(RECORDING_STATUS_EVENT, {
        detail: { formId: 'new-handover', status: 'idle' },
      }))
      await result.act(() => wait(15))
      assert.equal(calls, 2)

      window.dispatchEvent(new CustomEvent(PROCESSING_WAKE_EVENT))
      await result.act(() => wait(15))
      assert.equal(calls, 3)
      result.cleanup()
    } finally {
      window.fetch = originalFetch
    }
  })

  it('carries a server-rendered active handover into the first terminal-state poll', async () => {
    let originalFetch = window.fetch
    let requestedUrl = ''
    let calls = 0
    window.fetch = async (input) => {
      calls += 1
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        items: [{
          id: 'handover-race',
          status: 'failed',
          href: handoverDetailsHref('handover-race'),
          revision: 2,
          updatedAt: '2026-07-15T00:25:55.000Z',
          readiness: '1111111111',
          relevant: true,
        }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    try {
      let result = render(<>
        <span
          hidden
          data-processing-handover-id="handover-race"
          data-processing-active="true"
        />
        <ProcessingCoordinator stateHref={processingAllHref} intervalMs={5} />
      </>)
      await result.act(() => wait(20))

      assert.equal(calls, 1)
      assert.match(requestedUrl, /(?:\?|&)track=handover-race(?:&|$)/)
      result.cleanup()
    } finally {
      window.fetch = originalFetch
    }
  })

  it('uses SSE as the immediate trigger and keeps polling as slow reconciliation', async () => {
    let originalFetch = window.fetch
    let originalEventSource = window.EventSource
    let calls = 0
    let status = 'analysing'

    class FakeEventSource extends EventTarget {
      static instances: FakeEventSource[] = []
      closed = false
      constructor(readonly url: string | URL) {
        super()
        FakeEventSource.instances.push(this)
      }
      close() { this.closed = true }
    }

    Object.defineProperty(window, 'EventSource', { configurable: true, value: FakeEventSource })
    window.fetch = async () => {
      calls += 1
      return new Response(JSON.stringify({
        items: [{
          id: 'handover-sse', status, href: handoverDetailsHref('handover-sse'), revision: 1,
          updatedAt: new Date().toISOString(), readiness: status === 'completed' ? '1111111111' : '', relevant: true,
        }],
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    try {
      let result = render(<ProcessingCoordinator
        stateHref={processingAllHref}
        eventsHref={processingEventsHref}
        intervalMs={5}
        reconcileMs={10_000}
      />)
      await result.act(() => wait(30))
      assert.equal(calls, 1)
      assert.equal(String(FakeEventSource.instances[0]?.url), processingEventsHref)

      status = 'completed'
      FakeEventSource.instances[0]?.dispatchEvent(new MessageEvent('processing', { data: '{"id":"handover-sse"}' }))
      await result.act(() => wait(20))
      assert.equal(calls, 2)

      result.cleanup()
      assert.equal(FakeEventSource.instances[0]?.closed, true)
    } finally {
      window.fetch = originalFetch
      Object.defineProperty(window, 'EventSource', { configurable: true, value: originalEventSource })
    }
  })
})
