import type { ResolveFrameOptions } from 'remix/component'

const documentLoadingMarkup = '<div role="status" aria-live="polite">Loading page…</div>'

/** Preserve the runtime's navigation method, encoding, target, and cancellation. */
export function createFrameRequest(
  src: string,
  options: ResolveFrameOptions | undefined,
  documentHref: string,
): Request {
  let url = new URL(src, documentHref)
  let headers = new Headers({ Accept: 'text/html' })
  if (options?.target) headers.set('X-Remix-Target', options.target)

  let method = options?.method ?? 'GET'
  let body: BodyInit | undefined
  if (options?.formData && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    if (options.encType === 'application/x-www-form-urlencoded') {
      let params = new URLSearchParams()
      for (let [name, value] of options.formData) {
        params.append(name, typeof value === 'string' ? value : value.name)
      }
      body = params
    } else if (options.encType === 'text/plain') {
      let text = ''
      let normalize = (value: string) => value.replace(/\r\n|\r|\n/g, '\r\n')
      for (let [name, value] of options.formData) {
        text += `${normalize(name)}=${normalize(typeof value === 'string' ? value : value.name)}\r\n`
      }
      body = new Blob([text], { type: 'text/plain' })
    } else {
      body = options.formData
    }
  }

  return new Request(url, { method, headers, body, signal: options?.signal, credentials: 'same-origin' })
}

/**
 * Protected Frame requests can follow an expired-session redirect and receive
 * the complete sign-in document with a final 200 response. A document must
 * replace the top-level page; inserting it into a Frame creates nested html,
 * head, and body elements and leaves the shell in an unusable state.
 */
export async function frameMarkupOrDocumentNavigation(
  response: Response,
  requestedSrc: string,
  target: string | undefined,
  navigateDocument: (href: string) => void,
): Promise<string | Response> {
  let markup = await response.clone().text()
  if (!isHtmlDocument(markup)) return markup

  // Unnamed Frame loads replace the top-level Document. Keep the original
  // response so native form navigation can commit its final redirect URL,
  // plus the stream's `rmx:flush document` marker and its
  // trailing streamed Frame templates. The runtime extracts those templates
  // before it diffs the document head and body; collapsing the stream to a
  // string makes the trailing templates look like a fragment to insert before
  // the doctype.
  if (!target) return response

  // A named Frame cannot safely contain a complete document. This normally
  // means that its request followed an expired-session redirect to sign-in.
  navigateDocument(response.url || requestedSrc)
  return documentLoadingMarkup
}

export function isHtmlDocument(markup: string): boolean {
  return /^\s*(?:<!doctype\s+html[^>]*>\s*)?<html(?:\s|>)/i.test(markup)
}
