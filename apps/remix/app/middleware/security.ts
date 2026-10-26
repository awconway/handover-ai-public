import type { Middleware } from 'remix/router'

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function rejectLegacySessionHeader(): Middleware {
  return (context, next) => {
    if (context.request.headers.has('x-session-id')) {
      return new Response('Legacy session headers are not accepted.', { status: 400 })
    }
    return next()
  }
}

export function enforceBodyLimit(maxBytes: number | ((url: URL) => number) = 40 * 1024 * 1024): Middleware {
  return (context, next) => {
    let requestMaxBytes = typeof maxBytes === 'function' ? maxBytes(context.url) : maxBytes
    let declared = context.request.headers.get('content-length')
    if (declared && Number(declared) > requestMaxBytes) {
      return new Response('Request body is too large.', { status: 413 })
    }
    return next()
  }
}

export function enforceCanonicalOrigin(origins: readonly string[]): Middleware {
  let allowed = new Set(origins.map((origin) => new URL(origin).origin))

  return (context, next) => {
    if (!unsafeMethods.has(context.request.method)) return next()

    let origin = context.request.headers.get('origin')
    if (origin && !allowed.has(origin)) {
      return new Response('Cross-origin request rejected.', { status: 403 })
    }
    return next()
  }
}

/** Clinical and session-derived responses must never be stored by a shared cache. */
export function privateNoStore(): Middleware {
  return async (context, next) => {
    let response = await next()
    if (!response) return response

    // The Remix asset server owns caching for its stable URLs. It emits ETags
    // with revalidation by default and only uses immutable caching when source
    // fingerprinting is enabled.
    if (context.url.pathname.startsWith('/assets/')) return response

    response.headers.set('Cache-Control', 'private, no-store')
    let vary = response.headers.get('Vary')
    let values = new Set(
      (vary ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    values.add('Cookie')
    response.headers.set('Vary', [...values].join(', '))
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('Referrer-Policy', 'same-origin')
    response.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)')
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    return response
  }
}
