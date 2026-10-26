import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { Frame } from 'remix/component'
import { renderToString } from 'remix/component/server'
import { render } from 'remix/component/test'

import { WorkspaceTitleCoordinator } from '../../app/assets/workspace-title-coordinator.tsx'
import { routes } from '../../app/routes.ts'
import { WorkspaceSurface } from '../../app/ui/shell.tsx'

describe('workspace document titles', () => {
  it('applies a title after the coordinator commits', async () => {
    let previousTitle = document.title
    let result = render(<WorkspaceTitleCoordinator title="Day shift · Handover AI" />)

    try {
      await result.act(() => {})
      assert.equal(document.title, 'Day shift · Handover AI')
    } finally {
      result.cleanup()
      document.title = previousTitle
    }
  })

  it('propagates the initial and reconciled Frame titles to the document head', async () => {
    let previousTitle = document.title
    let actionsHref = routes.workspace.patientTab.href({
      shiftId: 'day-shift',
      patientKey: 'alex-test',
      patientWorkspaceTab: 'actions',
    })
    let shiftHref = routes.workspace.shift.href({ shiftId: 'day-shift' })
    let responses = new Map([
      [actionsHref, await renderToString(
        <WorkspaceSurface documentTitle="Alex Test · Actions · Handover AI">
          <main>Alex Test actions</main>
        </WorkspaceSurface>,
      )],
      [shiftHref, await renderToString(
        <WorkspaceSurface documentTitle="Day shift · Handover AI">
          <main>Day shift workspace</main>
        </WorkspaceSurface>,
      )],
    ])
    assert.match(responses.get(actionsHref) ?? '', /data-workspace-document-title="Alex Test · Actions · Handover AI"/)
    let result = render(
      <Frame name="workspace" src={actionsHref} fallback={<p>Loading workspace</p>} />,
      {
        frameInit: {
          resolveFrame(src) {
            let response = responses.get(src)
            if (!response) throw new Error(`Unexpected workspace Frame source: ${src}`)
            return response
          },
          loadModule(_moduleUrl, exportName) {
            if (/^WorkspaceTitleCoordinator\d*$/.test(exportName)) return WorkspaceTitleCoordinator
            throw new Error(`Unexpected workspace client entry: ${exportName}`)
          },
        },
      },
    )

    async function waitForTitle(title: string) {
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        result.root.flush()
        if (document.title === title) return
      }
      assert.equal(document.title, title)
    }

    try {
      await waitForTitle('Alex Test · Actions · Handover AI')
      assert.match(result.container.textContent ?? '', /Alex Test actions/)

      result.root.render(<Frame name="workspace" src={shiftHref} fallback={<p>Loading workspace</p>} />)
      result.root.flush()

      await waitForTitle('Day shift · Handover AI')
      assert.match(result.container.textContent ?? '', /Day shift workspace/)
    } finally {
      result.cleanup()
      document.title = previousTitle
    }
  })
})
