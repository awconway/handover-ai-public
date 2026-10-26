import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import {
  convertHeifToJpeg,
  handoverSheetColumns,
  MAX_HANDOVER_SHEET_ROWS,
  parseHandoverSheetCsv,
  parseOpenAIHandoverSheetExtraction,
} from '../../app/data/handover-sheet.ts'
import {
  audioUploadPolicy,
  createAzureUploadStorage,
  createFileSystemUploadStorage,
  digestBoundUploadKey,
  sha256UploadFile,
  sheetUploadPolicy,
  validateUpload,
} from '../../app/data/upload-storage.ts'

describe('native upload and handover sheet services', () => {
  it('validates content type and size before persistence', () => {
    assert.throws(() => validateUpload({ bytes: Buffer.from('x'), contentType: 'text/html', filename: 'bad.html' }, audioUploadPolicy), /Unsupported/)
    assert.throws(() => validateUpload({ bytes: Buffer.alloc(0), contentType: 'audio/webm', filename: 'empty.webm' }, audioUploadPolicy), /empty/)
  })

  it('round-trips filesystem audio and rejects unsafe object keys', async () => {
    let root = await fs.mkdtemp(path.join(os.tmpdir(), 'remix-upload-'))
    let storage = createFileSystemUploadStorage(root, audioUploadPolicy)
    try {
      let stored = await storage.put({ bytes: Buffer.from('audio-bytes'), contentType: 'audio/webm', filename: '../../handover.webm' })
      assert.match(stored.key, /^[a-f0-9-]{36}\.webm$/)
      let chunks: Buffer[] = []
      for await (let chunk of await storage.getStream(stored.key)) chunks.push(Buffer.from(chunk))
      assert.equal(Buffer.concat(chunks).toString(), 'audio-bytes')
      await assert.rejects(() => storage.getStream('../secret'), /Invalid upload object key/)
      assert.equal(await storage.delete(stored.key), true)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('streams a web File through filesystem storage without requiring an UploadInput buffer', async () => {
    let root = await fs.mkdtemp(path.join(os.tmpdir(), 'remix-file-upload-'))
    let storage = createFileSystemUploadStorage(root, audioUploadPolicy)
    try {
      let file = new File(['streamed-audio'], '../recording.webm', { type: 'audio/webm' })
      let stored = await storage.putFile!(file)
      assert.equal(stored.sizeBytes, file.size)
      assert.equal(stored.originalFilename, 'recording.webm')
      let chunks: Buffer[] = []
      for await (let chunk of await storage.getStream(stored.key)) chunks.push(Buffer.from(chunk))
      assert.equal(Buffer.concat(chunks).toString(), 'streamed-audio')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('atomically reuses a caller-specified content-bound filesystem key without overwriting bytes', async () => {
    let root = await fs.mkdtemp(path.join(os.tmpdir(), 'remix-deterministic-upload-'))
    let storage = createFileSystemUploadStorage(root, audioUploadPolicy)
    try {
      let file = new File(['same recording bytes'], 'recording.webm', { type: 'audio/webm' })
      let key = digestBoundUploadKey({
        contentSha256: await sha256UploadFile(file),
        scope: 'user:upload:request',
      })
      assert.match(key, /\.bin$/)
      assert.equal(key, digestBoundUploadKey({
        contentSha256: await sha256UploadFile(new File(['same recording bytes'], 'retry.ogg', { type: 'audio/webm' })),
        scope: 'user:upload:request',
      }))
      let [first, retry] = await Promise.all([
        storage.putFileAtKey!(key, file),
        storage.putFileAtKey!(key, file),
      ])
      assert.equal(first.key, retry.key)
      assert.equal((await fs.readdir(root)).filter((name) => !name.startsWith('.')).length, 1)
      await assert.rejects(
        () => storage.putFileAtKey!(key, new File(['other recording byte'], 'recording.webm', { type: 'audio/webm' })),
        /do not match the deterministic object key/,
      )
      let chunks: Buffer[] = []
      for await (let chunk of await storage.getStream(key)) chunks.push(Buffer.from(chunk))
      assert.equal(Buffer.concat(chunks).toString(), 'same recording bytes')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('parses quoted CSV rows into canonical reviewable fields', () => {
    let patients = parseHandoverSheetCsv('Bed,Name,Alerts / Allergies,Diagnosis,Planning\n12,"Doe, Jane",Penicillin,"Heart failure","Review, Monday"')
    assert.equal(patients.length, 1)
    assert.equal(patients[0]!.displayName, 'Doe, Jane')
    assert.equal(patients[0]!.fields.find((field) => field.columnKey === 'planning')?.value, 'Review, Monday')
    assert.equal(patients[0]!.fields.find((field) => field.columnKey === 'alerts_allergies')?.reviewStatus, 'needs_review')
  })

  it('rejects CSV sheets above the bounded patient-row limit', () => {
    let rows = Array.from({ length: MAX_HANDOVER_SHEET_ROWS + 1 }, (_, index) => `${index + 1},Patient ${index + 1}`)
    assert.throws(
      () => parseHandoverSheetCsv(`Bed,Name\n${rows.join('\n')}`),
      /at most 5000 patient rows/i,
    )
  })

  it('persists detailed model uncertainty, alternatives, and image-quality evidence', () => {
    let cells = Object.fromEntries(handoverSheetColumns.map((column) => [column, {
      verbatim: column === 'bed' ? '3A-01' : column === 'name' ? 'Molly Harper' : '',
      uncertain: false,
      alternatives: [],
      issue: 'none',
    }])) as Record<string, { verbatim: string | null; uncertain: boolean; alternatives: string[]; issue: string }>
    cells.diagnosis = {
      verbatim: 'Seps1s',
      uncertain: true,
      alternatives: ['Sepsis', 'Septic illness', 'Seps1s', 'Sepsis'],
      issue: 'ambiguous_characters',
    }
    let patients = parseOpenAIHandoverSheetExtraction({
      templateDetected: true,
      imageIssue: 'glare',
      extractionComplete: true,
      omittedRowCount: null,
      rows: [{ rowNumber: 1, cells }],
    })

    assert.equal(patients.length, 1)
    assert.equal(patients[0]!.fields.length, 11)
    let diagnosis = patients[0]!.fields.find((field) => field.columnKey === 'diagnosis')!
    assert.equal(diagnosis.value, 'Seps1s')
    assert.equal(diagnosis.reviewStatus, 'needs_review')
    assert.equal(diagnosis.reviewMethod, 'llm')
    assert.equal(diagnosis.uncertain, true)
    assert.equal(diagnosis.llmAdjudicatedValue, 'Seps1s')
    assert.equal(diagnosis.llmUncertain, true)
    assert.equal(diagnosis.llmIssue, 'ambiguous_characters')
    assert.deepEqual(diagnosis.alternatives, ['Sepsis', 'Septic illness'])
    assert.deepEqual(diagnosis.imageQualityIssues, [
      'Glare may obscure document text.',
      'This cell contains ambiguous characters.',
    ])
    assert.ok(diagnosis.issues.includes('native_llm_document_glare'))
    assert.ok(diagnosis.issues.includes('native_llm_cell_ambiguous_characters'))
  })

  it('rejects incomplete document-model extractions instead of silently dropping rows', () => {
    assert.throws(() => parseOpenAIHandoverSheetExtraction({
      templateDetected: true,
      imageIssue: 'cropped',
      extractionComplete: false,
      omittedRowCount: 2,
      rows: [],
    }), /2 patient rows may be missing/)
  })

  it('accepts valid HEIC/HEIF signatures and cleans conversion scratch files', async () => {
    let heif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.from('payload')])
    assert.equal(validateUpload({ bytes: heif, contentType: 'image/heic', filename: 'phone.heic' }, sheetUploadPolicy).contentType, 'image/heic')
    let scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'remix-heif-test-')), conversionDirectory = ''
    try {
      let jpeg = await convertHeifToJpeg(heif, { tempRoot: scratch, async converter(_input, output) {
        conversionDirectory = path.dirname(output)
        await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      } })
      assert.equal(jpeg[0], 0xff)
      await assert.rejects(() => fs.access(conversionDirectory))
    } finally { await fs.rm(scratch, { recursive: true, force: true }) }
  })

  it('bounds converted image output and rejects incomplete Azure config', async () => {
    let heif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheif'), Buffer.from('payload')])
    await assert.rejects(() => convertHeifToJpeg(heif, { maxOutputBytes: 3, async converter(_input, output) {
      await fs.writeFile(output, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    } }), /exceeds/)
    assert.throws(() => createAzureUploadStorage({ connectionString: '', containerName: 'audio', policy: audioUploadPolicy }), /connection string is required/)
  })
})
