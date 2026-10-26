import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCookie, type Cookie } from 'remix/cookie'
import { createRouter, type MiddlewareContext } from 'remix/router'
import type { SessionStorage } from 'remix/session'
import { createMemorySessionStorage } from 'remix/session-storage/memory'
import { asyncContext } from 'remix/middleware/async-context'
import { auth, createSessionAuthScheme } from 'remix/middleware/auth'
import { compression } from 'remix/middleware/compression'
import { logger } from 'remix/middleware/logger'
import { session } from 'remix/middleware/session'
import { staticFiles } from 'remix/middleware/static'

import rootController from './actions/controller.tsx'
import actionsController from './actions/actions/controller.tsx'
import authController from './actions/auth/controller.tsx'
import registerController from './actions/auth/register/controller.tsx'
import signInController from './actions/auth/sign-in/controller.tsx'
import privacySettingsController from './actions/settings/privacy/controller.tsx'
import resourcesController from './actions/resources/controller.tsx'
import workspaceController from './actions/workspace/controller.tsx'
import {
  createConfiguredAudioStorage,
  createConfiguredSheetStorage,
  createDataRuntime,
  createHandoverProcessingChanges,
  createPostgresSessionStorage,
  getUser,
  type DataRuntime,
  type HandoverProcessingChanges,
  type UploadStorage,
} from './data/index.ts'
import { dataRuntime } from './middleware/data.ts'
import { handoverProcessingChanges } from './middleware/processing-events.ts'
import { render } from './middleware/render.tsx'
import { uploadRequestBodyLimit, uploadStorage } from './middleware/uploads.ts'
import {
  enforceBodyLimit,
  enforceCanonicalOrigin,
  privateNoStore,
  rejectLegacySessionHeader,
} from './middleware/security.ts'
import { routes } from './routes.ts'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const defaultRuntime = createDataRuntime()
const defaultProcessingEvents = createHandoverProcessingChanges(defaultRuntime.pool.options, {
  onUnavailable(error) {
    console.warn('handover processing event listener unavailable; clients will reconcile on a timer', {
      errorType: error instanceof Error ? error.name : 'UnknownError',
    })
  },
})

export type CreateAppRouterOptions = {
  data?: DataRuntime
  sessionCookie?: Cookie
  sessionStorage?: SessionStorage
  publicOrigins?: readonly string[]
  audioStorage?: UploadStorage
  sheetStorage?: UploadStorage
  processingEvents?: HandoverProcessingChanges
}

function sessionSecret() {
  let configured = process.env.REMIX_SESSION_SECRET ?? process.env.SESSION_SECRET
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('REMIX_SESSION_SECRET or SESSION_SECRET is required in production')
  }
  return 'test-only-handover-remix-session-secret'
}

function createSessionCookie(): Cookie {
  let production = process.env.NODE_ENV === 'production'
  return createCookie(production ? '__Host-handover-remix' : 'handover-remix-session', {
    secrets: [sessionSecret()],
    httpOnly: true,
    sameSite: 'Lax',
    secure: production,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
}

export function createAppRouter(options: CreateAppRouterOptions = {}) {
  let data = options.data ?? defaultRuntime
  let cookie = options.sessionCookie ?? createSessionCookie()
  let storage =
    options.sessionStorage ??
    (process.env.NODE_ENV === 'test'
      ? createMemorySessionStorage()
      : createPostgresSessionStorage(data.db))
  let origins =
    options.publicOrigins ??
    (process.env.PUBLIC_ORIGIN
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [
        'http://localhost:8787',
        'http://127.0.0.1:8787',
        'http://localhost:44100',
        'http://127.0.0.1:44100',
      ])
  let audioStorage = options.audioStorage ?? createConfiguredAudioStorage()
  let sheetStorage = options.sheetStorage ?? createConfiguredSheetStorage()
  let processingEvents = options.processingEvents ?? defaultProcessingEvents

  let sessionMiddleware = session(cookie, storage)
  let dataMiddleware = dataRuntime(data)
  let processingEventsMiddleware = handoverProcessingChanges(processingEvents)
  let uploadMiddleware = uploadStorage(audioStorage, sheetStorage)
  let authMiddleware = auth({
    schemes: [
      createSessionAuthScheme({
        read(currentSession) {
          let value = currentSession.get('auth')
          return value && typeof value === 'object' && 'userId' in value
            ? (value as { userId: string })
            : null
        },
        async verify(value) {
          let user = await getUser(data.db, value.userId)
          return user
            ? {
                id: user.id,
                name: user.full_name,
                department: user.department,
                role: user.occupation,
                localFirstProcessingEnabled: user.local_first_processing_enabled === true,
              }
            : null
        },
        invalidate(currentSession) {
          currentSession.unset('auth')
        },
      }),
    ],
  })

  let middleware = [
    ...(process.env.NODE_ENV === 'development' ? [logger()] : []),
    compression(),
    staticFiles(path.resolve(appDir, '../public'), { index: false }),
    // Keep the cheap Content-Length guard aligned with each upload route's
    // parser policy instead of granting every action the 100 MiB audio ceiling.
    enforceBodyLimit(uploadRequestBodyLimit),
    rejectLegacySessionHeader(),
    enforceCanonicalOrigin(origins),
    sessionMiddleware,
    asyncContext(),
    dataMiddleware,
    processingEventsMiddleware,
    uploadMiddleware,
    authMiddleware,
    privateNoStore(),
    render(),
  ] as const

  let appRouter = createRouter<AppContext>({ middleware })
  appRouter.map(routes, rootController)
  appRouter.map(routes.auth, authController)
  appRouter.map(routes.auth.signIn, signInController)
  appRouter.map(routes.auth.register, registerController)
  appRouter.map(routes.settings.privacy, privacySettingsController)
  appRouter.map(routes.workspace, workspaceController)
  appRouter.map(routes.actions, actionsController)
  appRouter.map(routes.resources, resourcesController)
  return appRouter
}

type AppContext = MiddlewareContext<
  readonly [
    ReturnType<typeof session>,
    ReturnType<typeof asyncContext>,
    ReturnType<typeof dataRuntime>,
    ReturnType<typeof handoverProcessingChanges>,
    ReturnType<typeof uploadStorage>,
    ReturnType<typeof auth>,
    ReturnType<typeof render>,
  ]
>

declare module 'remix' {
  interface RouterTypes {
    context: AppContext
  }
}

export const data = defaultRuntime
export const processingEvents = defaultProcessingEvents
export const router = createAppRouter({ data })
