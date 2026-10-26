import * as assert from 'remix/assert'
import { createRouter } from 'remix/router'
import { describe, it } from 'remix/test'
import { Frame, type Handle } from 'remix/component'

import { documentAssetHrefs } from '../../app/assets.ts'
import { render } from '../../app/middleware/render.tsx'
import { Document } from '../../app/ui/document.tsx'
import { LocalTimestamp } from '../../app/assets/local-timestamp.tsx'
import { FrameMutationEnhancer, FrameMutationForm } from '../../app/assets/frame-form.tsx'

describe('Remix document and Frame rendering', () => {
  it('keeps credentials and top-frame context through redirects and relative nested Frames', async () => {
    let requests: Request[] = []
    let router = createRouter({ middleware: [render()] })
    router.get('/workspace', (context) => context.render(<Frame name="workspace" src="/normalize" />))
    router.get('/normalize', ({ request }) => {
      requests.push(request)
      return new Response(null, { status: 303, headers: { Location: '/patients/one/details' } })
    })
    router.get('/patients/one/details', (context) => {
      requests.push(context.request)
      return context.render(<Frame name="tasks" src="./tasks" />)
    })
    router.get('/patients/one/tasks', (context) => {
      requests.push(context.request)
      return context.render(<FrameUrls />)
    })

    let response = await router.fetch(new Request('http://localhost/workspace?mode=shift', {
      headers: { Cookie: 'handover-session=authenticated' },
    }))
    let html = await response.text()

    assert.equal(response.status, 200)
    assert.match(html, /Current: http:\/\/localhost\/patients\/one\/tasks/)
    assert.match(html, /Top: http:\/\/localhost\/workspace\?mode=shift/)
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      '/normalize', '/patients/one/details', '/patients/one/tasks',
    ])
    assert.deepEqual(requests.map((request) => request.headers.get('X-Remix-Target')), ['workspace', 'workspace', 'tasks'])
    for (let request of requests) {
      assert.equal(request.method, 'GET')
      assert.equal(request.headers.get('Cookie'), 'handover-session=authenticated')
      assert.equal(request.headers.get('X-Remix-Frame'), 'true')
      assert.equal(request.headers.get('X-Remix-Top-Frame-Src'), 'http://localhost/workspace?mode=shift')
    }
  })

  it('strips credentials and private top-frame URLs when a Frame redirects across origins', async () => {
    let externalRequest: Request | undefined
    let router = createRouter({ middleware: [render()] })
    router.get('/workspace', (context) => context.render(<Frame name="workspace" src="/redirect" />))
    router.get('/redirect', () => new Response(null, {
      status: 302,
      headers: { Location: 'https://external.example/widget' },
    }))
    router.get('/widget', ({ request }) => {
      externalRequest = request
      return new Response('<p>External widget</p>', { headers: { 'Content-Type': 'text/html' } })
    })

    let response = await router.fetch(new Request('http://localhost/workspace?private=one', {
      headers: { Cookie: 'handover-session=authenticated', Authorization: 'Bearer test-token' },
    }))

    assert.match(await response.text(), /External widget/)
    assert.ok(externalRequest)
    assert.equal(externalRequest.url, 'https://external.example/widget')
    assert.equal(externalRequest.headers.has('Cookie'), false)
    assert.equal(externalRequest.headers.has('Authorization'), false)
    assert.equal(externalRequest.headers.has('X-Remix-Top-Frame-Src'), false)
  })

  it('renders import maps before preloading and bootstrapping hydrated components', async () => {
    let router = createRouter({ middleware: [render()] })
    router.get('/', (context) => context.render(
      <Document {...documentAssetHrefs}>
        <main>
          <LocalTimestamp value="2026-09-10T09:00:00.000Z" />
          <FrameMutationForm action="/save" />
          <form action="/save"><FrameMutationEnhancer /></form>
        </main>
      </Document>,
    ))

    let response = await router.fetch(new Request('http://localhost/'))
    let html = await response.text()
    let importMapIndex = html.indexOf('type="importmap"')
    let preloadIndex = html.indexOf('rel="modulepreload"')
    let entryIndex = html.indexOf(`src="${documentAssetHrefs.entryHref}"`)

    assert.ok(importMapIndex >= 0)
    assert.ok(preloadIndex > importMapIndex)
    assert.ok(entryIndex > preloadIndex)
    assert.match(html, /local-timestamp\.tsx/)
    assert.match(html, /"exportName":"LocalTimestamp"/)
    assert.doesNotMatch(html, /"exportName":"FrameMutationForm"/)
    assert.match(html, /"exportName":"FrameMutationEnhancer"/)
  })

  it('aborts nested Frame work and the HTML stream when its document request is cancelled', async () => {
    let started = Promise.withResolvers<Request>()
    let controller = new AbortController()
    let router = createRouter({ middleware: [render()] })
    router.get('/workspace', (context) => context.render(<Frame name="workspace" src="/slow" />))
    router.get('/slow', ({ request }) => {
      started.resolve(request)
      return new Promise<Response>((resolve) => {
        request.signal.addEventListener('abort', () => resolve(new Response('<p>Cancelled</p>', {
          headers: { 'Content-Type': 'text/html' },
        })), { once: true })
      })
    })

    let response = await router.fetch(new Request('http://localhost/workspace', { signal: controller.signal }))
    let completion = response.text()
    let frameRequest = await started.promise
    assert.equal(frameRequest.signal.aborted, false)
    controller.abort()

    assert.equal(frameRequest.signal.aborted, true)
    // The renderer closes cancelled responses quietly and emits no late Frame markup.
    assert.doesNotMatch(await completion, /Cancelled/)
  })
})

function FrameUrls(handle: Handle) {
  return () => <p>Current: {handle.frame.src}; Top: {handle.frames.top.src}</p>
}
