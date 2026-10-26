import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  createEmptyAudioNoiseMetrics,
  type AudioNoiseMetrics,
  type TranscriptionMetadata,
} from './transcription.ts'
import { audioUploadPolicy, type UploadStorage } from './upload-storage.ts'

const TARGET_SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 4
const MAX_DECODED_AUDIO_SECONDS = 30 * 60
const MAX_DECODED_PCM_BYTES = TARGET_SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_DECODED_AUDIO_SECONDS
const MAX_FFMPEG_DECODE_MS = 120_000
const MAX_SOURCE_AUDIO_BYTES = audioUploadPolicy.maxBytes
const MAX_MATERIALIZATION_MS = 60_000
const FRAME_DURATION_MS = 20
const BURST_MIN_DURATION_MS = 250
const LOW_MARGIN_SNR_DB = 12
const SEVERE_LOW_MARGIN_SNR_DB = 6
const ELEVATED_BACKGROUND_MARGIN_DB = 8
const NEAR_SPEECH_WINDOW_MS = 1_000
const AFFECTED_SECTION_MAX_GAP_MS = 400
const MAX_AFFECTED_SECTIONS = 3
const EPSILON = 1e-8

export const AUDIO_NOISE_LIMITS = {
  targetSampleRate: TARGET_SAMPLE_RATE,
  maxDecodedAudioSeconds: MAX_DECODED_AUDIO_SECONDS,
  maxDecodedPcmBytes: MAX_DECODED_PCM_BYTES,
  maxFfmpegDecodeMs: MAX_FFMPEG_DECODE_MS,
  maxSourceAudioBytes: MAX_SOURCE_AUDIO_BYTES,
  maxMaterializationMs: MAX_MATERIALIZATION_MS,
} as const

type AudioNoiseLimits = {
  targetSampleRate: number
  maxDecodedAudioSeconds: number
  maxDecodedPcmBytes: number
  maxFfmpegDecodeMs: number
  maxSourceAudioBytes: number
  maxMaterializationMs: number
}
type AudioNoiseStorage = Pick<UploadStorage, 'getStream'>
type AudioNoiseEnvironment = Readonly<Record<string, string | undefined>>
type AudioNoiseSeverity = AudioNoiseMetrics['bursts'][number]['severity']
type AudioNoiseBurst = AudioNoiseMetrics['bursts'][number]
type AudioNoiseAffectedSection = AudioNoiseMetrics['affectedSections'][number]
type BackgroundNoiseConcernLevel = AudioNoiseMetrics['backgroundNoiseConcern']['level']
type BackgroundNoiseConcernReason = AudioNoiseMetrics['backgroundNoiseConcern']['reason']
type BackgroundNoiseConcernResult = AudioNoiseMetrics['backgroundNoiseConcern']

type FrameMetrics = {
  index: number
  rms: number
  dbfs: number
  zeroCrossingRate: number
}

type FrameSection = {
  startMs: number
  endMs: number
}

type RankedAffectedSection = AudioNoiseAffectedSection & {
  rank: number
}

export type BackgroundNoiseConcernInput = {
  maskedSpeechRatio: number
  severeLowMarginSpeechRatio: number
  longestLowMarginRunSeconds: number
  burstsNearSpeech: number
  sustainedNoiseRatio: number
}

export type AudioNoiseAnalyzer = {
  analyze(audioBlobKey: string | null | undefined): Promise<TranscriptionMetadata['audioNoise']>
}

export type AudioNoiseAnalyzerDependencies = {
  storage: AudioNoiseStorage
  env?: AudioNoiseEnvironment
  /** Test seam for the decoder. Production callers should use the ffmpeg default. */
  decodeAudio?: (audioPath: string, options: AudioNoiseDecodeOptions) => Promise<Float32Array>
  /** Test seam that may only make the production limits stricter. */
  limits?: Partial<AudioNoiseLimits>
}

