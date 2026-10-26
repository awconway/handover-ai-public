import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { safeInternalPath } from '../../app/utils/internal-path.ts'

describe('safe internal navigation paths', () => {
  it('preserves valid local paths with search and hash', () => {
    assert.equal(safeInternalPath('/shift/one?tab=actions#main'), '/shift/one?tab=actions#main')
  })

  it('rejects protocol-relative and backslash redirect variants', () => {
    assert.equal(safeInternalPath('//evil.example/path'), null)
    assert.equal(safeInternalPath('/\\evil.example/path'), null)
    assert.equal(safeInternalPath('https://evil.example/path'), null)
  })
})
