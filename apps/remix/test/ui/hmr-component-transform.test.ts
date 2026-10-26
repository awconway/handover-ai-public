import { readFile } from 'node:fs/promises'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { transformComponentsForBrowser } from 'remix/component-hmr'

describe('native Remix component HMR', () => {
  it('retains recorder recovery callbacks and checklist reconciliation when transforming browser components', async () => {
    let cases = [
      { file: 'recording-coordinator.tsx', component: 'RecordingCoordinator', callback: 'recoverPendingUpload' },
      { file: 'checklist-editor.tsx', component: 'ChecklistEditor', callback: 'reconcileServerStatuses' },
    ]

    for (let { file, component, callback } of cases) {
      let source = await readFile(new URL(`../../app/assets/${file}`, import.meta.url), 'utf8')
      let result = transformComponentsForBrowser(source, {
        importSource: 'remix',
        moduleUrl: `/assets/app/assets/${file}`,
      })

      assert.equal(result.transformed, true)
      assert.ok(result.componentNames.includes(component))
      // RC.1 drops declarations after the component's first render return. A
      // normal component test passes even when the browser HMR output loses them.
      assert.match(result.code, new RegExp(`\\bfunction ${callback}\\(`))
      assert.match(result.code, new RegExp(`__s__\\.${callback} = ${callback};`))
    }
  })
})
