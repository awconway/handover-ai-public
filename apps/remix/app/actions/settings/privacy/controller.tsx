import * as s from 'remix/data-schema'
import * as f from 'remix/data-schema/form-data'
import { Auth } from 'remix/middleware/auth'
import { getCsrfToken } from 'remix/middleware/csrf'
import { createController } from 'remix/router'
import { redirect } from 'remix/response/redirect'
import { Session } from 'remix/session'

import { documentAssetHrefs } from '../../../assets.ts'
import {
  getLocalFirstProcessingPreferenceForUser,
  isLocalFirstProcessingPreferenceEditable,
  resolveEffectiveProcessingMode,
  resolveLocalFirstProcessingPolicy,
  updateLocalFirstProcessingPreferenceForUser,
} from '../../../data/index.ts'
import { DataRuntimeKey } from '../../../middleware/data.ts'
import { protectedFormMiddleware } from '../../../middleware/forms.ts'
import { routes } from '../../../routes.ts'
import { Document, PrivacySettingsPage } from '../../../ui/index.ts'

const preferenceSchema = f.object({
  enabled: f.field(
    s.defaulted(s.union([s.literal('true'), s.literal('false')]), 'false')
      .transform((value) => value === 'true'),
  ),
})

function currentUserId(context: any): string {
  let auth = context.get(Auth)
  if (!auth.ok || typeof auth.identity?.id !== 'string') {
    throw new Error('Authenticated user missing')
  }
  return auth.identity.id
}

async function renderSettings(context: any) {
  let policy = resolveLocalFirstProcessingPolicy()
  let userEnabled = await getLocalFirstProcessingPreferenceForUser(
    context.get(DataRuntimeKey).db,
    currentUserId(context),
  )
  let session = context.get(Session)
  let notice = session.get('privacySettingsNotice')
  let error = session.get('error')

  return context.render(
    <Document {...documentAssetHrefs} title="Audio privacy · Handover AI">
      <PrivacySettingsPage
        action={routes.settings.privacy.action.href()}
        csrfToken={getCsrfToken(context)}
        homeHref={routes.workspace.home.href()}
        policy={policy}
        userEnabled={userEnabled}
        effectiveMode={resolveEffectiveProcessingMode({ policy, userEnabled })}
        editable={isLocalFirstProcessingPreferenceEditable(policy)}
        notice={typeof notice === 'string' ? notice : undefined}
        error={typeof error === 'string' ? error : undefined}
      />
    </Document>,
  )
}

export default createController(routes.settings.privacy, {
  middleware: protectedFormMiddleware,
  actions: {
    index(context) {
      return renderSettings(context)
    },
    async action(context) {
      let policy = resolveLocalFirstProcessingPolicy()
      if (!isLocalFirstProcessingPreferenceEditable(policy)) {
        return new Response('Audio privacy processing is managed by this deployment.', { status: 409 })
      }

      let parsed = s.parseSafe(preferenceSchema, context.get(FormData))
      if (!parsed.success) {
        return new Response('Choose whether to deidentify transcripts before cloud analysis.', { status: 400 })
      }

      let updated = await updateLocalFirstProcessingPreferenceForUser(
        context.get(DataRuntimeKey).db,
        { userId: currentUserId(context), enabled: parsed.value.enabled },
      )
      if (updated == null) return new Response('Staff profile not found.', { status: 404 })

      context.get(Session).flash(
        'privacySettingsNotice',
        'Audio privacy preference saved. The change applies to future processing jobs.',
      )
      return redirect(routes.settings.privacy.index.href(), 303)
    },
  },
})
