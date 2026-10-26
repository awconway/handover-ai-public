import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { privateNoStore } from '../../app/middleware/security.ts'
import { routes } from '../../app/routes.ts'

describe('response cache policy', () => {
  it('preserves Remix asset revalidation headers', async () => {
    let response = await privateNoStore()(
      {
        url: new URL(
          'http://localhost' + routes.assets.href({ path: 'app/assets/entry.ts' }),
        ),
      } as any,
      async () => new Response('asset', { headers: { 'Cache-Control': 'no-cache', ETag: '"asset"' } }),
    )

    assert.equal(response?.headers.get('Cache-Control'), 'no-cache')
    assert.equal(response?.headers.get('ETag'), '"asset"')
  })

  it('keeps clinical responses private and cookie-varying', async () => {
    let response = await privateNoStore()(
      {
        url: new URL('http://localhost' + routes.workspace.shiftSelection.href()),
      } as any,
      async () => new Response('workspace'),
    )

    assert.equal(response?.headers.get('Cache-Control'), 'private, no-store')
    assert.match(response?.headers.get('Vary') ?? '', /Cookie/)
  })
})
