import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createFsFileStorage } from 'remix/file-storage/fs'
import {
  FormDataParseError,
  MaxFilesExceededError,
  MaxFileSizeExceededError,
  MaxHeaderSizeExceededError,
  MaxPartsExceededError,
  MaxTotalSizeExceededError,
} from 'remix/form-data-parser'
import { formData } from 'remix/middleware/form-data'
import { createMatcher } from 'remix/route-pattern/match'
import { createContextKey, type Middleware } from 'remix/router'

import {
  audioUploadPolicy,
  sheetUploadPolicy,
  UploadValidationError,
  validateUploadFile,
  type UploadPolicy,
  type UploadStorage,
} from '../data/index.ts'
import { routes } from '../routes.ts'

export type UploadStoresValue = { audio: UploadStorage; sheets: UploadStorage }
export const UploadStores = createContextKey<UploadStoresValue>()

export type TemporaryUploadFilesValue = ReadonlyMap<string, File>
export const TemporaryUploadFiles = createContextKey<TemporaryUploadFilesValue>()

const oneMb = 1024 * 1024
const maxNonFileFormBytes = oneMb
const createHandoverUpload = createMatcher(routes.actions.createHandover.pattern)
const extendHandoverUpload = createMatcher(routes.actions.extendHandover.pattern)
const importHandoverSheetUpload = createMatcher(routes.actions.importHandoverSheet.pattern)
const extractHandoverSheetUpload = createMatcher(routes.resources.extractHandoverSheet.pattern)

function expectedUpload(url: URL): { fieldName: 'audio' | 'sheet'; policy: UploadPolicy } | null {
  if (createHandoverUpload.match(url) || extendHandoverUpload.match(url)) {
    return { fieldName: 'audio', policy: audioUploadPolicy }
  }
  if (importHandoverSheetUpload.match(url) || extractHandoverSheetUpload.match(url)) {
    return { fieldName: 'sheet', policy: sheetUploadPolicy }
  }
  return null
}

/** Content-Length ceiling kept in lockstep with the parser's route policy. */
export function uploadRequestBodyLimit(url: URL): number {
  return (expectedUpload(url)?.policy.maxBytes ?? 0) + maxNonFileFormBytes
}

function uploadErrorResponse(url: URL, message: string, status: number): Response {
  return extractHandoverSheetUpload.match(url)
    ? Response.json({ error: message }, { status })
    : new Response(message, { status })
}

function uploadParseError(error: unknown, url: URL): Response | null {
  if (error instanceof UploadValidationError) return uploadErrorResponse(url, error.message, error.status)
  if (
    error instanceof MaxFilesExceededError ||
    error instanceof MaxFileSizeExceededError ||
    error instanceof MaxHeaderSizeExceededError ||
    error instanceof MaxPartsExceededError ||
    error instanceof MaxTotalSizeExceededError
  ) return uploadErrorResponse(url, 'The uploaded form is too large.', 413)
  if (error instanceof FormDataParseError) return uploadErrorResponse(url, 'The submitted form could not be read.', 400)
  return null
}

/**
 * Parse forms once through Remix's streaming upload stack. File parts are staged
 * in request-owned filesystem storage, represented in FormData by opaque tokens,
 * and removed after CSRF validation and the action have both completed.
 */
export function stagedFormData(options: { temporaryRoot?: string } = {}): Middleware<readonly [
  { key: typeof FormData; value: FormData; property: 'formData' },
  { key: typeof TemporaryUploadFiles; value: TemporaryUploadFilesValue },
]> {
  return async (context, next) => {
    let expected = expectedUpload(context.url)
    let temporaryFiles = new Map<string, File>()
    context.set(TemporaryUploadFiles, temporaryFiles)

    let requestDirectory: string | null = null
    let temporaryStorage: ReturnType<typeof createFsFileStorage> | null = null
    let parser = formData({
      maxFiles: expected ? 1 : 0,
      maxFileSize: expected?.policy.maxBytes ?? 64 * 1024,
      maxHeaderSize: 16 * 1024,
      maxParts: 256,
      maxTotalSize: uploadRequestBodyLimit(context.url),
      async uploadHandler(upload) {
        if (!expected || upload.fieldName !== expected.fieldName) {
          let error = new UploadValidationError(`Unexpected uploaded file field: ${upload.fieldName}`)
          error.status = 400
          throw error
        }
        await validateUploadFile(upload, expected.policy)
        if (!requestDirectory) {
          let temporaryRoot = path.resolve(options.temporaryRoot ?? process.env.UPLOAD_TMP_DIR ?? path.join(os.tmpdir(), 'handover-remix-uploads'))
          await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
          requestDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'request-'))
          await fs.chmod(requestDirectory, 0o700)
          temporaryStorage = createFsFileStorage(requestDirectory)
        }
        let token = randomUUID()
        let staged = await temporaryStorage!.put(token, upload)
        temporaryFiles.set(token, staged)
        return token
      },
    })

    try {
      return await parser(context, next)
    } catch (error) {
      let response = uploadParseError(error, context.url)
      if (response) return response
      throw error
    } finally {
      if (requestDirectory) {
        await fs.rm(requestDirectory, { recursive: true, force: true }).catch((error) => {
          console.error('Temporary upload cleanup failed.', error)
        })
      }
    }
  }
}

export function uploadStorage(audio: UploadStorage, sheets: UploadStorage): Middleware<
  { key: typeof UploadStores; value: UploadStoresValue }
> {
  return (context, next) => {
    context.set(UploadStores, { audio, sheets })
    return next()
  }
}