export type AudioNoiseDecodeOptions = {
  ffmpegPath: string
  targetSampleRate: number
  maxDecodedAudioSeconds: number
  maxDecodedPcmBytes: number
  maxFfmpegDecodeMs: number
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, precision = 1) {
  let factor = 10 ** precision
  return Math.round(value * factor) / factor
}

function toDbfs(rms: number) {
  return 20 * Math.log10(Math.max(rms, EPSILON))
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0
  let sorted = [...values].sort((left, right) => left - right)
  let index = clamp(Math.round((sorted.length - 1) * ratio), 0, sorted.length - 1)
  return sorted[index] ?? 0
}

function average(values: number[]) {
  if (!values.length) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function weightedAverage(
  leftValue: number | null,
  leftWeight: number,
  rightValue: number | null,
  rightWeight: number,
) {
  let effectiveWeight =
    (leftValue == null ? 0 : leftWeight) + (rightValue == null ? 0 : rightWeight)
  if (!effectiveWeight) return null
  let weightedLeft = leftValue == null ? 0 : leftValue * leftWeight
  let weightedRight = rightValue == null ? 0 : rightValue * rightWeight
  return (weightedLeft + weightedRight) / effectiveWeight
}

function buildEmptyAudioNoiseMetrics(): AudioNoiseMetrics {
  return createEmptyAudioNoiseMetrics()
}

export function getBackgroundNoiseConcernReason(
  input: BackgroundNoiseConcernInput,
): BackgroundNoiseConcernReason {
  let audibility = input.maskedSpeechRatio >= 0.12 || input.severeLowMarginSpeechRatio >= 0.05
  let disruption = input.burstsNearSpeech >= 2
  let persistence = input.sustainedNoiseRatio >= 0.3
  let reasonCount = [audibility, disruption, persistence].filter(Boolean).length
  if (reasonCount >= 2) return 'mixed'
  if (audibility) return 'speech_hard_to_hear'
  if (disruption) return 'disruptive_noise_events'
  if (persistence) return 'persistent_background_noise'
  return 'none'
}

export function getBackgroundNoiseConcern(
  input: BackgroundNoiseConcernInput,
): BackgroundNoiseConcernResult {
  let reason = getBackgroundNoiseConcernReason(input)
  let veryHigh =
    input.maskedSpeechRatio >= 0.65
    || input.severeLowMarginSpeechRatio >= 0.45
    || input.longestLowMarginRunSeconds >= 30
    || (input.burstsNearSpeech >= 12
      && (input.maskedSpeechRatio >= 0.45
        || input.severeLowMarginSpeechRatio >= 0.25
        || input.sustainedNoiseRatio >= 0.8))
    || (input.sustainedNoiseRatio >= 0.9
      && (input.maskedSpeechRatio >= 0.45
        || input.severeLowMarginSpeechRatio >= 0.25
        || input.longestLowMarginRunSeconds >= 20))

  if (veryHigh) {
    return {
      level: 'veryHigh',
      action: 'confirm_key_details',
      reason,
      message: 'Very high background noise was detected.',
      showTimestamps: false,
    }
  }

  let high =
    input.maskedSpeechRatio >= 0.45
    || input.severeLowMarginSpeechRatio >= 0.25
    || input.longestLowMarginRunSeconds >= 18
    || (input.burstsNearSpeech >= 6
      && (input.maskedSpeechRatio >= 0.25
        || input.severeLowMarginSpeechRatio >= 0.12
        || input.sustainedNoiseRatio >= 0.6
        || input.longestLowMarginRunSeconds >= 10))
    || (input.sustainedNoiseRatio >= 0.75
      && (input.maskedSpeechRatio >= 0.25
        || input.severeLowMarginSpeechRatio >= 0.12
        || input.longestLowMarginRunSeconds >= 10
        || input.burstsNearSpeech >= 5))

  if (high) {
    return {
      level: 'high',
      action: 'check_key_details',
      reason,
      message: 'High background noise was detected.',
      showTimestamps: false,
    }
  }

  let some =
    input.maskedSpeechRatio >= 0.12
    || input.severeLowMarginSpeechRatio >= 0.05
    || input.longestLowMarginRunSeconds >= 5
    || input.burstsNearSpeech >= 2
    || input.sustainedNoiseRatio >= 0.3

  return some
    ? {
        level: 'some',
        action: 'review_before_submitting',
        reason,
        message: 'Some background noise was detected.',
        showTimestamps: false,
      }
    : {
        level: 'none',
        action: 'none',
        reason: 'none',
        message: null,
        showTimestamps: false,
      }
}

function buildAudioNoiseMetrics(options: {
  available: boolean
  analysedDurationMs: number
  speechDurationMs: number
  maskedSpeechDurationMs: number
  severeLowMarginSpeechDurationMs: number
  longestLowMarginRunSeconds: number
  averageSpeechSnrDb: number | null
  estimatedNoiseFloorDbfs: number | null
  burstsNearSpeech: number
  sustainedNoiseDurationMs: number
  bursts: AudioNoiseBurst[]
  affectedSections: AudioNoiseAffectedSection[]
}): AudioNoiseMetrics {
  if (!options.available) return buildEmptyAudioNoiseMetrics()
  let maskedSpeechRatio = options.speechDurationMs > 0
    ? clamp(options.maskedSpeechDurationMs / options.speechDurationMs, 0, 1)
    : 0
  let severeLowMarginSpeechRatio = options.speechDurationMs > 0
    ? clamp(options.severeLowMarginSpeechDurationMs / options.speechDurationMs, 0, 1)
    : 0
  let sustainedNoiseRatio = options.analysedDurationMs > 0
    ? clamp(options.sustainedNoiseDurationMs / options.analysedDurationMs, 0, 1)
    : 0
  let burstPenalty = Math.min(options.bursts.length, 4) / 4 * 20
  let snrPenalty = options.averageSpeechSnrDb == null
    ? 0
    : clamp((14 - options.averageSpeechSnrDb) / 14, 0, 1) * 20
  let score = clamp(Math.round(maskedSpeechRatio * 70 + burstPenalty + snrPenalty), 0, 100)
  let backgroundNoiseConcern = getBackgroundNoiseConcern({
    maskedSpeechRatio,
    severeLowMarginSpeechRatio,
    longestLowMarginRunSeconds: options.longestLowMarginRunSeconds,
    burstsNearSpeech: options.burstsNearSpeech,
    sustainedNoiseRatio,
  })

  return {
    available: true,
    score,
    analysedDurationMs: options.analysedDurationMs,
    speechDurationMs: options.speechDurationMs,
    maskedSpeechDurationMs: options.maskedSpeechDurationMs,
    maskedSpeechRatio,
    severeLowMarginSpeechDurationMs: options.severeLowMarginSpeechDurationMs,
    severeLowMarginSpeechRatio,
    longestLowMarginRunSeconds: round(options.longestLowMarginRunSeconds, 1),
    averageSpeechSnrDb: options.averageSpeechSnrDb == null ? null : round(options.averageSpeechSnrDb, 1),
    estimatedNoiseFloorDbfs: options.estimatedNoiseFloorDbfs == null
      ? null
      : round(options.estimatedNoiseFloorDbfs, 1),
    burstCount: options.bursts.length,
    burstsNearSpeech: options.burstsNearSpeech,
    sustainedNoiseDurationMs: options.sustainedNoiseDurationMs,
    sustainedNoiseRatio,
    bursts: options.bursts,
    affectedSections: backgroundNoiseConcern.showTimestamps ? options.affectedSections : [],
    backgroundNoiseConcern,
  }
}

function createFrames(samples: Float32Array, sampleRate: number): FrameMetrics[] {
  let frameSize = Math.max(1, Math.round((sampleRate * FRAME_DURATION_MS) / 1_000))
  let frameCount = Math.floor(samples.length / frameSize)
  let frames: FrameMetrics[] = []
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    let start = frameIndex * frameSize
    let energy = 0
    let zeroCrossings = 0
    let previous = samples[start] ?? 0
    for (let sampleIndex = 0; sampleIndex < frameSize; sampleIndex += 1) {
      let sample = samples[start + sampleIndex] ?? 0
      energy += sample * sample
      if (sampleIndex > 0 && ((previous >= 0 && sample < 0) || (previous < 0 && sample >= 0))) {
        zeroCrossings += 1
      }
      previous = sample
    }
    let rms = Math.sqrt(energy / frameSize)
    frames.push({
      index: frameIndex,
      rms,
      dbfs: toDbfs(rms),
      zeroCrossingRate: zeroCrossings / Math.max(1, frameSize - 1),
    })
  }
  return frames
}

