import { redirect } from 'remix/response/redirect'
import { requireAuth } from 'remix/middleware/auth'

import { routes } from '../routes.ts'

export type CurrentUser = {
  id: string
  name: string
  department: string | null
  role: string | null
  localFirstProcessingEnabled: boolean
}

export function requireUser() {
  return requireAuth<CurrentUser>({
    onFailure(context) {
      let returnTo = context.url.pathname + context.url.search
      let href = routes.auth.signIn.index.href()
      return redirect(`${href}?returnTo=${encodeURIComponent(returnTo)}`, 303)
    },
  })
}
