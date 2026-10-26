import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { Document, InboxPage, LoginPage } from '../../app/ui/index.ts'
import { routes } from '../../app/routes.ts'

const inertAssetHref = 'data:text/plain,'

describe('skip link accessibility', () => {
  it('moves focus to the Inbox main-content target', async () => {
    let result = render(<Document entryHref={inertAssetHref} stylesheetHref={inertAssetHref}>
      <InboxPage
        assignments={[]}
        shifts={[]}
        startShiftHref={routes.workspace.shiftSelection.href()}
      />
    </Document>)
    let skipLink = result.$('a[href="#main-content"]') as HTMLAnchorElement
    let mainContent = result.$('#main-content') as HTMLElement

    assert.equal(mainContent.getAttribute('tabindex'), '-1')
    skipLink.focus()
    assert.equal(document.activeElement, skipLink)

    await result.act(async () => {
      skipLink.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(window.location.hash, '#main-content')
    assert.equal(document.activeElement, mainContent)
    result.cleanup()
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  })

  it('keeps the authentication main-content target programmatically focusable', () => {
    let result = render(<LoginPage
      users={[]}
      signInAction={routes.auth.signIn.action.href()}
      registerAction={routes.auth.register.action.href()}
    />)

    let mainContent = result.$('#main-content') as HTMLElement
    assert.equal(mainContent.getAttribute('tabindex'), '-1')
    mainContent.focus()
    assert.equal(document.activeElement, mainContent)
    result.cleanup()
  })
})