function classifySpeechFrames(frames: FrameMetrics[]) {
  let dbValues = frames.map((frame) => frame.dbfs)
  let floorDb = percentile(dbValues, 0.2)
  let medianDb = percentile(dbValues, 0.5)
  let baseThresholdDb = Math.max(floorDb + 9, medianDb + 3, -42)
  let speechFrames = frames.filter((frame) =>
    frame.dbfs >= baseThresholdDb
    && frame.zeroCrossingRate >= 0.015
    && frame.zeroCrossingRate <= 0.32,
  )
  if (speechFrames.length >= Math.max(6, Math.round(frames.length * 0.04))) return speechFrames
  let relaxedThresholdDb = Math.max(floorDb + 6, medianDb + 1, -48)
  return frames.filter((frame) =>
    frame.dbfs >= relaxedThresholdDb
    && frame.zeroCrossingRate >= 0.01
    && frame.zeroCrossingRate <= 0.38,
  )
}

function detectBursts(
  frames: FrameMetrics[],
  speechIndexes: Set<number>,
  noiseReferenceDb: number,
): AudioNoiseBurst[] {
  let bursts: AudioNoiseBurst[] = []
  let thresholdDb = noiseReferenceDb + ELEVATED_BACKGROUND_MARGIN_DB
  let minimumFrames = Math.max(1, Math.ceil(BURST_MIN_DURATION_MS / FRAME_DURATION_MS))
  let startIndex = -1
  let peakDbfs = Number.NEGATIVE_INFINITY
  let flushBurst = (endFrameIndex: number) => {
    if (startIndex < 0) return
    let frameLength = endFrameIndex - startIndex
    if (frameLength >= minimumFrames) {
      let severity: AudioNoiseSeverity = peakDbfs >= noiseReferenceDb + 16
        ? 'high'
        : peakDbfs >= noiseReferenceDb + 11 ? 'medium' : 'low'
      bursts.push({
        startMs: startIndex * FRAME_DURATION_MS,
        endMs: endFrameIndex * FRAME_DURATION_MS,
        peakDbfs: round(peakDbfs, 1),
        severity,
      })
    }
    startIndex = -1
    peakDbfs = Number.NEGATIVE_INFINITY
  }
  for (let frame of frames) {
    let qualifies = !speechIndexes.has(frame.index) && frame.dbfs >= thresholdDb
    if (qualifies) {
      if (startIndex < 0) startIndex = frame.index
      peakDbfs = Math.max(peakDbfs, frame.dbfs)
    } else {
      flushBurst(frame.index)
    }
  }
  flushBurst(frames.length)
  return bursts
}

