export type TranscriptSpeaker = 'giver' | 'receiver' | 'unknown'
export type TranscriptFlag = 'bookmark' | 'query' | 'interrupt' | 'noise' | 'unclear' | 'handoff-critical'

export type TranscriptSegment = {
  id: string
  startMs: number
  endMs: number
  text: string
  speaker: TranscriptSpeaker
  confidence: number | null
  flags: TranscriptFlag[]
}

export type AudioNoiseMetrics = {
  available: boolean
  score: number
  analysedDurationMs: number
  speechDurationMs: number
  maskedSpeechDurationMs: number
  maskedSpeechRatio: number
  severeLowMarginSpeechDurationMs: number
  severeLowMarginSpeechRatio: number
  longestLowMarginRunSeconds: number
  averageSpeechSnrDb: number | null
  estimatedNoiseFloorDbfs: number | null
  burstCount: number
  burstsNearSpeech: number
  sustainedNoiseDurationMs: number
  sustainedNoiseRatio: number
  bursts: Array<{
    startMs: number
    endMs: number
    peakDbfs: number | null
    severity: 'low' | 'medium' | 'high'
  }>
  affectedSections: Array<{
    startMs: number
    endMs: number
    level: 'some' | 'high' | 'veryHigh'
    reason: 'none' | 'speech_hard_to_hear' | 'disruptive_noise_events' | 'persistent_background_noise' | 'mixed'
  }>
  backgroundNoiseConcern: {
    level: 'none' | 'some' | 'high' | 'veryHigh'
    action: 'none' | 'review_before_submitting' | 'check_key_details' | 'confirm_key_details'
    reason: 'none' | 'speech_hard_to_hear' | 'disruptive_noise_events' | 'persistent_background_noise' | 'mixed'
    message: string | null
    showTimestamps: boolean
  }
}

export type TranscriptionMetadata = {
  engine: string
  mocked: boolean
  language: string
  durationMs: number
  transcriptionElapsedMs?: number
  interruptionSignals: string[]
  noiseSignals: string[]
  audioNoise: AudioNoiseMetrics
  segments: TranscriptSegment[]
}

export type TranscriptionResult = {
  transcript: string
  metadata: TranscriptionMetadata
}

export type TranscriptionInput = {
  manualTranscript?: string | null
  audioBlobKey?: string | null
  audioOriginalFilename?: string | null
  mockContext?: string
}

export type TranscriptionExtensionInput = TranscriptionInput & {
  previousTranscript: string
  previousMetadata?: TranscriptionMetadata | null
}

export type TranscriptionEnvironment = Readonly<Record<string, string | undefined>>

export type TranscriptionService = {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>
  transcribeExtension(input: TranscriptionExtensionInput): Promise<TranscriptionResult>
}

export type TranscriptionServiceDependencies = {
  transcribeAudio: (input: {
    audioBlobKey: string
    originalFilename?: string | null
  }) => Promise<TranscriptionResult>
  env?: TranscriptionEnvironment
  mockTranscript?: (input: TranscriptionInput) => string
}

export function createEmptyAudioNoiseMetrics(): AudioNoiseMetrics {
  return {
    available: false,
    score: 0,
    analysedDurationMs: 0,
    speechDurationMs: 0,
    maskedSpeechDurationMs: 0,
    maskedSpeechRatio: 0,
    severeLowMarginSpeechDurationMs: 0,
    severeLowMarginSpeechRatio: 0,
    longestLowMarginRunSeconds: 0,
    averageSpeechSnrDb: null,
    estimatedNoiseFloorDbfs: null,
    burstCount: 0,
    burstsNearSpeech: 0,
    sustainedNoiseDurationMs: 0,
    sustainedNoiseRatio: 0,
    bursts: [],
    affectedSections: [],
    backgroundNoiseConcern: {
      level: 'none',
      action: 'none',
      reason: 'none',
      message: null,
      showTimestamps: false,
    },
  }
}

