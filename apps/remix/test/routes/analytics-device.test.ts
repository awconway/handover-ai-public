import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { deriveAnalyticsDevice } from '../../app/actions/resources/controller.tsx'

describe('analytics session device metadata', () => {
  it('derives mobile and platform from user agent ahead of viewport fallback', () => {
    assert.deepEqual(
      deriveAnalyticsDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile', { width: 1024, height: 768 }),
      { deviceType: 'mobile', platform: 'ios' },
    )
  })

  it('uses the first event viewport when the user agent has no device signal', () => {
    assert.deepEqual(deriveAnalyticsDevice('', { width: 820, height: 1180 }), { deviceType: 'tablet', platform: 'unknown' })
    assert.deepEqual(deriveAnalyticsDevice('', { width: 1440, height: 900 }), { deviceType: 'desktop', platform: 'unknown' })
  })
})