function buildFrameSections(indexes: number[], maxGapMs: number): FrameSection[] {
  if (!indexes.length) return []
  let sortedIndexes = [...new Set(indexes)].sort((left, right) => left - right)
  let maxGapFrames = Math.max(0, Math.round(maxGapMs / FRAME_DURATION_MS))
  let sections: FrameSection[] = []
  let startIndex = sortedIndexes[0] ?? 0
  let previousIndex = startIndex
  for (let index of sortedIndexes.slice(1)) {
    if (index - previousIndex > maxGapFrames + 1) {
      sections.push({
        startMs: startIndex * FRAME_DURATION_MS,
        endMs: (previousIndex + 1) * FRAME_DURATION_MS,
      })
      startIndex = index
    }
    previousIndex = index
  }
  sections.push({
    startMs: startIndex * FRAME_DURATION_MS,
    endMs: (previousIndex + 1) * FRAME_DURATION_MS,
  })
  return sections
}

function isNearSpeech(burst: AudioNoiseBurst, speechSections: FrameSection[]) {
  return speechSections.some((section) =>
    burst.startMs <= section.endMs + NEAR_SPEECH_WINDOW_MS
    && burst.endMs >= section.startMs - NEAR_SPEECH_WINDOW_MS,
  )
}

function compareConcernLevels(left: BackgroundNoiseConcernLevel, right: BackgroundNoiseConcernLevel) {
  let order: Record<BackgroundNoiseConcernLevel, number> = {
    none: 0,
    some: 1,
    high: 2,
    veryHigh: 3,
  }
  return order[right] - order[left]
}

