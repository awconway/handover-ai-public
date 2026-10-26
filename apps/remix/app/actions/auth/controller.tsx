import { createController } from 'remix/router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'

import { endUsabilitySession } from '../../data/repository.ts'
import { DataRuntimeKey } from '../../middleware/data.ts'
import { protectedFormMiddleware } from '../../middleware/forms.ts'
import { routes } from '../../routes.ts'

export default createController(routes.auth, {
  middleware: protectedFormMiddleware,
  actions: {
    async signOut(context) {
      let session = context.get(Session)
      let usabilitySessionId = session.get('usabilitySessionId')
      if (typeof usabilitySessionId === 'string') {
        await endUsabilitySession(context.get(DataRuntimeKey).db, usabilitySessionId)
      }
      session.destroy()
      return redirect(routes.auth.signIn.index.href(), 303)
    },
  },
})