function detectSpeaker(text: string): TranscriptSpeaker {
  let bracketLabel = text.match(/^\[([^\]]+)]\s*:/)?.[1]?.replace(/[_-]+/g, ' ') ?? ''
  if (/\b(outgoing|giver)\b/i.test(bracketLabel) || /^giver:/i.test(text)) return 'giver'
  if (/\b(incoming|receiver)\b/i.test(bracketLabel) || /^receiver:/i.test(text)) return 'receiver'
  return 'unknown'
}

function detectFlags(text: string): TranscriptFlag[] {
  let value = text.toLowerCase()
  let flags: TranscriptFlag[] = []
  if (value.includes('interrupt') || value.includes('restart')) flags.push('interrupt')
  if (value.includes('noise') || value.includes('alarm') || value.includes('background')) flags.push('noise')
  if (value.includes('unsure') || value.includes('unclear')) flags.push('unclear')
  if (value.includes('needs') || value.includes('must') || value.includes('urgent')) flags.push('handoff-critical')
  return [...new Set(flags)]
}

export function buildTranscriptSegments(transcript: string): TranscriptSegment[] {
  let cursor = 0
  return transcript.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    let duration = Math.max(2_200, line.split(/\s+/).length * 420)
    let segment: TranscriptSegment = {
      id: `segment-${index + 1}`,
      startMs: cursor,
      endMs: cursor + duration,
      text: line,
      speaker: detectSpeaker(line),
      confidence: 0.93,
      flags: detectFlags(line),
    }
    cursor += duration
    return segment
  })
}

function buildMetadata(input: {
  segments: TranscriptSegment[]
  engine: string
  mocked: boolean
  language?: string | null
  durationMs?: number | null
  audioNoise?: AudioNoiseMetrics
}): TranscriptionMetadata {
  let segmentDuration = input.segments.at(-1)?.endMs ?? 0
  let suppliedDuration = input.durationMs != null && Number.isFinite(input.durationMs)
    ? Math.max(0, Math.round(input.durationMs))
    : 0
  return {
    engine: input.engine,
    mocked: input.mocked,
    language: input.language?.trim() || 'en',
    durationMs: Math.max(segmentDuration, suppliedDuration),
    interruptionSignals: input.segments.filter((segment) => segment.flags.includes('interrupt')).map((segment) => segment.text),
    noiseSignals: input.segments.filter((segment) => segment.flags.includes('noise')).map((segment) => segment.text),
    audioNoise: input.audioNoise ?? createEmptyAudioNoiseMetrics(),
    segments: input.segments,
  }
}

export function createManualTranscription(manualTranscript: string): TranscriptionResult {
  let transcript = manualTranscript.trim()
  if (!transcript) throw new Error('Manual transcript is empty.')
  let segments = buildTranscriptSegments(transcript)
  return {
    transcript,
    metadata: buildMetadata({ segments, engine: 'manual-entry', mocked: false }),
  }
}

