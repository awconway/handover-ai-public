import * as assert from 'remix/assert'
import { createTestServer } from 'remix/node-fetch-server/test'
import { it } from 'remix/test'
import { renderToStream } from 'remix/component/server'
import { css } from 'remix/component'

import { createHandoverAssetServer, getDocumentAssetHrefs } from '../../app/assets.ts'
import { PatientActionsPanel } from '../../app/assets/patient-actions-panel.tsx'
import { FrameMutationForm } from '../../app/assets/frame-form.tsx'
import { Document } from '../../app/ui/document.tsx'
import { frameMutationRequestHeader, frameMutationRequestValue } from '../../app/utils/frame-mutation.ts'

for (let nodeEnv of ['development', 'production'] as const) {
  it(`hydrates styled mutation forms on first Actions navigation with ${nodeEnv} assets`, async (t) => {
    let assets = createHandoverAssetServer({
      nodeEnv,
      watch: nodeEnv === 'development',
      ...(nodeEnv === 'development' ? { hmrChannel: () => ({
        url: '/hmr-events',
        onFileEvents: () => () => {},
        updateWatchedFiles: () => {},
        close: () => {},
      }) } : {}),
    })
    t.after(() => assets.close())
    let hrefs = await getDocumentAssetHrefs(assets)
    let finishMutation: (() => void) | undefined
    let reviewed = false
    let startMutation: (() => void) | undefined
    let mutationStarted = new Promise<void>((resolve) => { startMutation = resolve })
    let server = await createTestServer(async (request) => {
      let pathname = new URL(request.url).pathname
      if (pathname === '/review' && request.method === 'POST') {
        await new Promise<void>((resolve) => { finishMutation = resolve; startMutation?.() })
        reviewed = !reviewed
        return new Response(null, { status: 204 })
      }
      if (pathname === '/fixture-entry.js') {
        return new Response(`await import(${JSON.stringify(hrefs.entryHref)}); document.documentElement.dataset.fixtureReady = 'true';`, {
          headers: { 'Content-Type': 'text/javascript' },
        })
      }
      if (pathname === '/hmr-events') return new Response(null, { status: 204 })
      if (pathname.startsWith('/assets/')) {
        return await assets.fetch(request) ?? new Response(null, { status: 404 })
      }
      return new Response(renderToStream(<Document {...hrefs} entryHref="/fixture-entry.js">
        <main id="main-content">
          {pathname === '/actions' ? <><FrameMutationForm action="/review" testId="styled-review-form"><input type="hidden" name="reviewed" value={String(!reviewed)} /><button type="submit" mix={css({ color: 'blue' })}>{reviewed ? 'Mark unreviewed' : 'Mark reviewed'}</button></FrameMutationForm><PatientActionsPanel
            createAction="/tasks/create"
            inlineCreate
            patientOptions={[{ key: 'p1', label: 'Patient A · Bed 1' }]}
            tasks={[1, 2, 3].map((id) => ({
              id: String(id), label: `Review action ${id}`, patientKey: 'p1', completed: false,
              dueAt: id === 1 ? '2026-10-20T04:00:00.000Z' : undefined,
              updateAction: `/tasks/${id}/update`, deleteAction: `/tasks/${id}/delete`,
            }))}
          /></> : <a href="/actions">Open actions</a>}
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
    page.on('console', (message) => { if (message.type() === 'error' && message.text().includes('Remix UI error')) errors.push(message.text()) })
    await page.goto('/')
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === 'true')
    await page.getByRole('link', { name: 'Open actions', exact: true }).click()
    await page.waitForURL('**/actions')
    await page.evaluate(() => window.navigation.transition?.finished)
    await page.getByTestId('task-sort').click()
    await page.getByRole('option', { name: 'Action Z–A', exact: true }).click()
    assert.equal(await page.locator('[data-testid^="patient-task-row-"]').count(), 3)
    await page.waitForFunction(() => document.querySelector('[data-testid^="patient-task-row-"]')?.getAttribute('data-testid') === 'patient-task-row-3')
    assert.match(await page.locator('[data-testid^="patient-task-row-"]').first().textContent() ?? '', /Review action 3/)

    let requestPromise = page.waitForRequest((request) => request.url().endsWith('/review') && request.method() === 'POST')
    await page.getByRole('button', { name: 'Mark reviewed', exact: true }).click()
    let request = await requestPromise
    assert.equal(request.headers()[frameMutationRequestHeader.toLowerCase()], frameMutationRequestValue)
    await mutationStarted
    await page.waitForFunction(() => document.querySelector('[data-testid="styled-review-form"]')?.getAttribute('aria-busy') === 'true')
    finishMutation?.()
    await page.waitForFunction(() => document.querySelector('[data-testid="styled-review-form"]')?.getAttribute('aria-busy') === null)
    await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).waitFor()
    assert.equal(await page.locator('input[name="reviewed"]').inputValue(), 'false')
    assert.equal(await page.getByRole('button', { name: 'Mark unreviewed', exact: true }).evaluate((element) => getComputedStyle(element).color), 'rgb(0, 0, 255)')
    assert.deepEqual(errors, [], JSON.stringify(errors))
  })
}
