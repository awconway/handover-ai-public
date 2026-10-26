import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'

import { frameMarkupOrDocumentNavigation } from '../../app/assets/frame-response.ts'
import { ModeHomePage } from '../../app/ui/auth-pages.tsx'
import { AppShell, WorkspaceSurface } from '../../app/ui/shell.tsx'
import { routes } from '../../app/routes.ts'

async function contentText(content: string | Response) {
  return typeof content === 'string' ? content : await content.text()
}

describe('top-frame document navigation', () => {
  it('uses document navigation only for breadcrumbs that require a fresh workspace', () => {
    let result = render(
      <WorkspaceSurface breadcrumbs={[
        { label: 'Handovers', href: routes.workspace.individual.href(), document: true },
        { label: 'Shifts', href: routes.workspace.shiftSelection.href() },
      ]}>
        <main>Current workspace</main>
      </WorkspaceSurface>,
    )

    try {
      let handovers = result.$(`a[href="${routes.workspace.individual.href()}"]`)
      let shifts = result.$(`a[href="${routes.workspace.shiftSelection.href()}"]`)

      assert.ok(handovers?.hasAttribute('data-rmx-document'))
      assert.equal(handovers?.hasAttribute('data-rmx-target'), false)
      assert.equal(shifts?.getAttribute('data-rmx-target'), 'workspace')
      assert.equal(shifts?.hasAttribute('data-rmx-document'), false)
    } finally {
      result.cleanup()
    }
  })

  it('keeps home, workflow, mode, and inbox responses as document batches', async () => {
    let shell = render(
      <AppShell
        currentUserId="user-1"
        mode="shift"
        homeHref={routes.workspace.home.href()}
        switchHref={routes.workspace.individual.href()}
        inboxHref={routes.workspace.inbox.href()}
        inboxCount={0}
        signInHref={routes.auth.signIn.index.href()}
        signOutAction={routes.auth.signOut.href()}
      >
        <main id="main-content">Shift workspace</main>
      </AppShell>,
    )
    let workflowHome = render(
      <ModeHomePage
        session={{
          user: {
            id: 'user-1',
            fullName: 'Alex Morgan',
            occupation: 'Registrar',
            department: 'Medicine',
          },
        }}
        shiftHref={routes.workspace.shiftSelection.href()}
        individualHref={routes.workspace.individual.href()}
        signOutAction={routes.auth.signOut.href()}
      />,
    )

    try {
      let destinations = [
        shell.$('a[aria-label="Handover AI home"]')?.getAttribute('href'),
        workflowHome.$('a[aria-label="Open shift workflow"]')?.getAttribute('href'),
        shell.$('a[aria-label="Switch to individual mode"]')?.getAttribute('href'),
        shell.$('a[aria-label^="Inbox,"]')?.getAttribute('href'),
      ]

      assert.deepEqual(destinations, [
        routes.workspace.home.href(),
        routes.workspace.shiftSelection.href(),
        routes.workspace.individual.href(),
        routes.workspace.inbox.href(),
      ])

      for (let destination of destinations) {
        assert.ok(destination)
        let navigated: string[] = []
        let document = [
          '<!doctype html>',
          '<html><head><title>Handover AI</title></head>',
          `<body><main data-route="${destination}">Destination</main></body></html>`,
          '<!-- rmx:flush document -->',
          '<template id="workspace">Workspace content</template>',
        ].join('')

        let resolvedContent = await frameMarkupOrDocumentNavigation(
          new Response(document),
          destination,
          undefined,
          (href) => navigated.push(href),
        )
        let resolved = await contentText(resolvedContent)

        assert.equal(resolved, document)
        assert.match(resolved, /rmx:flush document/)
        assert.deepEqual(navigated, [])
      }
    } finally {
      workflowHome.cleanup()
      shell.cleanup()
    }
  })
})