function defaultMockTranscript(input: TranscriptionInput): string {
  let label = input.mockContext?.trim() || input.audioBlobKey?.trim() || 'handover'
  return `[OUTGOING_NURSE]: Mock transcription for ${label}.`
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function normaliseSegments(segments: TranscriptSegment[], startingIndex: number, offsetMs: number): TranscriptSegment[] {
  return segments.map((segment, index) => ({
    ...segment,
    id: `segment-${startingIndex + index + 1}`,
    startMs: segment.startMs + offsetMs,
    endMs: segment.endMs + offsetMs,
  }))
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0
}

function mergeAudioNoise(previous: AudioNoiseMetrics, next: AudioNoiseMetrics, offsetMs: number): AudioNoiseMetrics {
  let levels = ['none', 'some', 'high', 'veryHigh'] as const
  let concern = levels.indexOf(next.backgroundNoiseConcern.level) > levels.indexOf(previous.backgroundNoiseConcern.level)
    ? next.backgroundNoiseConcern
    : previous.backgroundNoiseConcern
  let speechDurationMs = previous.speechDurationMs + next.speechDurationMs
  let analysedDurationMs = previous.analysedDurationMs + next.analysedDurationMs
  let maskedSpeechDurationMs = previous.maskedSpeechDurationMs + next.maskedSpeechDurationMs
  let severeLowMarginSpeechDurationMs = previous.severeLowMarginSpeechDurationMs + next.severeLowMarginSpeechDurationMs
  let sustainedNoiseDurationMs = previous.sustainedNoiseDurationMs + next.sustainedNoiseDurationMs
  return {
    available: previous.available || next.available,
    score: Math.max(previous.score, next.score),
    analysedDurationMs,
    speechDurationMs,
    maskedSpeechDurationMs,
    maskedSpeechRatio: ratio(maskedSpeechDurationMs, speechDurationMs),
    severeLowMarginSpeechDurationMs,
    severeLowMarginSpeechRatio: ratio(severeLowMarginSpeechDurationMs, speechDurationMs),
    longestLowMarginRunSeconds: Math.max(previous.longestLowMarginRunSeconds, next.longestLowMarginRunSeconds),
    averageSpeechSnrDb: next.averageSpeechSnrDb ?? previous.averageSpeechSnrDb,
    estimatedNoiseFloorDbfs: next.estimatedNoiseFloorDbfs ?? previous.estimatedNoiseFloorDbfs,
    burstCount: previous.burstCount + next.burstCount,
    burstsNearSpeech: previous.burstsNearSpeech + next.burstsNearSpeech,
    sustainedNoiseDurationMs,
    sustainedNoiseRatio: ratio(sustainedNoiseDurationMs, analysedDurationMs),
    bursts: [
      ...previous.bursts,
      ...next.bursts.map((burst) => ({ ...burst, startMs: burst.startMs + offsetMs, endMs: burst.endMs + offsetMs })),
    ],
    affectedSections: [
      ...previous.affectedSections,
      ...next.affectedSections.map((section) => ({ ...section, startMs: section.startMs + offsetMs, endMs: section.endMs + offsetMs })),
    ],
    backgroundNoiseConcern: { ...concern },
  }
}

export function appendTranscriptToExisting(input: {
  previousTranscript: string
  previousMetadata?: TranscriptionMetadata | null
  nextTranscript: string
  nextMetadata: TranscriptionMetadata
}): TranscriptionResult {
  let transcript = [input.previousTranscript.trim(), input.nextTranscript.trim()].filter(Boolean).join('\n')
  let previousMetadata = input.previousMetadata ?? (input.previousTranscript.trim()
    ? createManualTranscription(input.previousTranscript).metadata
    : buildMetadata({ segments: [], engine: 'manual-entry', mocked: false }))
  let previousSegments = normaliseSegments(previousMetadata.segments, 0, 0)
  let offsetMs = previousSegments.at(-1)?.endMs ?? 0
  let nextSegments = normaliseSegments(input.nextMetadata.segments, previousSegments.length, offsetMs)
  let audioNoise = mergeAudioNoise(previousMetadata.audioNoise, input.nextMetadata.audioNoise, offsetMs)
  return {
    transcript,
    metadata: {
      engine: unique([previousMetadata.engine, input.nextMetadata.engine].filter(Boolean)).join(' + '),
      mocked: previousMetadata.mocked && input.nextMetadata.mocked,
      language: input.nextMetadata.language || previousMetadata.language || 'en',
      durationMs: nextSegments.at(-1)?.endMs ?? previousSegments.at(-1)?.endMs ?? 0,
      transcriptionElapsedMs: input.nextMetadata.transcriptionElapsedMs,
      interruptionSignals: unique([...previousMetadata.interruptionSignals, ...input.nextMetadata.interruptionSignals]),
      noiseSignals: unique([...previousMetadata.noiseSignals, ...input.nextMetadata.noiseSignals]),
      audioNoise,
      segments: [...previousSegments, ...nextSegments],
    },
  }
}

/**
 * Recovers the newly appended portion of a durable combined transcript for an
 * analysis-only extension retry. The queue stores the appended segment count
 * atomically with the combined transcript, so retry never retranscribes or
 * sends the prior handover through continuation analysis again.
 */
export function sliceTranscriptionTail(
  input: TranscriptionResult,
  segmentCount: number,
): TranscriptionResult {
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
    throw new RangeError('segmentCount must be a positive integer.')
  }
  if (segmentCount > input.metadata.segments.length) {
    throw new RangeError('The appended transcript segment count is no longer available.')
  }
  let source = input.metadata.segments.slice(-segmentCount)
  let offsetMs = source[0]?.startMs ?? 0
  let segments = source.map((segment, index) => ({
    ...segment,
    id: `segment-${index + 1}`,
    startMs: Math.max(0, segment.startMs - offsetMs),
    endMs: Math.max(0, segment.endMs - offsetMs),
  }))
  let engine = input.metadata.engine.split(' + ').map((value) => value.trim()).filter(Boolean).at(-1)
    ?? input.metadata.engine
  return {
    transcript: segments.map((segment) => segment.text).join('\n'),
    metadata: {
      engine,
      mocked: input.metadata.mocked,
      language: input.metadata.language,
      durationMs: segments.at(-1)?.endMs ?? 0,
      transcriptionElapsedMs: input.metadata.transcriptionElapsedMs,
      interruptionSignals: segments.filter((segment) => segment.flags.includes('interrupt')).map((segment) => segment.text),
      noiseSignals: segments.filter((segment) => segment.flags.includes('noise')).map((segment) => segment.text),
      // Acoustic windows are not safely separable without the original decoded
      // extension buffer. First attempts use the exact extension metrics; a
      // retry reports them unavailable instead of attributing prior-audio noise.
      audioNoise: createEmptyAudioNoiseMetrics(),
      segments,
    },
  }
}

