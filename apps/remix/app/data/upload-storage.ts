import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob'
import { writeFile } from 'remix/fs'

export type StoredUpload = { key: string; sizeBytes: number; contentType: string; originalFilename: string }
export type UploadInput = { bytes: Buffer; contentType: string; filename: string }
export type UploadPolicy = { maxBytes: number; allowedContentTypes: readonly string[] }

export interface UploadStorage {
  put(input: UploadInput): Promise<StoredUpload>
  /** Stream a web-standard File when the backend supports it. */
  putFile?(file: File): Promise<StoredUpload>
  /**
   * Atomically publish a File under a caller-derived, content-bound key.
   * Implementations must treat an existing identical object as success and
   * must never replace an existing object with different bytes.
   */
  putFileAtKey?(key: string, file: File): Promise<StoredUpload>
  getStream(key: string): Promise<Readable>
  delete(key: string): Promise<boolean>
  healthCheck(): Promise<void>
}

export class UploadValidationError extends Error { status = 413 }

export const audioUploadPolicy: UploadPolicy = {
  maxBytes: 100 * 1024 * 1024,
  allowedContentTypes: ['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
}
export const sheetUploadPolicy: UploadPolicy = {
  maxBytes: 25 * 1024 * 1024,
  allowedContentTypes: ['text/csv', 'text/tab-separated-values', 'text/plain', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
}

function normalizeUploadMetadata(input: { size: number; type: string; name: string }, policy: UploadPolicy) {
  let contentType = input.type.toLowerCase().split(';', 1)[0]!.trim()
  if (!input.size) throw new UploadValidationError('The uploaded file is empty.')
  if (input.size > policy.maxBytes) throw new UploadValidationError(`The uploaded file exceeds the ${policy.maxBytes} byte limit.`)
  if (!policy.allowedContentTypes.includes(contentType)) {
    let error = new UploadValidationError(`Unsupported upload content type: ${contentType || 'unknown'}`)
    error.status = 415
    throw error
  }
  let filename = path.basename(input.name).replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 240) || 'upload.bin'
  return { contentType, filename }
}

function validateSignature(bytes: Uint8Array, contentType: string) {
  let signatureValid = contentType === 'application/pdf' ? Buffer.from(bytes.subarray(0, 5)).toString() === '%PDF-'
    : contentType === 'image/png' ? Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : contentType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : contentType === 'image/heic' || contentType === 'image/heif'
          ? /^ftyp(?:heic|heix|hevc|hevx|mif1|msf1)$/.test(Buffer.from(bytes.subarray(4, 12)).toString('ascii'))
          : true
  if (!signatureValid) {
    let error = new UploadValidationError(`Uploaded bytes do not match ${contentType}.`)
    error.status = 415
    throw error
  }
}

export function validateUpload(input: UploadInput, policy: UploadPolicy): UploadInput {
  let { contentType, filename } = normalizeUploadMetadata({ size: input.bytes.length, type: input.contentType, name: input.filename }, policy)
  validateSignature(input.bytes, contentType)
  return { bytes: input.bytes, contentType, filename }
}

/** Validate metadata and only the small magic-byte prefix, without buffering the file. */
export async function validateUploadFile(file: File, policy: UploadPolicy): Promise<{ file: File; contentType: string; filename: string }> {
  let { contentType, filename } = normalizeUploadMetadata({ size: file.size, type: file.type, name: file.name }, policy)
  validateSignature(new Uint8Array(await file.slice(0, 12).arrayBuffer()), contentType)
  return { file, contentType, filename }
}

/** Hash a staged upload without buffering it in application memory. */
export async function sha256UploadFile(file: File): Promise<string> {
  let hash = createHash('sha256')
  for await (let chunk of Readable.from(file.stream() as AsyncIterable<Uint8Array>)) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * Build a flat object key whose first component is the actual content digest
 * and whose second component isolates the authenticated upload namespace.
 */
export function digestBoundUploadKey(input: {
  contentSha256: string
  scope: string
}): string {
  let contentSha256 = input.contentSha256.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(contentSha256)) throw new TypeError('Upload content digest must be SHA-256.')
  let scopeSha256 = createHash('sha256').update(input.scope).digest('hex')
  // The original filename is deliberately excluded. Equivalent retries share
  // a request fingerprint, so their deterministic storage identity must also
  // be identical even when a browser supplies a different filename/extension.
  return `${contentSha256}-${scopeSha256}.bin`
}

/** Persist a validated upload under the exact deterministic object key. */
export async function storeUploadAtKey(storage: UploadStorage, key: string, file: File): Promise<StoredUpload> {
  if (!storage.putFileAtKey) throw new Error('The configured upload storage does not support deterministic object keys.')
  return storage.putFileAtKey(key, file)
}

function safeExtension(filename: string): string {
  let extension = path.extname(filename).toLowerCase()
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.bin'
}

const randomObjectKeyPattern = /^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/
const digestObjectKeyPattern = /^([a-f0-9]{64})-[a-f0-9]{64}\.[a-z0-9]{1,8}$/

function expectedDigestForObjectKey(key: string): string | null {
  if (randomObjectKeyPattern.test(key)) return null
  let match = key.match(digestObjectKeyPattern)
  if (!match) throw new Error('Invalid upload object key')
  return match[1]!
}

async function assertExistingFileMatches(target: string, expectedDigest: string, expectedSize: number): Promise<void> {
  let metadata = await fsp.stat(target)
  if (metadata.size !== expectedSize) throw new Error('Existing upload object does not match the deterministic key.')
  let hash = createHash('sha256')
  for await (let chunk of fs.createReadStream(target)) hash.update(chunk)
  if (hash.digest('hex') !== expectedDigest) throw new Error('Existing upload object does not match the deterministic key.')
}

export function createFileSystemUploadStorage(rootDirectory: string, policy: UploadPolicy): UploadStorage {
  let root = path.resolve(rootDirectory)
  let resolveKey = (key: string) => {
    expectedDigestForObjectKey(key)
    let target = path.resolve(root, key)
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid upload object key')
    return target
  }
  let storage: UploadStorage = {
    async put(raw) {
      let input = validateUpload(raw, policy)
      return storage.putFile!(new File([Uint8Array.from(input.bytes).buffer], input.filename, { type: input.contentType }))
    },
    async putFile(raw) {
      let input = await validateUploadFile(raw, policy)
      await fsp.mkdir(root, { recursive: true, mode: 0o700 })
      let key = `${randomUUID()}${safeExtension(input.filename)}`
      let target = resolveKey(key)
      let handle = await fsp.open(target, 'wx', 0o600)
      try {
        await writeFile(handle, input.file)
      } catch (error) {
        await fsp.unlink(target).catch(() => {})
        throw error
      } finally {
        await handle.close().catch(() => {})
      }
      return { key, sizeBytes: input.file.size, contentType: input.contentType, originalFilename: input.filename }
    },
    async putFileAtKey(key, raw) {
      let input = await validateUploadFile(raw, policy)
      let expectedDigest = expectedDigestForObjectKey(key)
      if (!expectedDigest) throw new Error('Caller-specified upload keys must be content-bound.')
      await fsp.mkdir(root, { recursive: true, mode: 0o700 })
      let target = resolveKey(key)
      let temporary = path.join(root, `.${key}.${randomUUID()}.tmp`)
      let handle = await fsp.open(temporary, 'wx', 0o600)
      let hash = createHash('sha256')
      try {
        let destination = fs.createWriteStream(temporary, { fd: handle.fd, autoClose: false })
        let source = Readable.from(input.file.stream() as AsyncIterable<Uint8Array>)
        let hashingStream = new Transform({
          transform(chunk, _encoding, callback) {
            hash.update(chunk)
            callback(null, chunk)
          },
        })
        await pipeline(source, hashingStream, destination)
        await handle.sync()
        if (hash.digest('hex') !== expectedDigest) throw new Error('Upload bytes do not match the deterministic object key.')
        try {
          // A hard link publishes the fully flushed temporary inode without
          // replacing a winner from a concurrent retry.
          await fsp.link(temporary, target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          await assertExistingFileMatches(target, expectedDigest, input.file.size)
        }
      } finally {
        await handle.close().catch(() => {})
        await fsp.unlink(temporary).catch(() => {})
      }
      return { key, sizeBytes: input.file.size, contentType: input.contentType, originalFilename: input.filename }
    },
    async getStream(key) { return fs.createReadStream(resolveKey(key)) },
    async delete(key) {
      try {
        await fsp.unlink(resolveKey(key))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    async healthCheck() { await fsp.mkdir(root, { recursive: true, mode: 0o700 }); await fsp.access(root, fs.constants.R_OK | fs.constants.W_OK) },
  }
  return storage
}

export function createAzureUploadStorage(input: {
  connectionString: string; containerName: string; prefix?: string; policy: UploadPolicy
}): UploadStorage {
  if (!input.connectionString.trim()) throw new Error('Azure upload storage connection string is required.')
  if (!input.containerName.trim()) throw new Error('Azure upload storage container name is required.')
  let container: ContainerClient = BlobServiceClient.fromConnectionString(input.connectionString).getContainerClient(input.containerName)
  let prefix = input.prefix?.trim().replace(/^\/+|\/+$/g, '') ?? ''
  if (prefix.split('/').includes('..') || prefix.includes('\\')) throw new Error('Invalid Azure upload prefix')
  let blobName = (key: string) => {
    expectedDigestForObjectKey(key)
    return `${prefix ? `${prefix}/` : ''}${key}`
  }
  let storage: UploadStorage = {
    async put(raw) {
      let value = validateUpload(raw, input.policy)
      return storage.putFile!(new File([Uint8Array.from(value.bytes).buffer], value.filename, { type: value.contentType }))
    },
    async putFile(raw) {
      let value = await validateUploadFile(raw, input.policy)
      await container.createIfNotExists()
      let key = `${randomUUID()}${safeExtension(value.filename)}`
      let source = Readable.from(value.file.stream() as AsyncIterable<Uint8Array>)
      await container.getBlockBlobClient(blobName(key)).uploadStream(source, 4 * 1024 * 1024, 4, {
        blobHTTPHeaders: { blobContentType: value.contentType },
      })
      return { key, sizeBytes: value.file.size, contentType: value.contentType, originalFilename: value.filename }
    },
    async putFileAtKey(key, raw) {
      let value = await validateUploadFile(raw, input.policy)
      let expectedDigest = expectedDigestForObjectKey(key)
      if (!expectedDigest) throw new Error('Caller-specified upload keys must be content-bound.')
      if (await sha256UploadFile(value.file) !== expectedDigest) {
        throw new Error('Upload bytes do not match the deterministic object key.')
      }
      await container.createIfNotExists()
      let client = container.getBlockBlobClient(blobName(key))
      let source = Readable.from(value.file.stream() as AsyncIterable<Uint8Array>)
      try {
        await client.uploadStream(source, 4 * 1024 * 1024, 4, {
          conditions: { ifNoneMatch: '*' },
          blobHTTPHeaders: { blobContentType: value.contentType },
          metadata: { sha256: expectedDigest },
        })
      } catch (error) {
        let statusCode = Number((error as { statusCode?: unknown }).statusCode)
        if (statusCode !== 409 && statusCode !== 412) throw error
        let properties = await client.getProperties()
        if (properties.contentLength !== value.file.size || properties.metadata?.sha256 !== expectedDigest) {
          throw new Error('Existing upload object does not match the deterministic key.')
        }
      }
      return { key, sizeBytes: value.file.size, contentType: value.contentType, originalFilename: value.filename }
    },
    async getStream(key) {
      let response = await container.getBlobClient(blobName(key)).download()
      if (!response.readableStreamBody) throw new Error('Upload object returned no readable stream')
      return response.readableStreamBody as Readable
    },
    async delete(key) { return Boolean((await container.getBlockBlobClient(blobName(key)).deleteIfExists()).succeeded) },
    async healthCheck() { await container.createIfNotExists(); await container.getProperties() },
  }
  return storage
}

export function createConfiguredAudioStorage(): UploadStorage {
  return process.env.AUDIO_STORAGE_BACKEND === 'azure-blob'
    ? createAzureUploadStorage({ connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING ?? '', containerName: process.env.AZURE_AUDIO_CONTAINER_NAME ?? 'handover-audio', prefix: process.env.AZURE_AUDIO_BLOB_PREFIX, policy: audioUploadPolicy })
    : createFileSystemUploadStorage(process.env.AUDIO_STORAGE_DIR ?? 'uploads/audio', audioUploadPolicy)
}

export function createConfiguredSheetStorage(): UploadStorage {
  return process.env.HANDOVER_SHEET_STORAGE_BACKEND === 'azure-blob'
    ? createAzureUploadStorage({ connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING ?? '', containerName: process.env.AZURE_SHEET_CONTAINER_NAME ?? 'handover-sheets', prefix: process.env.AZURE_SHEET_BLOB_PREFIX, policy: sheetUploadPolicy })
    : createFileSystemUploadStorage(process.env.HANDOVER_SHEET_STORAGE_DIR ?? 'uploads/handover-sheets', sheetUploadPolicy)
}
