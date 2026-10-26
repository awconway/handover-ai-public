import type { RecordingRequest } from './recording-events.ts'

const databaseName = 'handover-ai-recordings'
const databaseVersion = 2
const storeName = 'pending-uploads'
const chunkStoreName = 'pending-upload-chunks'
const completedMarkerPrefix = 'handover-ai:recording-upload-complete:'
export const pendingRecordingRecoveryTtlMs = 24 * 60 * 60 * 1_000

type StoredFormEntry = {
  name: string
  value: string | Blob
  filename?: string
}

type StoredRecordingChunk = {
  uploadId: string
  sequence: number
  value: Blob
}

export type PendingRecordingUpload = {
  id: string
  ownerUserId: string
  createdAt: number
  updatedAt: number
  captureComplete: boolean
  formId: string
  submitAction: string
  uploadAction?: string
  csrfToken?: string
  contextLabel?: string
  mode?: 'create' | 'extend'
  restartCue?: string
  restartCueTitle?: string
  restartCueSubtitle?: string
  restartCues?: RecordingRequest['restartCues']
  formEntries: StoredFormEntry[]
  audio: Blob
  recordedMimeType: string
}

/**
 * IndexedDB keeps a completed capture available across reloads and tab closes.
 * Only one recorder can be active, but records are independently keyed so a
 * failed cleanup can never overwrite a newer capture.
 */
export function createPendingRecordingUpload(
  request: RecordingRequest,
  audio: Blob,
  recordedMimeType: string,
  ownerUserId: string,
  captureComplete = true,
): PendingRecordingUpload {
  let now = Date.now()
  return {
    id: createRecordingUploadId(),
    ownerUserId,
    createdAt: now,
    updatedAt: now,
    captureComplete,
    formId: request.formId,
    submitAction: request.submitAction,
    uploadAction: request.uploadAction,
    csrfToken: request.csrfToken,
    contextLabel: request.contextLabel,
    mode: request.mode,
    restartCue: request.restartCue,
    restartCueTitle: request.restartCueTitle,
    restartCueSubtitle: request.restartCueSubtitle,
    restartCues: request.restartCues?.map((cue) => ({ ...cue })),
    formEntries: serializeFormData(request.formData),
    audio,
    recordedMimeType,
  }
}

/** Create a UUID accepted by the server even on browsers without randomUUID. */
export function createRecordingUploadId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random values are unavailable.')

  let bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  // RFC 9562 UUIDv4 version and variant bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  let hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

export function requestFromPendingRecordingUpload(upload: PendingRecordingUpload): RecordingRequest {
  let formData = new FormData()
  for (let entry of upload.formEntries) {
    if (typeof entry.value === 'string') formData.append(entry.name, entry.value)
    else formData.append(entry.name, entry.value, entry.filename)
  }

  return {
    formId: upload.formId,
    submitAction: upload.submitAction,
    uploadAction: upload.uploadAction,
    csrfToken: upload.csrfToken,
    contextLabel: upload.contextLabel,
    mode: upload.mode,
    restartCue: upload.restartCue,
    restartCueTitle: upload.restartCueTitle,
    restartCueSubtitle: upload.restartCueSubtitle,
    restartCues: upload.restartCues?.map((cue) => ({ ...cue })),
    formData,
  }
}

export async function savePendingRecordingUpload(upload: PendingRecordingUpload): Promise<void> {
  let database = await openDatabase()
  try {
    let transaction = database.transaction(storeName, 'readwrite')
    let completed = transactionComplete(transaction)
    transaction.objectStore(storeName).put(upload)
    await completed
  } finally {
    database.close()
  }
}

/** Append-only capture persistence avoids rebuilding an ever-growing Blob. */
export async function appendPendingRecordingChunk(
  upload: PendingRecordingUpload,
  value: Blob,
  sequence: number,
): Promise<void> {
  let database = await openDatabase()
  try {
    let transaction = database.transaction([storeName, chunkStoreName], 'readwrite')
    let completed = transactionComplete(transaction)
    transaction.objectStore(storeName).put(upload)
    transaction.objectStore(chunkStoreName).put({ uploadId: upload.id, sequence, value } satisfies StoredRecordingChunk)
    await completed
  } finally {
    database.close()
  }
}