/**
 * Removes a durable extension tail from a combined transcription. This is a
 * compatibility fallback for failed jobs created before exact rollback
 * snapshots were captured in the job payload.
 */
export function removeTranscriptionTail(
  input: TranscriptionResult,
  segmentCount: number,
): TranscriptionResult {
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) {
    throw new RangeError('segmentCount must be a positive integer.')
  }
  if (segmentCount >= input.metadata.segments.length) {
    throw new RangeError('The previous transcript segments are no longer available.')
  }
  let segments = input.metadata.segments.slice(0, -segmentCount).map((segment, index) => ({
    ...segment,
    id: `segment-${index + 1}`,
  }))
  let engines = input.metadata.engine.split(' + ').map((value) => value.trim()).filter(Boolean)
  return {
    transcript: segments.map((segment) => segment.text).join('\n'),
    metadata: {
      ...input.metadata,
      engine: engines.length > 1 ? engines.slice(0, -1).join(' + ') : input.metadata.engine,
      durationMs: segments.at(-1)?.endMs ?? 0,
      interruptionSignals: segments.filter((segment) => segment.flags.includes('interrupt')).map((segment) => segment.text),
      noiseSignals: segments.filter((segment) => segment.flags.includes('noise')).map((segment) => segment.text),
      segments,
    },
  }
}

export function createTranscriptionService(dependencies: TranscriptionServiceDependencies): TranscriptionService {
  let mockTranscription = (dependencies.env ?? process.env).MOCK_TRANSCRIPTION === 'true'
  let makeMockTranscript = dependencies.mockTranscript ?? defaultMockTranscript

  async function transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    let manualTranscript = input.manualTranscript?.trim() ?? ''
    if (manualTranscript) return createManualTranscription(manualTranscript)
    let blobKey = input.audioBlobKey?.trim() ?? ''
    if (blobKey) return dependencies.transcribeAudio({
      audioBlobKey: blobKey,
      originalFilename: input.audioOriginalFilename,
    })
    if (mockTranscription) {
      let transcript = makeMockTranscript(input).trim()
      if (!transcript) throw new Error('Mock transcription returned an empty transcript.')
      let segments = buildTranscriptSegments(transcript)
      return {
        transcript,
        metadata: buildMetadata({ segments, engine: 'mock-transcription', mocked: true }),
      }
    }
    throw new Error('No transcript or audio recording is available for processing.')
  }

  return {
    transcribe,
    async transcribeExtension(input) {
      let next = await transcribe(input)
      return appendTranscriptToExisting({
        previousTranscript: input.previousTranscript,
        previousMetadata: input.previousMetadata,
        nextTranscript: next.transcript,
        nextMetadata: next.metadata,
      })
    },
  }
}