function selectTopAffectedSections(sections: RankedAffectedSection[]) {
  return [...sections]
    .sort((left, right) => {
      let levelComparison = compareConcernLevels(left.level, right.level)
      return levelComparison !== 0 ? levelComparison : right.rank - left.rank
    })
    .slice(0, MAX_AFFECTED_SECTIONS)
    .map(({ rank: _rank, ...section }) => section)
}

function sectionsOverlap(left: FrameSection, right: FrameSection) {
  return left.startMs < right.endMs && right.startMs < left.endMs
}

function buildAffectedSections(options: {
  lowMarginSections: FrameSection[]
  severeLowMarginSections: FrameSection[]
  nearSpeechBursts: AudioNoiseBurst[]
  sustainedNoiseSections: FrameSection[]
}): AudioNoiseAffectedSection[] {
  let candidates: RankedAffectedSection[] = []
  for (let section of options.lowMarginSections) {
    let durationMs = section.endMs - section.startMs
    let isSevere = options.severeLowMarginSections.some((severeSection) =>
      sectionsOverlap(section, severeSection),
    )
    candidates.push({
      ...section,
      level: isSevere || durationMs >= 12_000 ? 'veryHigh' : durationMs >= 8_000 ? 'high' : 'some',
      reason: 'speech_hard_to_hear',
      rank: durationMs + (isSevere ? 20_000 : 0),
    })
  }
  for (let burst of options.nearSpeechBursts) {
    let durationMs = burst.endMs - burst.startMs
    let level: BackgroundNoiseConcernLevel = burst.severity === 'high' ? 'high' : 'some'
    candidates.push({
      startMs: burst.startMs,
      endMs: burst.endMs,
      level,
      reason: 'disruptive_noise_events',
      rank: durationMs + (burst.peakDbfs ?? -100) + (burst.severity === 'high' ? 10_000 : 0),
    })
  }
  for (let section of options.sustainedNoiseSections) {
    let durationMs = section.endMs - section.startMs
    candidates.push({
      ...section,
      level: durationMs >= 12_000 ? 'high' : 'some',
      reason: 'persistent_background_noise',
      rank: durationMs,
    })
  }
  return selectTopAffectedSections(candidates)
}

