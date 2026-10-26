import { completeAuth } from 'remix/auth'
import * as s from 'remix/data-schema'
import { minLength, maxLength } from 'remix/data-schema/checks'
import * as f from 'remix/data-schema/form-data'
import { createController } from 'remix/router'
import { redirect } from 'remix/response/redirect'
import { nanoid } from 'nanoid'

import { upsertUser } from '../../../data/index.ts'
import { DataRuntimeKey } from '../../../middleware/data.ts'
import { publicFormMiddleware } from '../../../middleware/forms.ts'
import { routes } from '../../../routes.ts'
import { safeInternalPath } from '../../../utils/internal-path.ts'

const registerSchema = f.object({
  fullName: f.field(s.string().pipe(minLength(2), maxLength(80))),
  occupation: f.field(s.string().pipe(minLength(2), maxLength(80))),
  department: f.field(s.string().pipe(minLength(1), maxLength(80))),
})

export default createController(routes.auth.register, {
  middleware: publicFormMiddleware,
  actions: {
    index() {
      return redirect(routes.auth.signIn.index.href(), 303)
    },
    async action(context) {
      let parsed = s.parseSafe(registerSchema, context.get(FormData))
      if (!parsed.success) {
        return new Response('Name, occupation, and department are required.', { status: 400 })
      }

      let user = await upsertUser(context.get(DataRuntimeKey).db, {
        id: nanoid(),
        ...parsed.value,
      })
      let session = completeAuth(context)
      session.set('auth', { userId: user.id })
      return redirect(
        safeInternalPath(context.url.searchParams.get('returnTo')) ?? routes.workspace.home.href(),
        303,
      )
    },
  },
})
