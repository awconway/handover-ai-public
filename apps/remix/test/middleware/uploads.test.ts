import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as assert from 'remix/assert'
import { createRouter } from 'remix/router'
import { post, route } from 'remix/routes'
import { describe, it } from 'remix/test'

import { fileUpload } from '../../app/actions/upload-input.ts'
import { stagedFormData, TemporaryUploadFiles } from '../../app/middleware/uploads.ts'
import { routes as appRoutes } from '../../app/routes.ts'

const fixtureRoutes = route({
  audio: post(appRoutes.actions.createHandover.href()),
  sheet: post(appRoutes.resources.extractHandoverSheet.href()),
})

describe('Remix staged upload middleware', () => {
  it('accepts audio above the parser 2 MiB default, scopes its token, and cleans temporary storage', async () => {
    let temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-upload-middleware-'))
    let firstToken = ''
    try {
      let router = createRouter({ middleware: [stagedFormData({ temporaryRoot })] })
      router.map(fixtureRoutes, {
        actions: {
          async audio(context) {
            let form = context.get(FormData)
            let token = form.get('audio')
            let files = context.get(TemporaryUploadFiles)
            let file = fileUpload(form, files, 'audio')
            if (!firstToken && typeof token === 'string') firstToken = token
            return Response.json({ tokenPresent: typeof token === 'string' && files.has(token), size: file?.size ?? 0 })
          },
          sheet() {
            return new Response(null, { status: 204 })
          },
        },
      })

      let body = new FormData()
      body.set('audio', new File([new Uint8Array(3 * 1024 * 1024)], 'handover.webm', { type: 'audio/webm' }))
      let response = await router.fetch(new Request('http://localhost' + fixtureRoutes.audio.href(), { method: 'POST', body }))
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { tokenPresent: true, size: 3 * 1024 * 1024 })
      assert.match(firstToken, /^[a-f0-9-]{36}$/)
      assert.deepEqual(await fs.readdir(temporaryRoot), [])

      let replay = new FormData()
      replay.set('audio', firstToken)
      response = await router.fetch(new Request('http://localhost' + fixtureRoutes.audio.href(), { method: 'POST', body: replay }))
      assert.deepEqual(await response.json(), { tokenPresent: false, size: 0 })
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  it('rejects sheets above 25 MiB as JSON before the resource action runs', async () => {
    let temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-upload-limit-'))
    let handled = false
    try {
      let router = createRouter({ middleware: [stagedFormData({ temporaryRoot })] })
      router.map(fixtureRoutes, {
        actions: {
          audio() {
            return new Response(null, { status: 204 })
          },
          sheet() {
            handled = true
            return new Response(null, { status: 204 })
          },
        },
      })
      let body = new FormData()
      body.set('sheet', new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'too-large.csv', { type: 'text/csv' }))
      let response = await router.fetch(new Request('http://localhost' + fixtureRoutes.sheet.href(), { method: 'POST', body }))
      assert.equal(response.status, 413)
      assert.deepEqual(await response.json(), { error: 'The uploaded form is too large.' })
      assert.equal(handled, false)
      assert.deepEqual(await fs.readdir(temporaryRoot), [])
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})
