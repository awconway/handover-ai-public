import * as assert from 'remix/assert'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'
import { describe, it } from 'remix/test'
import { routes } from '../../app/routes.ts'

import {
  completeFrameMutationWithoutRedirect,
  redirectBrowserFormFailures,
} from '../../app/middleware/forms.ts'
import {
  frameMutationLocationHeader,
  frameMutationRequestHeader,
  frameMutationRequestValue,
  markFrameMutationSuccess,
} from '../../app/utils/frame-mutation.ts'

function request(enhanced: boolean) {
  return new Request('http://localhost/actions/example', {
    method: 'POST',
    headers: enhanced
      ? { [frameMutationRequestHeader]: frameMutationRequestValue }
      : undefined,
  })
}

async function complete(currentRequest: Request, response: Response) {
  return completeFrameMutationWithoutRedirect()(
    { request: currentRequest } as never,
    async () => response,
  )
}

describe('enhanced Frame mutation response', () => {
  it('turns a marked enhanced success redirect into a bodyless success', async () => {
    let currentRequest = request(true)
    let response = markFrameMutationSuccess(currentRequest, redirect('/workspace', 303))

    let completed = await complete(currentRequest, response)

    assert.ok(completed)
    assert.equal(completed.status, 204)
    assert.equal(completed.headers.get('location'), null)
    assert.equal(completed.headers.get(frameMutationLocationHeader), '/workspace')
    assert.equal(await completed.text(), '')
  })

  it('leaves redirect-based validation responses intact', async () => {
    let currentRequest = request(true)

    let completed = await complete(currentRequest, redirect('/workspace?edit=patient', 303))

    assert.ok(completed)
    assert.equal(completed.status, 303)
    assert.equal(completed.headers.get('location'), '/workspace?edit=patient')
    assert.equal(completed.headers.get(frameMutationLocationHeader), null)
  })

  it('keeps the ordinary no-JavaScript redirect contract', async () => {
    let currentRequest = request(false)
    let response = markFrameMutationSuccess(currentRequest, redirect('/workspace', 303))

    let completed = await complete(currentRequest, response)

    assert.ok(completed)
    assert.equal(completed.status, 303)
    assert.equal(completed.headers.get('location'), '/workspace')
    assert.equal(completed.headers.get(frameMutationLocationHeader), null)
  })
})

describe('native browser form response', () => {
  it('preserves a sign-out redirect after the action destroys its session', async () => {
    let session = new Session()
    session.destroy()
    let response = redirect(routes.auth.signIn.index.href(), 303)
    let currentRequest = new Request('http://localhost' + routes.auth.signOut.href(), {
      method: 'POST',
      headers: { 'sec-fetch-mode': 'navigate' },
    })

    let completed = await redirectBrowserFormFailures()(
      {
        request: currentRequest,
        url: new URL(currentRequest.url),
        get(key: unknown) {
          return key === Session ? session : undefined
        },
      } as never,
      async () => response,
    )

    assert.equal(completed, response)
    assert.equal(completed?.status, 303)
    assert.equal(completed?.headers.get('location'), routes.auth.signIn.index.href())
  })
})
