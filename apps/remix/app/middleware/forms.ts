import { csrf } from 'remix/middleware/csrf'
import type { Middleware } from 'remix/router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'

import {
  frameMutationLocationHeader,
  frameMutationResultHeader,
  frameMutationSuccessValue,
  isFrameMutationRequest,
} from '../utils/frame-mutation.ts'
import { requireUser } from './auth.ts'
import { stagedFormData } from './uploads.ts'
import { safeInternalPath } from '../utils/internal-path.ts'
import { routes } from '../routes.ts'

function csrfOptions() {
  let configured = process.env.PUBLIC_ORIGIN
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return {
    allowMissingOrigin: process.env.NODE_ENV === 'test',
    ...(configured?.length ? { origin: configured } : {}),
  }
}

/** Public authentication forms still require a session-backed synchronizer token. */
export const publicFormMiddleware = [stagedFormData(), csrf(csrfOptions())] as const

/** Authenticate first; present parse, CSRF, and action failures on the originating browser page. */
export const protectedFormMiddleware = [
  requireUser(),
  redirectBrowserFormFailures(),
  stagedFormData(),
  csrf(csrfOptions()),
  completeFrameMutationWithoutRedirect(),
] as const

const redirectStatuses = new Set([301, 302, 303, 307, 308])

/**
 * Enhanced forms refresh their owning Frame after a successful mutation. Turn
 * the action's ordinary POST-redirect-GET response into a bodyless success so
 * browser fetch does not follow and render the redirect before that reload.
 * Requests without the opt-in header retain the native redirect contract.
 */
export function completeFrameMutationWithoutRedirect(): Middleware {
  return async (context, next) => {
    let response = await next()
    if (!response || !isFrameMutationRequest(context.request)) return response
    if (response.headers.get(frameMutationResultHeader) !== frameMutationSuccessValue) return response
    if (!redirectStatuses.has(response.status) || !response.headers.has('location')) return response

    let headers = new Headers(response.headers)
    headers.set(frameMutationLocationHeader, response.headers.get('location')!)
    headers.delete('location')
    headers.delete('content-length')
    headers.delete(frameMutationResultHeader)
    return new Response(null, { status: 204, headers })
  }
}

/**
 * Keep an ordinary browser mutation on its current clinical surface when
 * validation fails. Programmatic/resource callers retain the original 4xx/5xx
 * response. Authentication failures still happen before this middleware.
 */
export function redirectBrowserFormFailures(): Middleware {
  return async (context, next) => {
    let response = await next()
    if (!response) return response
    if (context.request.headers.get('sec-fetch-mode') !== 'navigate') return response

    let session = context.get(Session)
    if (!session) return response
    // Session-ending actions (notably sign out) cannot carry workflow flash
    // state. Preserve their response instead of attempting to mutate a
    // destroyed session while the middleware stack unwinds.
    if (session.destroyed) return response
    if (response.status < 400 || response.status > 599) {
      session.flash('nativeWorkflowSettlement', 'complete')
      return response
    }

    let message = (await response.clone().text()).trim().slice(0, 500)
    session.flash('error', message || 'The change could not be saved.')
    session.flash('nativeWorkflowSettlement', 'error')
    return redirect(browserReturnTo(context.url, context.request.headers.get('referer')), 303)
  }
}

function browserReturnTo(actionUrl: URL, referer: string | null): string {
  let explicit = actionUrl.searchParams.get('returnTo')
  if (safeWorkspacePath(explicit)) return explicit
  if (referer) {
    try {
      let url = new URL(referer)
      let path = `${url.pathname}${url.search}${url.hash}`
      if (url.origin === actionUrl.origin && safeWorkspacePath(path)) return path
    } catch {
      // A malformed Referer is ignored and falls through to the safe root.
    }
  }
  return routes.workspace.home.href()
}

function safeWorkspacePath(value: string | null): value is string {
  let path = safeInternalPath(value)
  return Boolean(path && !path.startsWith('/actions/'))
}