export function analyzePcmSamples(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): AudioNoiseMetrics {
  let frames = createFrames(samples, sampleRate)
  if (!frames.length) return buildEmptyAudioNoiseMetrics()
  let speechFrames = classifySpeechFrames(frames)
  let speechIndexes = new Set(speechFrames.map((frame) => frame.index))
  let nonSpeechFrames = frames.filter((frame) => !speechIndexes.has(frame.index))
  let fallbackNoiseFloorDb = percentile(frames.map((frame) => frame.dbfs), 0.2)
  let noiseReferenceDb = nonSpeechFrames.length
    ? percentile(nonSpeechFrames.map((frame) => frame.dbfs), 0.6)
    : fallbackNoiseFloorDb
  let speechSnrByFrameIndex = new Map(
    speechFrames.map((frame) => [frame.index, frame.dbfs - noiseReferenceDb]),
  )
  let speechSnrValues = [...speechSnrByFrameIndex.values()]
  let lowMarginSpeechFrameIndexes = speechFrames
    .filter((frame) => (speechSnrByFrameIndex.get(frame.index) ?? 0) < LOW_MARGIN_SNR_DB)
    .map((frame) => frame.index)
  let severeLowMarginSpeechFrameIndexes = speechFrames
    .filter((frame) => (speechSnrByFrameIndex.get(frame.index) ?? 0) < SEVERE_LOW_MARGIN_SNR_DB)
    .map((frame) => frame.index)
  let elevatedNoiseFrameIndexes = nonSpeechFrames
    .filter((frame) => frame.dbfs >= noiseReferenceDb + ELEVATED_BACKGROUND_MARGIN_DB)
    .map((frame) => frame.index)
  let speechSections = buildFrameSections(
    speechFrames.map((frame) => frame.index),
    AFFECTED_SECTION_MAX_GAP_MS,
  )
  let lowMarginSections = buildFrameSections(lowMarginSpeechFrameIndexes, AFFECTED_SECTION_MAX_GAP_MS)
  let severeLowMarginSections = buildFrameSections(
    severeLowMarginSpeechFrameIndexes,
    AFFECTED_SECTION_MAX_GAP_MS,
  )
  let sustainedNoiseSections = buildFrameSections(
    elevatedNoiseFrameIndexes,
    AFFECTED_SECTION_MAX_GAP_MS,
  )
  let bursts = detectBursts(frames, speechIndexes, noiseReferenceDb)
  let nearSpeechBursts = bursts.filter((burst) => isNearSpeech(burst, speechSections))
  let longestLowMarginRunSeconds = lowMarginSections.reduce(
    (longest, section) => Math.max(longest, (section.endMs - section.startMs) / 1_000),
    0,
  )
  return buildAudioNoiseMetrics({
    available: true,
    analysedDurationMs: frames.length * FRAME_DURATION_MS,
    speechDurationMs: speechFrames.length * FRAME_DURATION_MS,
    maskedSpeechDurationMs: lowMarginSpeechFrameIndexes.length * FRAME_DURATION_MS,
    severeLowMarginSpeechDurationMs: severeLowMarginSpeechFrameIndexes.length * FRAME_DURATION_MS,
    longestLowMarginRunSeconds,
    averageSpeechSnrDb: average(speechSnrValues),
    estimatedNoiseFloorDbfs: noiseReferenceDb,
    burstsNearSpeech: nearSpeechBursts.length,
    sustainedNoiseDurationMs: elevatedNoiseFrameIndexes.length * FRAME_DURATION_MS,
    bursts,
    affectedSections: buildAffectedSections({
      lowMarginSections,
      severeLowMarginSections,
      nearSpeechBursts,
      sustainedNoiseSections,
    }),
  })
}

function safeLimit(value: number | undefined, maximum: number) {
  if (value == null || !Number.isSafeInteger(value) || value <= 0) return maximum
  return Math.min(value, maximum)
}

function resolveLimits(input: Partial<AudioNoiseLimits> | undefined): AudioNoiseLimits {
  return {
    targetSampleRate: safeLimit(input?.targetSampleRate, AUDIO_NOISE_LIMITS.targetSampleRate),
    maxDecodedAudioSeconds: safeLimit(
      input?.maxDecodedAudioSeconds,
      AUDIO_NOISE_LIMITS.maxDecodedAudioSeconds,
    ),
    maxDecodedPcmBytes: safeLimit(input?.maxDecodedPcmBytes, AUDIO_NOISE_LIMITS.maxDecodedPcmBytes),
    maxFfmpegDecodeMs: safeLimit(input?.maxFfmpegDecodeMs, AUDIO_NOISE_LIMITS.maxFfmpegDecodeMs),
    maxSourceAudioBytes: safeLimit(input?.maxSourceAudioBytes, AUDIO_NOISE_LIMITS.maxSourceAudioBytes),
    maxMaterializationMs: safeLimit(
      input?.maxMaterializationMs,
      AUDIO_NOISE_LIMITS.maxMaterializationMs,
    ),
  }
}

