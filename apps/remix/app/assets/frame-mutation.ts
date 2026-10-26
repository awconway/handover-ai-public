import { navigate, on, type FrameHandle } from 'remix/component'

import {
  frameMutationLocationHeader,
  frameMutationRequestHeader,
  frameMutationRequestValue,
} from '../utils/frame-mutation.ts'
import { settleEnhancedWorkflow } from './workflow-analytics.ts'

type FrameMutationHandle = {
  frame: FrameHandle
  signal: AbortSignal
  update(): Promise<AbortSignal>
}

export interface FrameMutationOptions {
  onError?: (message: string, form: HTMLFormElement) => void
  onPending?: (pending: boolean, form: HTMLFormElement) => void
  onRefreshError?: (message: string, form: HTMLFormElement) => void
  onSuccess?: (response: Response, form: HTMLFormElement) => void
  resetScroll?: boolean
}

const pendingForms = new WeakSet<HTMLFormElement>()

function sameCanonicalFrame(destination: URL, frameSrc: string): boolean {
  let current = new URL(frameSrc, window.location.href)
  return destination.origin === current.origin
    && destination.pathname === current.pathname
    && destination.search === current.search
}

function sameOriginDestination(value: string, base: string): URL {
  let destination = new URL(value, base)
  if (destination.origin !== window.location.origin) {
    throw new Error('The requested destination is not on this site.')
  }
  return destination
}

function destinationHref(destination: URL): string {
  return `${destination.pathname}${destination.search}${destination.hash}`
}

/**
 * Applies the response contract shared by hydrated POST controls: followed
 * redirects become navigation, successful mutation locations navigate when
 * they change route, and same-route mutations refresh only their Frame.
 */
export async function refreshFrameAfterMutation(
  frame: FrameHandle,
  response: Response,
  action: string,
  options: { resetScroll?: boolean; target?: string } = {},
) {
  if (response.redirected) {
    let destination = sameOriginDestination(response.url, action)
    await navigate(destinationHref(destination), { target: options.target ?? 'workspace', resetScroll: options.resetScroll })
    return
  }

  let location = response.headers.get(frameMutationLocationHeader)
  let destination = location ? sameOriginDestination(location, response.url || action) : null
  if (destination && !sameCanonicalFrame(destination, frame.src)) {
    await navigate(destinationHref(destination), { target: options.target ?? 'workspace', resetScroll: options.resetScroll })
  } else {
    await frame.reload()
  }
}

/**
 * Progressively enhances an ordinary POST form using Remix's server-first
 * fetch-then-frame-reload pattern. The native method/action remain the no-JS
 * fallback, while successful hydrated mutations preserve document scroll.
 */
export function enhanceFrameMutation(handle: FrameMutationHandle, options: FrameMutationOptions = {}) {
  return on<HTMLFormElement, 'submit'>('submit', async (event) => {
    await submitFrameMutation(handle, options, event, event.currentTarget)
  })
}

/**
 * Adds the same Remix frame mutation behavior to a server-rendered form whose
 * children should remain outside a client-entry boundary.
 */
export function attachFrameMutation(
  handle: FrameMutationHandle,
  form: HTMLFormElement,
  options: FrameMutationOptions = {},
) {
  form.addEventListener('submit', (event) => {
    void submitFrameMutation(handle, options, event, form)
  }, { signal: handle.signal })
}

async function submitFrameMutation(
  handle: FrameMutationHandle,
  options: FrameMutationOptions,
  event: SubmitEvent,
  form: HTMLFormElement,
) {
    if (event.defaultPrevented) return
    event.preventDefault()
    if (pendingForms.has(form)) return

    // Capture the successful-control set before any pending-state update can
    // reconcile the form or change the clicked submitter's value.
    let body = new FormData(form, event.submitter)
    let action = form.action
    let method = form.method || 'post'
    pendingForms.add(form)
    options.onPending?.(true, form)
    await handle.update()
    if (handle.signal.aborted) {
      pendingForms.delete(form)
      return
    }

    let response: Response
    try {
      response = await fetch(action, {
        method,
        body,
        credentials: 'same-origin',
        headers: {
          accept: 'text/html',
          [frameMutationRequestHeader]: frameMutationRequestValue,
        },
        // Event-listener signals abort on re-entry or when reconciliation
        // removes their node. The component signal survives ordinary rerenders
        // and still aborts safely when the island is removed or navigation wins.
        signal: handle.signal,
      })
      if (handle.signal.aborted) return
      if (response.redirected) {
        pendingForms.delete(form)
        options.onPending?.(false, form)
        await handle.update()
        if (!handle.signal.aborted) await refreshFrameAfterMutation(handle.frame, response, action, { resetScroll: options.resetScroll })
        return
      }
      if (!response.ok) {
        let message = (await response.text()).trim().slice(0, 500)
        throw new Error(message || `The change could not be saved (${response.status}).`)
      }
    } catch (error) {
      if (handle.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      settleEnhancedWorkflow(form, 'error')
      options.onError?.(error instanceof Error ? error.message : 'The change could not be saved.', form)
      pendingForms.delete(form)
      options.onPending?.(false, form)
      await handle.update()
      return
    }

    settleEnhancedWorkflow(form, 'complete')
    options.onSuccess?.(response, form)
    pendingForms.delete(form)
    options.onPending?.(false, form)
    await handle.update()
    if (handle.signal.aborted) return

    try {
      await refreshFrameAfterMutation(handle.frame, response, action, { resetScroll: options.resetScroll })
    } catch (error) {
      if (handle.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      options.onRefreshError?.(error instanceof Error ? error.message : 'The saved change could not be refreshed.', form)
      await handle.update()
    }
}
