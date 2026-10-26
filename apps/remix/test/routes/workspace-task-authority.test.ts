import fs from 'node:fs/promises'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

describe('workspace action authority', () => {
  it('treats an empty persisted action list as authoritative', async () => {
    let source = await fs.readFile(
      new URL('../../app/actions/workspace/controller.tsx', import.meta.url),
      'utf8',
    )

    assert.match(source, /let taskModels = persistedTaskModels\b/)
    assert.doesNotMatch(source, /persistedTaskModels\.length\s*\?[^\n]*analysisTaskModels/)
  })
})
