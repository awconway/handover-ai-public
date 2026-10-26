import type { Handle, RemixNode } from 'remix/component'
import { css } from 'remix/component'
import { ImportMap, type ImportMapData } from 'remix/component/server'

import { routes } from '../routes.ts'

export interface DocumentProps {
  children?: RemixNode
  entryHref?: string
  entryImportMap?: ImportMapData
  entryPreloads?: string[]
  head?: RemixNode
  stylesheetHref?: string
  title?: string
}

const DEFAULT_TITLE = 'Handover AI'

export function Document(handle: Handle<DocumentProps>) {
  return () => {
    let {
      children,
      entryHref = routes.assets.href({ path: 'app/assets/entry.ts' }),
      entryImportMap,
      entryPreloads = [],
      head,
      stylesheetHref = '/assets/app/ui/document.css',
      title = DEFAULT_TITLE,
    } = handle.props

    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="theme-color" content="#334155" />
          <meta name="description" content="Clinical handover workspace" />
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <link rel="stylesheet" href={stylesheetHref} />
          <title>{title}</title>
          {entryImportMap && <ImportMap value={entryImportMap} />}
          {head}
          {entryPreloads.map((href) => (
            <link key={href} rel="modulepreload" href={href} />
          ))}
        </head>
        <body>
          <a href="#main-content" mix={skipLinkStyle}>Skip to main content</a>
          {children}
          <script type="module" src={entryHref}></script>
        </body>
      </html>
    )
  }
}

const skipLinkStyle = css({
  position: 'fixed', top: '8px', left: '8px', zIndex: 1000, padding: '10px 14px', borderRadius: '10px',
  background: '#fff', color: '#172033', transform: 'translateY(-140%)', transition: 'transform 120ms ease',
  '&:focus': { transform: 'translateY(0)' },
})