class ByteLimitTransform extends Transform {
  #bytes = 0
  constructor(private readonly maxBytes: number) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.#bytes += chunk.byteLength
    if (this.#bytes > this.maxBytes) {
      callback(new Error('Stored audio exceeded the bounded materialization size.'))
      return
    }
    callback(null, chunk)
  }
}

async function getStreamWithTimeout(
  storage: AudioNoiseStorage,
  blobKey: string,
  timeoutMs: number,
) {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      storage.getStream(blobKey),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Stored audio retrieval timed out.')),
          timeoutMs,
        )
        timeout.unref()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function materializeStoredAudio(
  storage: AudioNoiseStorage,
  blobKey: string,
  targetPath: string,
  limits: AudioNoiseLimits,
) {
  let source = await getStreamWithTimeout(storage, blobKey, limits.maxMaterializationMs)
  let controller = new AbortController()
  let timeout = setTimeout(() => controller.abort(), limits.maxMaterializationMs)
  timeout.unref()
  try {
    await pipeline(
      source,
      new ByteLimitTransform(limits.maxSourceAudioBytes),
      createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }),
      { signal: controller.signal },
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function decodeAudioToMonoPcm(
  audioPath: string,
  options: AudioNoiseDecodeOptions,
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0
    let outputChunks: Buffer[] = []
    let killedReason: Error | null = null
    let settled = false
    let command = spawn(options.ffmpegPath, [
      '-nostdin',
      '-v', 'error',
      '-i', audioPath,
      '-t', String(options.maxDecodedAudioSeconds),
      '-vn',
      '-ac', '1',
      '-ar', String(options.targetSampleRate),
      '-f', 'f32le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let finishWithError = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    let timeout = setTimeout(() => {
      killedReason = new Error('Audio decoding exceeded the time limit.')
      command.kill('SIGKILL')
    }, options.maxFfmpegDecodeMs)
    timeout.unref()

    command.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxDecodedPcmBytes) {
        killedReason = new Error('Decoded audio exceeded the PCM byte limit.')
        command.kill('SIGKILL')
        return
      }
      outputChunks.push(chunk)
    })
    // Drain decoder diagnostics so the child cannot block, but do not retain or log them.
    command.stderr.resume()
    command.once('error', (error) => {
      clearTimeout(timeout)
      finishWithError(error)
    })
    command.once('close', (code) => {
      clearTimeout(timeout)
      if (settled) return
      if (killedReason) {
        finishWithError(killedReason)
        return
      }
      if (code !== 0) {
        finishWithError(new Error('Audio decoding failed.'))
        return
      }
      let output = Buffer.concat(outputChunks)
      outputChunks = []
      let sampleCount = Math.floor(output.byteLength / BYTES_PER_SAMPLE)
      let samples = new Float32Array(sampleCount)
      for (let index = 0; index < sampleCount; index += 1) {
        samples[index] = output.readFloatLE(index * BYTES_PER_SAMPLE)
      }
      settled = true
      resolve(samples)
    })
  })
}

