import { completeAuth } from 'remix/auth'
import * as s from 'remix/data-schema'
import * as f from 'remix/data-schema/form-data'
import { getCsrfToken } from 'remix/middleware/csrf'
import { createController } from 'remix/router'
import { redirect } from 'remix/response/redirect'

import { documentAssetHrefs } from '../../../assets.ts'
import { getUser, listUsers } from '../../../data/index.ts'
import { DataRuntimeKey } from '../../../middleware/data.ts'
import { publicFormMiddleware } from '../../../middleware/forms.ts'
import { routes } from '../../../routes.ts'
import { Document, LoginPage } from '../../../ui/index.ts'
import { safeInternalPath } from '../../../utils/internal-path.ts'

const signInSchema = f.object({ userId: f.field(s.string()) })

function safeReturnTo(value: string | null) {
  return safeInternalPath(value) ?? routes.workspace.home.href()
}

async function renderLogin(context: Parameters<typeof renderLoginPage>[0], error?: string) {
  return renderLoginPage(context, error)
}

async function renderLoginPage(
  context: {
    get(key: typeof DataRuntimeKey): import('../../../middleware/data.ts').DataRuntime
    render(node: unknown, init?: ResponseInit): Response
    url: URL
  },
  error?: string,
) {
  let users = await listUsers(context.get(DataRuntimeKey).db)
  let returnTo = safeReturnTo(context.url.searchParams.get('returnTo'))
  let signInAction = routes.auth.signIn.action.href()
  if (returnTo !== routes.workspace.home.href()) signInAction += `?returnTo=${encodeURIComponent(returnTo)}`
  let registerAction = routes.auth.register.action.href()
  if (returnTo !== routes.workspace.home.href()) registerAction += `?returnTo=${encodeURIComponent(returnTo)}`
  return context.render(
    <Document {...documentAssetHrefs} title="Sign in · Handover AI"><LoginPage
      users={users.map((user) => ({
        id: user.id,
        fullName: user.full_name,
        occupation: user.occupation,
        department: user.department,
      }))}
      signInAction={signInAction}
      registerAction={registerAction}
      csrfToken={getCsrfToken(context as never)}
      analyticsAction={process.env.USABILITY_ANALYTICS_ENABLED?.toLowerCase() === 'false' ? undefined : routes.resources.analytics.href()}
      error={error}
    /></Document>,
    error ? { status: 400 } : undefined,
  )
}

export default createController(routes.auth.signIn, {
  middleware: publicFormMiddleware,
  actions: {
    index(context) {
      return renderLogin(context)
    },
    async action(context) {
      let parsed = s.parseSafe(signInSchema, context.get(FormData))
      if (!parsed.success) return renderLogin(context, 'Choose a staff profile to continue.')

      let user = await getUser(context.get(DataRuntimeKey).db, parsed.value.userId)
      if (!user) return renderLogin(context, 'That staff profile could not be found.')

      let session = completeAuth(context)
      session.set('auth', { userId: user.id })
      return redirect(safeReturnTo(context.url.searchParams.get('returnTo')), 303)
    },
  },
})
