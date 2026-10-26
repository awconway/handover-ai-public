import * as assert from 'remix/assert'
import { createTestServer } from 'remix/node-fetch-server/test'
import { it } from 'remix/test'
import { renderToStream } from 'remix/component/server'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHandoverAssetServer, getDocumentAssetHrefs } from '../../app/assets.ts'
import { PatientHandoverDialog } from '../../app/assets/patient-handover-dialog.tsx'
import { Document, ModeHomePage } from '../../app/ui/index.ts'

it('loads the real CSS foundations and preserves responsive layouts through hydration', async (t) => {
  let assets = createHandoverAssetServer({ nodeEnv: 'test', watch: false })
  t.after(() => assets.close())
  let hrefs = await getDocumentAssetHrefs(assets)
  let repo = fileURLToPath(new URL('../../../../', import.meta.url))
  let server = await createTestServer(async (request) => {
    if (new URL(request.url).pathname === '/fixture-entry.js') {
      // The app entry awaits app.ready(); expose its completion to this test so
      // a fast click cannot race client-entry hydration on the server HTML.
      return new Response(`await import(${JSON.stringify(hrefs.entryHref)}); document.documentElement.dataset.fixtureReady = 'true';`, {
        headers: { 'Content-Type': 'text/javascript' },
      })
    }
    if (new URL(request.url).pathname.startsWith('/assets/')) {
      return await assets.fetch(request) ?? new Response(null, { status: 404 })
    }
    return new Response(renderToStream(<Document {...hrefs} entryHref="/fixture-entry.js">
      <ModeHomePage
        session={{ user: { id: 'css-fixture', fullName: 'Avery Long Clinician Name', occupation: 'Registered nurse', department: 'General Medicine' } }}
        shiftHref="/shift" individualHref="/individual" signOutAction="/sign-out"
      />
      <PatientHandoverDialog
        action="/create" direction="incoming"
        patient={{ key: 'css-patient', displayName: 'Test patient' }}
        shift={{ id: 'css-shift', title: 'Day shift', department: 'Medicine' }}
      />
    </Document>, {
      async resolveClientEntry(entryId) {
        let entry = new URL(entryId)
        let exportName = entry.hash.slice(1)
        entry.hash = ''
        return { ...await assets.getScriptEntry(path.relative(repo, fileURLToPath(entry))), exportName }
      },
    }), { headers: { 'Content-Type': 'text/html' } })
  })
  let page = await t.serve(server)
  let errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (let width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true')
    await page.locator('[data-testid="mode-home-session-identity"]').waitFor()
    let layout = await page.evaluate(() => {
      let row = document.querySelector('[data-testid="mode-home-session-row"]')!
      let identity = document.querySelector('[data-testid="mode-home-session-identity"]')!
      return {
        wrap: getComputedStyle(row).flexWrap,
        overflow: getComputedStyle(identity).overflowX,
        boxSizing: getComputedStyle(row).boxSizing,
        font: getComputedStyle(document.body).fontFamily,
        theme: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
        pageWidth: document.documentElement.scrollWidth,
      }
    })
    assert.equal(layout.wrap, width < 640 ? 'nowrap' : 'wrap')
    assert.equal(layout.overflow, width < 640 ? 'hidden' : 'visible')
    assert.equal(layout.boxSizing, 'border-box')
    assert.match(layout.font, /Geist Variable/)
    assert.match(layout.theme, /oklch/)
    assert.ok(layout.pageWidth <= width)
    await page.getByRole('button', { name: 'Receiving handover', exact: true }).click()
    let dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    let bounds = await dialog.boundingBox()
    assert.ok(bounds && bounds.width <= width && bounds.x >= 0)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  assert.deepEqual(errors, [])
})

it('hydrates fingerprinted client entries introduced by a later navigation', async (t) => {
  let assets = createHandoverAssetServer({ nodeEnv: 'production' })
  t.after(() => assets.close())
  let hrefs = await getDocumentAssetHrefs(assets)
  let server = await createTestServer(async (request) => {
    let pathname = new URL(request.url).pathname
    if (pathname === '/fixture-entry.js') {
      return new Response(`await import(${JSON.stringify(hrefs.entryHref)}); document.documentElement.dataset.fixtureReady = 'true';`, {
        headers: { 'Content-Type': 'text/javascript' },
      })
    }
    if (pathname.startsWith('/assets/')) {
      return await assets.fetch(request) ?? new Response(null, { status: 404 })
    }
    return new Response(renderToStream(<Document {...hrefs} entryHref="/fixture-entry.js">
      <main id="main-content">
        {pathname === '/handover' ? <PatientHandoverDialog
          action="/create" direction="incoming"
          patient={{ key: 'late-patient', displayName: 'Test patient' }}
          shift={{ id: 'late-shift', title: 'Day shift', department: 'Medicine' }}
        /> : <a href="/handover">Open handover</a>}
      </main>
    </Document>, {
      frameSrc: request.url,
      async resolveClientEntry(entryId) {
        return { ...await assets.getScriptEntry(entryId), exportName: new URL(entryId).hash.slice(1) }
      },
    }), { headers: { 'Content-Type': 'text/html' } })
  })
  let page = await t.serve(server)
  let errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true')
  let timeOrigin = await page.evaluate(() => performance.timeOrigin)
  let initialMaps = await page.locator('script[type="importmap"]').allTextContents()
  assert.doesNotMatch(initialMaps.join(''), /new-handover-form/)

  await page.getByRole('link', { name: 'Open handover', exact: true }).click()
  await page.waitForURL('**/handover')
  await page.evaluate(() => window.navigation.transition?.finished)
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
  let navigatedMaps = await page.locator('script[type="importmap"]').allTextContents()
  assert.ok(navigatedMaps.length > initialMaps.length)
  let newImports = Object.assign({}, ...navigatedMaps.map((value) => JSON.parse(value).imports))
  assert.equal(
    newImports['/assets/app/assets/new-handover-form.tsx'],
    await assets.getHref('apps/remix/app/assets/new-handover-form.tsx'),
  )

  await page.getByRole('button', { name: 'Receiving handover', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
})