export function createAudioNoiseAnalyzer(
  dependencies: AudioNoiseAnalyzerDependencies,
): AudioNoiseAnalyzer {
  let limits = resolveLimits(dependencies.limits)
  let ffmpegPath = dependencies.env?.FFMPEG_PATH?.trim() || 'ffmpeg'
  let decode = dependencies.decodeAudio ?? decodeAudioToMonoPcm
  return {
    async analyze(rawBlobKey) {
      let blobKey = rawBlobKey?.trim() ?? ''
      if (!blobKey) return buildEmptyAudioNoiseMetrics()
      let directory: string | null = null
      try {
        directory = await mkdtemp(join(tmpdir(), 'handover-audio-noise-'))
        let audioPath = join(directory, 'source-audio')
        await materializeStoredAudio(dependencies.storage, blobKey, audioPath, limits)
        let samples = await decode(audioPath, {
          ffmpegPath,
          targetSampleRate: limits.targetSampleRate,
          maxDecodedAudioSeconds: limits.maxDecodedAudioSeconds,
          maxDecodedPcmBytes: limits.maxDecodedPcmBytes,
          maxFfmpegDecodeMs: limits.maxFfmpegDecodeMs,
        })
        return analyzePcmSamples(samples, limits.targetSampleRate)
      } catch {
        return buildEmptyAudioNoiseMetrics()
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

function buildNoiseSignalsFromAudioMetrics(metrics: AudioNoiseMetrics): string[] {
  if (!metrics.available || !metrics.backgroundNoiseConcern.message) return []
  return [metrics.backgroundNoiseConcern.message]
}

function offsetBursts(bursts: AudioNoiseBurst[], offsetMs: number): AudioNoiseBurst[] {
  if (!offsetMs) return bursts
  return bursts.map((burst) => ({
    ...burst,
    startMs: burst.startMs + offsetMs,
    endMs: burst.endMs + offsetMs,
  }))
}

function offsetAffectedSections(
  sections: AudioNoiseAffectedSection[],
  offsetMs: number,
): AudioNoiseAffectedSection[] {
  if (!offsetMs) return sections
  return sections.map((section) => ({
    ...section,
    startMs: section.startMs + offsetMs,
    endMs: section.endMs + offsetMs,
  }))
}

function rankExistingAffectedSections(sections: AudioNoiseAffectedSection[]) {
  return sections.map((section) => ({
    ...section,
    rank: section.endMs - section.startMs,
  }))
}

export function mergeAudioNoiseMetrics(
  previous: AudioNoiseMetrics,
  next: AudioNoiseMetrics,
  offsetMs = 0,
): AudioNoiseMetrics {
  if (!previous.available) {
    return {
      ...next,
      bursts: offsetBursts(next.bursts, offsetMs),
      affectedSections: offsetAffectedSections(next.affectedSections, offsetMs),
    }
  }
  if (!next.available) return previous
  return buildAudioNoiseMetrics({
    available: true,
    analysedDurationMs: previous.analysedDurationMs + next.analysedDurationMs,
    speechDurationMs: previous.speechDurationMs + next.speechDurationMs,
    maskedSpeechDurationMs: previous.maskedSpeechDurationMs + next.maskedSpeechDurationMs,
    severeLowMarginSpeechDurationMs:
      previous.severeLowMarginSpeechDurationMs + next.severeLowMarginSpeechDurationMs,
    longestLowMarginRunSeconds: Math.max(
      previous.longestLowMarginRunSeconds,
      next.longestLowMarginRunSeconds,
    ),
    averageSpeechSnrDb: weightedAverage(
      previous.averageSpeechSnrDb,
      previous.speechDurationMs,
      next.averageSpeechSnrDb,
      next.speechDurationMs,
    ),
    estimatedNoiseFloorDbfs: weightedAverage(
      previous.estimatedNoiseFloorDbfs,
      previous.analysedDurationMs,
      next.estimatedNoiseFloorDbfs,
      next.analysedDurationMs,
    ),
    burstsNearSpeech: previous.burstsNearSpeech + next.burstsNearSpeech,
    sustainedNoiseDurationMs: previous.sustainedNoiseDurationMs + next.sustainedNoiseDurationMs,
    bursts: [...previous.bursts, ...offsetBursts(next.bursts, offsetMs)],
    affectedSections: selectTopAffectedSections([
      ...rankExistingAffectedSections(previous.affectedSections),
      ...rankExistingAffectedSections(offsetAffectedSections(next.affectedSections, offsetMs)),
    ]),
  })
}

/** Adds a newly analysed recording to provider/manual transcription metadata. */
export function attachAudioNoiseMetrics(
  metadata: TranscriptionMetadata,
  nextMetrics: AudioNoiseMetrics,
  offsetMs = 0,
): TranscriptionMetadata {
  let audioNoise = mergeAudioNoiseMetrics(metadata.audioNoise, nextMetrics, offsetMs)
  return {
    ...metadata,
    noiseSignals: [
      ...new Set([...metadata.noiseSignals, ...buildNoiseSignalsFromAudioMetrics(nextMetrics)]),
    ],
    audioNoise,
  }
}
