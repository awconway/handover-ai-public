import fs from 'node:fs/promises'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

async function workerSource(): Promise<string> {
  return fs.readFile(new URL('../../worker.ts', import.meta.url), 'utf8')
}

function between(source: string, start: string, end: string): string {
  let startIndex = source.indexOf(start)
  let endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `Expected worker source to contain ${start}`)
  assert.notEqual(endIndex, -1, `Expected worker source to contain ${end}`)
  return source.slice(startIndex, endIndex)
}

describe('worker persistence contracts', () => {
  it('gives required DSPy predictions a bounded retry within the configured timeout budget', async () => {
    let source = await workerSource()
    let prediction = between(source, 'async function predict', 'function hasCurrentLease')

    assert.match(prediction, /let maxAttempts = 2/)
    assert.match(prediction, /Math\.floor\(timeoutMs \/ maxAttempts\)/)
    assert.match(prediction, /attempt < maxAttempts/)
    assert.match(prediction, /response\.status === 408 \|\| response\.status === 429 \|\| response\.status >= 500/)
    assert.match(prediction, /DspyPredictionError/)
  })

  it('treats heartbeat exceptions as transient and only a false renewal as lease loss', async () => {
    let source = await workerSource()
    let processing = between(source, 'async function processJob', 'async function processNextAudioCleanup')
    let heartbeat = between(processing, 'let heartbeat = setInterval', 'heartbeat.unref()')

    assert.match(heartbeat, /then\(\(renewed\) => \{ if \(!renewed\) lostLease = true \}\)/)
    assert.match(heartbeat, /heartbeat temporarily unavailable/)
    assert.doesNotMatch(heartbeat, /catch\([^)]*\)\s*=>\s*\{\s*lostLease = true/s)
  })

  it('replaces only transcript-derived tasks and preserves user-owned task sources', async () => {
    let source = await workerSource()
    let persistence = between(source, 'async function persistCompletedAnalysis', 'function safeProcessingError')

    assert.match(
      persistence,
      /delete from handover_tasks where handover_id = \$\{job\.handover_id} and source = 'transcript'/,
    )
    assert.match(
      persistence,
      /result\.taskProjections\.filter\(\(projection\) => projection\.source === 'transcript'\)/,
    )
    assert.match(
      persistence,
      /insert into handover_tasks[\s\S]*on conflict \(handover_id, patient_key, related_uncertainty_id\)[\s\S]*where related_uncertainty_id is not null[\s\S]*do nothing/,
    )
    assert.doesNotMatch(
      persistence,
      /delete from handover_tasks where handover_id = \$\{job\.handover_id}\s*`/,
    )
  })

  it('stores only bounded provider run metadata and never the transcript or model output', async () => {
    let source = await workerSource()
    let transcriptionMetadata = between(
      source,
      'function transcriptionRunMetadata',
      'async function completeTranscriptionRun',
    )
    let analysisMetadata = between(
      source,
      'function analysisRunMetadata',
      'async function persistCompletedAnalysis',
    )

    assert.match(transcriptionMetadata, /segmentCount:/)
    assert.match(transcriptionMetadata, /durationMs:/)
    assert.match(transcriptionMetadata, /transcription_elapsed_ms:/)
    assert.doesNotMatch(transcriptionMetadata, /\btranscript\s*:/)
    assert.doesNotMatch(transcriptionMetadata, /result\.transcript/)

    assert.match(analysisMetadata, /checklistItemCount:/)
    assert.match(analysisMetadata, /patientCount:/)
    assert.match(analysisMetadata, /taskCount:/)
    assert.doesNotMatch(analysisMetadata, /\btranscript\s*:/)
    assert.doesNotMatch(analysisMetadata, /result\.analysis\.(?:headline|overview|structuredSummary)/)
  })

  it('persists an analysis-only retry marker and the appended segment count atomically with transcription', async () => {
    let source = await workerSource()
    let completion = between(
      source,
      'async function completeTranscriptionRun',
      'async function markHandoverAnalysing',
    )

    assert.match(completion, /retryFrom: 'analysis'/)
    assert.match(completion, /audioCleanupJobId: processedAudioBlobKey \? job\.id : undefined/)
    assert.match(completion, /processedAudioBlobKey \? \{ audioBlobKey: processedAudioBlobKey \} : \{\}/)
    assert.match(completion, /job\.kind === 'extend'/)
    assert.match(completion, /retrySegmentCount: Math\.max\(1, newSegmentCount\)/)
    assert.match(completion, /update handovers set transcript = \$\{result\.transcript}/)
    assert.match(completion, /update handover_jobs set payload = \$\{JSON\.stringify\(retryPayload\)}/)
    assert.match(completion, /scheduleSuccessfulTranscriptionAudioCleanupInTransaction\(tx/)
    assert.match(completion, /processedAudioBlobKey/)
  })

  it('repairs the post-transcription cleanup scheduling window on an analysis-only retry', async () => {
    let source = await workerSource()
    let processing = between(source, 'async function processJob', 'async function processNextAudioCleanup')
    let retryBranch = between(processing, 'if (analysisRetry)', '} else {')
    let cleanup = between(source, 'async function scheduleProcessedAudioCleanup', 'class RequiredAudioDeletionError')

    assert.match(retryBranch, /scheduleProcessedAudioCleanup\(/)
    assert.match(retryBranch, /payloadString\(job\.payload\.audioBlobKey\)/)
    assert.match(cleanup, /let cleanupJobId = payloadString\(job\.payload\.audioCleanupJobId\)/)
    assert.match(cleanup, /job\.payload\.retryFrom === 'analysis'/)
    assert.match(cleanup, /!payloadString\(job\.payload\.manualTranscript\)/)
    assert.match(cleanup, /confirmRequiredDeletion/)
    assert.match(processing, /transcribed\.processedAudioBlobKey/)
  })

  it('confirms required audio deletion before any local-first cloud analysis request', async () => {
    let source = await workerSource()
    let cleanup = between(
      source,
      'async function scheduleProcessedAudioCleanup',
      'class RequiredAudioDeletionError',
    )
    let processing = between(source, 'async function processJob', 'async function processNextAudioCleanup')
    let cleanupIndex = processing.lastIndexOf('await scheduleProcessedAudioCleanup(')
    let analysisIndex = processing.indexOf("stage = 'analysis'")
    let predictionIndex = processing.indexOf('predictWithLocalPrivacy(')

    assert.match(cleanup, /deletionRequired/)
    assert.match(cleanup, /confirmRequiredDeletion/)
    assert.match(cleanup, /audioCleanupJobId/)
    assert.match(cleanup, /isSuccessfulTranscriptionAudioDeletionConfirmed\(result\)/)
    assert.match(cleanup, /throw new RequiredAudioDeletionError\(\)/)
    assert.ok(cleanupIndex >= 0)
    assert.ok(analysisIndex > cleanupIndex)
    assert.ok(predictionIndex > analysisIndex)
    assert.match(processing, /createDeidentifiedAnalysisRequester/)
    assert.match(processing, /createDeidentifiedSheetReconciliationRequester/)
  })

  it('persists an admin-required local-first upgrade before any fallible processing', async () => {
    let source = await workerSource()
    let processing = between(source, 'async function processJob', 'async function processNextAudioCleanup')
    let modeIndex = processing.indexOf('let processingMode = processingModeForJob(')
    let ratchetIndex = processing.indexOf('job.payload = await persistProcessingModeRatchet(')
    let branchIndex = processing.indexOf('if (analysisRetry)')

    assert.ok(modeIndex >= 0)
    assert.ok(ratchetIndex > modeIndex)
    assert.ok(branchIndex > ratchetIndex)
  })

  it('rejects remote storage before any local-first raw-audio analysis starts', async () => {
    let source = await workerSource()
    let transcription = between(
      source,
      'async function transcribeForJob',
      'async function scheduleProcessedAudioCleanup',
    )
    let compatibilityIndex = transcription.indexOf('!isLocalFirstAudioStorageBackendCompatible()')
    let noiseIndex = transcription.indexOf('let noisePromise =')

    assert.ok(compatibilityIndex >= 0)
    assert.ok(noiseIndex > compatibilityIndex)
  })

  it('keeps later shift prioritisation behind local deidentification for local-first history', async () => {
    let source = await fs.readFile(
      new URL('../../app/domain/shift-prioritisation.server.ts', import.meta.url),
      'utf8',
    )
    let controller = await fs.readFile(
      new URL('../../app/actions/actions/controller.tsx', import.meta.url),
      'utf8',
    )

    assert.match(source, /handoversHaveLocalFirstProcessingHistory\(db, privacySourceIds\)/)
    assert.match(source, /requiresLocalPrivacy/)
    assert.match(source, /options\.localFirstRequester\?\.\(denyTerms\)/)
    assert.match(controller, /createDeidentifiedShiftPrioritisationRequester/)
  })

  it('falls back to a full retained-transcript analysis when an extension has no durable prior analysis', async () => {
    let source = await workerSource()
    let processing = between(source, 'async function processJob', 'async function processNextAudioCleanup')

    assert.match(
      processing,
      /let analysisMode:[\s\S]*job\.kind === 'extend' && existingAnalysis[\s\S]*\? 'continuation'[\s\S]*: 'full'/,
    )
    assert.match(
      processing,
      /if \(job\.kind === 'extend' && !existingAnalysis\)[\s\S]*analysisInput = \{ transcript, metadata \}/,
    )
    assert.match(processing, /notes: analysisMode === 'continuation'/)
    assert.match(processing, /analysisMode,/)
    assert.match(
      processing,
      /fullAnalysisRecoveryPrivacyCleanupIsProvable\([\s\S]*previous transcript recording cleanup provenance is unavailable/,
    )
    let confirmationIndex = processing.indexOf('await confirmRequiredPrivacyAudioCleanupDependencies(')
    let predictionIndex = processing.indexOf('predictWithLocalPrivacy(')
    assert.ok(confirmationIndex >= 0)
    assert.ok(predictionIndex > confirmationIndex)
  })

  it('merges an extension against the latest locked clinician state at commit time', async () => {
    let source = await workerSource()
    let persistence = between(source, 'async function persistCompletedAnalysis', 'function safeProcessingError')
    let processing = between(source, 'async function processJob', 'export async function runWorker')

    let leaseIndex = persistence.indexOf(
      'assertCurrentLease(tx, job, workerId, { lockRows: true })',
    )
    let reloadIndex = persistence.indexOf(
      'readExistingAnalysisResult(tx, job, { lockProjectionRows: true })',
    )
    let mergeIndex = persistence.indexOf(
      'mergeHandoverContinuation(latest, incoming)',
    )
    let updateIndex = persistence.indexOf('update handovers set analysis =')

    assert.ok(leaseIndex >= 0)
    assert.ok(reloadIndex > leaseIndex)
    assert.ok(mergeIndex > reloadIndex)
    assert.ok(updateIndex > mergeIndex)
    assert.match(
      processing,
      /persistCompletedAnalysis\(runtime\.db, job, workerId, activeAnalysisRunId, incomingAnalysis, handover\)/,
    )
    assert.doesNotMatch(processing, /mergeHandoverContinuation/)
  })

  it('commits final analysis with React-equivalent title and participant metadata', async () => {
    let source = await workerSource()
    let persistence = between(source, 'async function persistCompletedAnalysis', 'function safeProcessingError')

    assert.match(persistence, /handover\.contextType === 'shift-handover'/)
    assert.match(persistence, /result\.analysis\.titleSuggestion\.trim\(\)/)
    assert.match(persistence, /result\.analysis\.participants\.length/)
    assert.match(persistence, /title = \$\{finalTitle\}, participants = \$\{JSON\.stringify\(finalParticipants\)\}::jsonb/)
    assert.match(persistence, /completeHandoverJob/)
  })

  it('overlays commit-boundary clinician metadata on initial and continuation analysis', async () => {
    let source = await workerSource()
    let persistence = between(source, 'async function persistCompletedAnalysis', 'function safeProcessingError')

    assert.match(
      persistence,
      /select title, participants, participants_edited, linked_patient_key,[\s\S]*linked_patient_location, analysis/,
    )
    assert.match(
      persistence,
      /job\.kind === 'create'[\s\S]*\? preserveCreateReviewMetadata\(result/,
    )
    assert.match(persistence, /preserveExtensionReviewMetadata\(result, initialReviewMetadata, currentReviewMetadata\)/)
    assert.match(persistence, /result = reviewMetadata\.result/)
    assert.match(persistence, /reviewMetadata\.titleOverride \?\? generatedTitle/)
    assert.match(persistence, /reviewMetadata\.participantsOverride/)
    assert.match(persistence, /participantsEdited: currentRow\.participants_edited === true/)
    assert.match(
      persistence,
      /job\.kind === 'extend'[\s\S]*readExistingAnalysisResult\(tx, job, \{ lockProjectionRows: true \}\)/,
    )
  })

  it('reconciles the persisted completed revision without failing the saved handover', async () => {
    let source = await workerSource()
    let processing = between(source, 'async function processJob', 'async function processNextAudioCleanup')
    let persistenceIndex = processing.indexOf('await persistCompletedAnalysis(')
    let reconciliationIndex = processing.indexOf('await reconcileStoredHandoverSheetWithSbar(')
    let localCatchIndex = processing.indexOf("console.warn('handover sheet SBAR reconciliation failed'")

    assert.ok(persistenceIndex >= 0)
    assert.ok(reconciliationIndex > persistenceIndex)
    assert.ok(localCatchIndex > reconciliationIndex)
    assert.doesNotMatch(
      between(processing, "console.warn('handover sheet SBAR reconciliation failed'", 'completed = true'),
      /error\.message/,
    )
  })
})
