import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { TypedEventTarget, type FrameHandle } from 'remix/component'
import { render } from 'remix/component/test'

import { FrameMutationEnhancer, FrameMutationForm } from '../../app/assets/frame-form.tsx'
import { PROCESSING_WAKE_EVENT } from '../../app/assets/processing-events.ts'
import { routes } from '../../app/routes.ts'
import { frameMutationLocationHeader } from '../../app/utils/frame-mutation.ts'

function frame(src: string, onReload: () => void): FrameHandle {
  return Object.assign(new TypedEventTarget<{ reloadStart: Event; reloadComplete: Event }>(), {
    src,
    // This navigation-only Frame stub still needs a runtime for native css().
    $runtime: {},
    async reload() {
      onReload()
      return new AbortController().signal
    },
    async replace() {},
  }) as FrameHandle
}

type NavigationCall = { href: string; target?: string; resetScroll?: boolean }

function captureNavigations(destinations: NavigationCall[]): () => void {
  let navigation = window.navigation
  let descriptor = Object.getOwnPropertyDescriptor(navigation, 'navigate')
  Object.defineProperty(navigation, 'navigate', {
    configurable: true,
    value: ((href: string, options?: NavigationNavigateOptions) => {
      let state = options?.state as { target?: string; resetScroll?: boolean } | undefined
      destinations.push({ href, target: state?.target, resetScroll: state?.resetScroll })
      return { committed: Promise.resolve(), finished: Promise.resolve() }
    }) as unknown as typeof navigation.navigate,
  })
  return () => {
    if (descriptor) Object.defineProperty(navigation, 'navigate', descriptor)
    else delete (navigation as unknown as { navigate?: unknown }).navigate
  }
}

function redirectedResponse(url: string): Response {
  let response = new Response('<main>Redirect destination</main>', { status: 200 })
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: url },
  })
  return response
}

describe('enhanced Frame mutation navigation', () => {
  it('uses Remix navigation when a successful mutation changes the canonical route', async () => {
    let originalFetch = window.fetch
    let destinations: NavigationCall[] = []
    let restoreNavigation = captureNavigations(destinations)
    let reloads = 0
    let destinationHref = routes.workspace.inbox.href() + '?filter=new#received'
    window.fetch = async () => new Response(null, {
      status: 204,
      headers: { [frameMutationLocationHeader]: destinationHref },
    })
    let result = render(
      <FrameMutationForm action="/actions/example">
        <button type="submit">Save</button>
      </FrameMutationForm>,
      { frame: frame(`${window.location.origin}/tasks`, () => { reloads++ }) },
    )

    try {
      await result.act(async () => {
        ;(result.$('button') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.deepEqual(destinations, [{ href: destinationHref, target: 'workspace', resetScroll: true }])
      assert.equal(reloads, 0)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
      restoreNavigation()
    }
  })

  it('wakes processing discovery after a successful processing mutation', async () => {
    let originalFetch = window.fetch
    let wakeCount = 0
    let onWake = () => { wakeCount++ }
    window.addEventListener(PROCESSING_WAKE_EVENT, onWake)
    window.fetch = async () => new Response(null, { status: 204 })
    let result = render(
      <FrameMutationForm action="/actions/example" wakeProcessing>
        <button type="submit">Rerun analysis</button>
      </FrameMutationForm>,
      { frame: frame(`${window.location.origin}/handovers/example/transcript`, () => {}) },
    )

    try {
      await result.act(async () => {
        ;(result.$('button') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.equal(wakeCount, 1)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
      window.removeEventListener(PROCESSING_WAKE_EVENT, onWake)
    }
  })

  it('honours same-origin upstream redirects without reporting mutation success or reloading', async () => {
    let originalFetch = window.fetch
    let destinations: NavigationCall[] = []
    let restoreNavigation = captureNavigations(destinations)
    let reloads = 0
    window.fetch = async () => redirectedResponse(`${window.location.origin}/sign-in?returnTo=%2Ftasks`)
    let result = render(
      <FrameMutationForm action="/actions/example">
        <button type="submit">Save</button>
      </FrameMutationForm>,
      { frame: frame(`${window.location.origin}/tasks`, () => { reloads++ }) },
    )

    try {
      await result.act(async () => {
        ;(result.$('button') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.deepEqual(destinations, [{ href: '/sign-in?returnTo=%2Ftasks', target: 'workspace', resetScroll: true }])
      assert.equal(reloads, 0)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
      restoreNavigation()
    }
  })

  it('rejects a cross-origin upstream redirect', async () => {
    let originalFetch = window.fetch
    let destinations: NavigationCall[] = []
    let restoreNavigation = captureNavigations(destinations)
    let reloads = 0
    window.fetch = async () => redirectedResponse('https://example.test/sign-in')
    let result = render(
      <FrameMutationForm action="/actions/example">
        <button type="submit">Save</button>
      </FrameMutationForm>,
      { frame: frame(`${window.location.origin}/tasks`, () => { reloads++ }) },
    )

    try {
      await result.act(async () => {
        ;(result.$('button') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.deepEqual(destinations, [])
      assert.equal(reloads, 0)
      assert.match(result.$('[role="alert"]')?.textContent ?? '', /not on this site/)
    } finally {
      result.cleanup()
      window.fetch = originalFetch
      restoreNavigation()
    }
  })

  it('enhances a server-owned form and preserves scroll while navigating its workspace Frame', async () => {
    let originalFetch = window.fetch
    let destinations: NavigationCall[] = []
    let restoreNavigation = captureNavigations(destinations)
    window.fetch = async () => redirectedResponse(`${window.location.origin}/handovers/example/summary`)
    let result = render(
      <form method="post" action="/actions/example">
        <button type="submit">Save details</button>
        <FrameMutationEnhancer preserveScroll />
      </form>,
      { frame: frame(`${window.location.origin}/handovers/example/summary?edit=patient`, () => {}) },
    )

    try {
      await result.act(async () => {
        ;(result.$('button') as HTMLButtonElement).click()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      assert.deepEqual(destinations, [{
        href: '/handovers/example/summary',
        target: 'workspace',
        resetScroll: false,
      }])
    } finally {
      result.cleanup()
      window.fetch = originalFetch
      restoreNavigation()
    }
  })
})
