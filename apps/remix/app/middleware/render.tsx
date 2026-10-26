import { render as renderUi } from 'remix/middleware/render'

import { assetServer } from '../assets.ts'

export function render() {
  // The standard renderer owns Frame requests, redirects, request cancellation,
  // and client-entry preloads so these follow the same protocol as the UI runtime.
  return renderUi({
    assets: assetServer,
    onError(error) {
      console.error('Remix render error', error)
    },
  })
}
