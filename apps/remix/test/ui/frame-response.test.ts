import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createFrameRequest, frameMarkupOrDocumentNavigation, isHtmlDocument } from '../../app/assets/frame-response.ts'
import { routes } from '../../app/routes.ts'

async function contentText(content: string | Response) {
  return typeof content === 'string' ? content : await content.text()
}

describe('Frame response handling', () => {
  it('preserves named Frame navigation context and cancellation with the RC options API', () => {
    let controller = new AbortController()
    let request = createFrameRequest('./actions', {
      target: 'workspace',
      signal: controller.signal,
    }, 'https://handover.example/shift/one?tab=details')

    assert.equal(request.url, 'https://handover.example/shift/actions')
    assert.equal(request.method, 'GET')
    assert.equal(request.credentials, 'same-origin')
    assert.equal(request.headers.get('Accept'), 'text/html')
    assert.equal(request.headers.get('X-Remix-Target'), 'workspace')
    assert.equal(request.signal.aborted, false)
    controller.abort()
    assert.equal(request.signal.aborted, true)

    let crossOrigin = createFrameRequest('https://other.example/widget', undefined, request.url)
    assert.equal(crossOrigin.headers.has('X-Remix-Top-Frame-Src'), false)
  })

  it('submits native Frame form navigation with its requested method and encoding', async () => {
    let formData = new FormData()
    formData.append('title', 'Day shift & cover')
    formData.append('member', 'one')
    formData.append('member', 'two')
    let request = createFrameRequest('/shifts', {
      method: 'post',
      formData,
      encType: 'application/x-www-form-urlencoded',
      target: 'workspace',
    }, 'https://handover.example/')

    assert.equal(request.method, 'POST')
    assert.match(request.headers.get('Content-Type') ?? '', /^application\/x-www-form-urlencoded/)
    assert.equal(await request.text(), 'title=Day+shift+%26+cover&member=one&member=two')

    let multipart = createFrameRequest('/uploads', { method: 'POST', formData }, request.url)
    assert.match(multipart.headers.get('Content-Type') ?? '', /^multipart\/form-data; boundary=/)
    assert.deepEqual([...(await multipart.formData()).entries()], [...formData.entries()])

    let plain = createFrameRequest('/shifts', { method: 'POST', formData, encType: 'text/plain' }, request.url)
    assert.equal(await plain.text(), 'title=Day shift & cover\r\nmember=one\r\nmember=two\r\n')
  })

  it('returns ordinary Frame fragments without navigating the document', async () => {
    let destinations: string[] = []
    let markup = await frameMarkupOrDocumentNavigation(
      new Response('<section>Patient workspace</section>', { headers: { 'content-type': 'text/html' } }),
      routes.workspace.shift.href({ shiftId: 'one' }),
      undefined,
      (href) => destinations.push(href),
    )

    assert.equal(markup, '<section>Patient workspace</section>')
    assert.deepEqual(destinations, [])
  })

  it('preserves a complete top-level document and its flush marker', async () => {
    let destinations: string[] = []
    let document = '<!doctype html><html><head><title>Shift</title></head><body>Shift</body></html><!-- rmx:flush document --><template id="workspace">Shift workspace</template>'
    let markup = await frameMarkupOrDocumentNavigation(
      new Response(document),
      routes.workspace.shift.href({ shiftId: 'one' }),
      undefined,
      (href) => destinations.push(href),
    )

    assert.equal(await contentText(markup), document)
    assert.deepEqual(destinations, [])
  })

  it('preserves followed redirect metadata so native authentication forms commit the final URL', async () => {
    let response = new Response('<!doctype html><html><body>Choose workflow</body></html><!-- rmx:flush document -->', {
      headers: { 'Content-Type': 'text/html' },
    })
    // Match the read-only metadata fetch supplies after following the POST's 303.
    Object.defineProperties(response, {
      url: { value: 'https://handover.example/' },
      redirected: { value: true },
    })
    let navigated: string[] = []
    let result = await frameMarkupOrDocumentNavigation(response, '/sign-in', undefined, (href) => navigated.push(href))

    assert.equal(result, response)
    assert.ok(result instanceof Response)
    assert.equal(result.redirected, true)
    assert.equal(result.url, 'https://handover.example/')
    assert.match(await result.text(), /rmx:flush document/)
    assert.deepEqual(navigated, [])
  })

  it('navigates the top-level document instead of nesting it in a named Frame', async () => {
    let destinations: string[] = []
    let markup = await frameMarkupOrDocumentNavigation(
      new Response('<!doctype html><html><head><title>Sign in</title></head><body>Sign in</body></html>'),
      '/sign-in?returnTo=%2Fshift%2Fone',
      'workspace',
      (href) => destinations.push(href),
    )

    assert.equal(isHtmlDocument('  <HTML lang="en"><body></body></HTML>'), true)
    assert.deepEqual(destinations, ['/sign-in?returnTo=%2Fshift%2Fone'])
    assert.match(await contentText(markup), /Loading page/)
  })
})