export async function loadPendingRecordingUploads(now = Date.now()): Promise<PendingRecordingUpload[]> {
  let database = await openDatabase()
  try {
    // Readwrite lets every normal recovery pass clean records created before
    // owner scoping and capture completeness were introduced. Leaving those
    // legacy clinical Blobs behind would make them both inaccessible and
    // impossible for any signed-in user to explicitly discard.
    let transaction = database.transaction([storeName, chunkStoreName], 'readwrite')
    let completed = transactionComplete(transaction)
    let uploadStore = transaction.objectStore(storeName)
    let chunkStore = transaction.objectStore(chunkStoreName)
    let uploadRequest = uploadStore.getAll()
    let chunkRequest = chunkStore.getAll()
    let [uploads, chunks] = await Promise.all([
      requestResult<unknown[]>(uploadRequest),
      requestResult<StoredRecordingChunk[]>(chunkRequest),
    ])
    let currentUploads = uploads
      .filter(isCurrentPendingRecordingUpload)
      .filter((upload) => now - upload.updatedAt <= pendingRecordingRecoveryTtlMs)
    let invalidIds = new Set(uploads
      .filter((upload) => !isCurrentPendingRecordingUpload(upload)
        || now - upload.updatedAt > pendingRecordingRecoveryTtlMs)
      .map((upload) => typeof upload === 'object' && upload !== null && 'id' in upload ? (upload as { id?: unknown }).id : undefined)
      .filter((id): id is string => typeof id === 'string'))
    for (let id of invalidIds) uploadStore.delete(id)
    for (let chunk of chunks) {
      if (invalidIds.has(chunk.uploadId)) chunkStore.delete([chunk.uploadId, chunk.sequence])
    }
    await completed
    let chunksByUpload = new Map<string, StoredRecordingChunk[]>()
    for (let chunk of chunks) {
      let values = chunksByUpload.get(chunk.uploadId) ?? []
      values.push(chunk)
      chunksByUpload.set(chunk.uploadId, values)
    }
    return currentUploads
      .map((upload) => {
        if (upload.captureComplete && upload.audio.size) return upload
        let values = (chunksByUpload.get(upload.id) ?? []).sort((left, right) => left.sequence - right.sequence)
        return values.length
          ? { ...upload, audio: new Blob(values.map((chunk) => chunk.value), { type: upload.recordedMimeType }) }
          : upload
      })
      .filter((upload) => upload.audio.size > 0)
      .sort((left, right) => left.createdAt - right.createdAt)
  } finally {
    database.close()
  }
}

export async function deletePendingRecordingUpload(id: string): Promise<void> {
  let database = await openDatabase()
  try {
    let transaction = database.transaction([storeName, chunkStoreName], 'readwrite')
    let completed = transactionComplete(transaction)
    transaction.objectStore(storeName).delete(id)
    let chunkStore = transaction.objectStore(chunkStoreName)
    let chunkKeys = await requestResult<IDBValidKey[]>(chunkStore.index('uploadId').getAllKeys(IDBKeyRange.only(id)))
    for (let key of chunkKeys) chunkStore.delete(key)
    await completed
  } finally {
    database.close()
  }
}

/**
 * A synchronous, opaque completion marker prevents a successful request from
 * being replayed if the browser closes between the response and IndexedDB
 * cleanup. The marker contains no clinical content.
 */
export function markPendingRecordingUploaded(id: string): void {
  try { localStorage.setItem(`${completedMarkerPrefix}${id}`, '1') } catch { /* Storage may be disabled. */ }
}

export function wasPendingRecordingUploaded(id: string): boolean {
  try { return localStorage.getItem(`${completedMarkerPrefix}${id}`) === '1' } catch { return false }
}

export function clearPendingRecordingUploadedMarker(id: string): void {
  try { localStorage.removeItem(`${completedMarkerPrefix}${id}`) } catch { /* Storage may be disabled. */ }
}

function serializeFormData(formData: FormData): StoredFormEntry[] {
  return Array.from(formData.entries(), ([name, value]) => {
    if (typeof value === 'string') return { name, value }
    let filename = typeof File !== 'undefined' && value instanceof File ? value.name : undefined
    return { name, value, filename }
  })
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'))

  return new Promise((resolve, reject) => {
    let request = indexedDB.open(databaseName, databaseVersion)
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: 'id' })
      }
      if (!request.result.objectStoreNames.contains(chunkStoreName)) {
        let chunks = request.result.createObjectStore(chunkStoreName, { keyPath: ['uploadId', 'sequence'] })
        chunks.createIndex('uploadId', 'uploadId')
      }
      // Version-one records predate user ownership and capture-completeness
      // metadata. Purge them inside the upgrade transaction so their clinical
      // audio cannot become an ownerless, undiscardable browser orphan.
      let uploadStore = request.transaction?.objectStore(storeName)
      let cursorRequest = uploadStore?.openCursor()
      cursorRequest?.addEventListener('success', () => {
        let cursor = cursorRequest.result
        if (!cursor) return
        if (!isCurrentPendingRecordingUpload(cursor.value)) cursor.delete()
        cursor.continue()
      })
    })
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error ?? new Error('Could not open recording storage.')), { once: true })
    request.addEventListener('blocked', () => reject(new Error('Recording storage upgrade was blocked.')), { once: true })
  })
}

function isCurrentPendingRecordingUpload(value: unknown): value is PendingRecordingUpload {
  if (!value || typeof value !== 'object') return false
  let upload = value as Partial<PendingRecordingUpload>
  return typeof upload.id === 'string'
    && typeof upload.ownerUserId === 'string'
    && upload.ownerUserId.length > 0
    && typeof upload.captureComplete === 'boolean'
    && typeof upload.createdAt === 'number'
    && Number.isFinite(upload.createdAt)
    && typeof upload.updatedAt === 'number'
    && Number.isFinite(upload.updatedAt)
    && upload.audio instanceof Blob
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error ?? new Error('Recording storage request failed.')), { once: true })
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Recording storage transaction was aborted.')), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('Recording storage transaction failed.')), { once: true })
  })
}
