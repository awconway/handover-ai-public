export type ReviewChecklistItem = {
  id: string
  label: string
  status: 'addressed' | 'partial' | 'missing'
  note: string
}

export type ReviewSummary = {
  situation: string
  background: string
  assessment: string
  recommendation: string
}

export type ReviewSummaryEdit = {
  section: keyof ReviewSummary
  previousValue: string
  nextValue: string
  at: string
  byUserId: string
}

export type ReviewUncertainty = {
  id: string
  statement: string
  confidence: 'low' | 'medium' | 'high' | 'unknown'
  verificationNeed: string
  linkedTaskId: string | null
}

export type ReviewTask = {
  id: string
  title: string
  dueLabel: string
  dueAt: string | null
  priority: 'routine' | 'medium' | 'high'
  status: 'open' | 'done'
  reminderEnabled: boolean
  carriedForward: boolean
  source: string
  relatedUncertaintyId: string | null
}

export type ReviewPatient = {
  patientKey: string
  displayName: string
  location: string
  lastConfirmedPoint: string
  restartPrompt: string
  tasks: ReviewTask[]
  uncertainties: ReviewUncertainty[]
}

export type ReviewCommunicationRisk = {
  id: string
  type: string
  severity: 'low' | 'medium' | 'high'
  evidence: string
  mitigation: string
}

export type ReviewAnalysis = {
  headline: string
  overview: string
  participants: string[]
  structuredSummary: ReviewSummary | null
  structuredSummaryDraft: ReviewSummary | null
  structuredSummaryReviewed: boolean
  structuredSummaryEdits: ReviewSummaryEdit[]
  checklistFocus: ReviewChecklistItem[]
  patients: ReviewPatient[]
  communicationRisks: ReviewCommunicationRisk[]
  openQuestions: string[]
  feedback: {
    qualityScore: number | null
    whatWorked: string[]
    needsAttention: string[]
    repeatedInformation: string[]
    coachingTips: string[]
    durationComment: string
  }
  interruptionAssessment: {
    status: 'confirmed' | 'possible' | 'none'
    summary: string
    evidence: string[]
    recommendation: string
  } | null
  analysisReadiness: {
    overview?: boolean
    patients?: boolean
    actions?: boolean
    communication?: boolean
    checklist?: boolean
    recommence?: boolean
    riskSignals?: boolean
    sbarEvidence?: boolean
    summary?: boolean
    uncertainty?: boolean
  }
}

export type ReviewTranscriptSegment = {
  id: string
  startMs: number
  text: string
  speaker?: string
}

export type ReviewTranscriptionMetadata = {
  interruptionSignals: string[]
  noiseSignals: string[]
  segments: ReviewTranscriptSegment[]
  audioNoise: {
    available: boolean
    maskedSpeechRatio: number
    severeLowMarginSpeechRatio: number
    burstsNearSpeech: number
    sustainedNoiseRatio: number
    averageSpeechSnrDb: number | null
    backgroundNoiseConcern: {
      level: 'none' | 'some' | 'high' | 'veryHigh'
      message: string | null
    } | null
  } | null
}

export type ReviewTranscriptPrivacyFinding = {
  ordinal: number
  sourceAuditId: string
  sourceOrdinal: number
  allowedInAnalysis: boolean
  label: string
  entityType: string
  canonicalLabel: string | null
  startCodepoint: number
  endCodepoint: number
  confidence: number | null
  sources: string[]
}

export type ReviewTranscriptPrivacyAudit = {
  id: string
  modelId: string
  modelRevision: string | null
  backend: string | null
  method: string
  policy: string
  offline: boolean
  replacementCount: number
  createdAt: string
  rerunRequired: boolean
  findings: ReviewTranscriptPrivacyFinding[]
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const text = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object).filter((item): item is Record<string, unknown> => item !== null) : []
const draftText = (source: Record<string, unknown> | null, key: keyof ReviewSummary, fallback: string): string => {
  let value = source?.[key]
  return typeof value === 'string' ? value : fallback
}

export function normalizeReviewAnalysis(value: unknown): ReviewAnalysis | null {
  let source = object(value)
  if (!source) return null

  let summarySource = object(source.structuredSummary)
  let summary = summarySource ? {
    situation: text(summarySource.situation),
    background: text(summarySource.background),
    assessment: text(summarySource.assessment),
    recommendation: text(summarySource.recommendation),
  } : null
  if (summary && !Object.values(summary).some(Boolean)) summary = null

  let summaryMeta = object(source.structuredSummaryMeta)
  let summaryDraftSource = object(summaryMeta?.llmDraft)
  let summaryDraft = summary ? {
    situation: draftText(summaryDraftSource, 'situation', summary.situation),
    background: draftText(summaryDraftSource, 'background', summary.background),
    assessment: draftText(summaryDraftSource, 'assessment', summary.assessment),
    recommendation: draftText(summaryDraftSource, 'recommendation', summary.recommendation),
  } : null
  let summaryEdits = records(summaryMeta?.edits).flatMap((edit) => {
    let section = edit.section
    if (section !== 'situation' && section !== 'background' && section !== 'assessment' && section !== 'recommendation') return []
    return [{
      section: section as keyof ReviewSummary,
      previousValue: text(edit.previousValue),
      nextValue: text(edit.nextValue),
      at: text(edit.at),
      byUserId: text(edit.byUserId),
    }]
  })
  let feedback = object(source.feedback)
  let interruption = object(source.interruptionAssessment)
  let readiness = object(source.analysisReadiness)

  return {
    headline: text(source.headline),
    overview: text(source.overview),
    participants: strings(source.participants),
    structuredSummary: summary,
    structuredSummaryDraft: summaryDraft,
    structuredSummaryReviewed: summaryMeta?.reviewed === true,
    structuredSummaryEdits: summaryEdits,
    checklistFocus: records(source.checklistFocus).map((item, index) => ({
      id: text(item.id) || `checklist-${index + 1}`,
      label: text(item.label) || `item-${index + 1}`,
      status: item.status === 'addressed' || item.status === 'partial' ? item.status : 'missing',
      note: text(item.note),
    })),
    patients: records(source.patients).map<ReviewPatient>((patient, patientIndex) => ({
      patientKey: text(patient.patientKey) || `patient-${patientIndex + 1}`,
      displayName: text(patient.displayName) || `Patient ${patientIndex + 1}`,
      location: text(patient.location),
      lastConfirmedPoint: text(patient.lastConfirmedPoint),
      restartPrompt: text(patient.restartPrompt),
      tasks: records(patient.tasks).map<ReviewTask>((task, taskIndex) => ({
        id: text(task.id) || `task-${patientIndex + 1}-${taskIndex + 1}`,
        title: text(task.title),
        dueLabel: text(task.dueLabel) || 'No due date set',
        dueAt: text(task.dueAt) || null,
        priority: task.priority === 'high' || task.priority === 'medium' ? task.priority : 'routine',
        status: task.status === 'done' ? 'done' : 'open',
        reminderEnabled: task.reminderEnabled === true,
        carriedForward: task.carriedForward === true,
        source: text(task.source) || 'transcript',
        relatedUncertaintyId: text(task.relatedUncertaintyId) || null,
      })).filter((task) => task.title),
      uncertainties: records(patient.uncertainties).map((uncertainty, uncertaintyIndex) => ({
        id: text(uncertainty.id) || `uncertainty-${uncertaintyIndex + 1}`,
        statement: text(uncertainty.statement),
        confidence: reviewConfidence(uncertainty.confidence),
        verificationNeed: text(uncertainty.verificationNeed),
        linkedTaskId: text(uncertainty.linkedTaskId) || null,
      })).filter((uncertainty) => uncertainty.statement),
    })),
    communicationRisks: records(source.communicationRisks).map((risk, index) => ({
      id: text(risk.id) || `risk-${index + 1}`,
      type: text(risk.type) || 'communication-risk',
      severity: risk.severity === 'high' || risk.severity === 'medium' ? risk.severity : 'low',
      evidence: text(risk.evidence),
      mitigation: text(risk.mitigation),
    })),
    openQuestions: strings(source.openQuestions),
    feedback: {
      qualityScore: number(feedback?.qualityScore),
      whatWorked: strings(feedback?.whatWorked),
      needsAttention: strings(feedback?.needsAttention),
      repeatedInformation: strings(feedback?.repeatedInformation),
      coachingTips: strings(feedback?.coachingTips),
      durationComment: text(feedback?.durationComment),
    },
    interruptionAssessment: interruption ? {
      status: interruption.status === 'confirmed' || interruption.status === 'possible' ? interruption.status : 'none',
      summary: text(interruption.summary),
      evidence: strings(interruption.evidence),
      recommendation: text(interruption.recommendation),
    } : null,
    analysisReadiness: readiness ? Object.fromEntries(
      Object.entries(readiness).filter(([, ready]) => typeof ready === 'boolean'),
    ) : {},
  }
}

export function normalizeTranscriptionMetadata(value: unknown): ReviewTranscriptionMetadata | null {
  let source = object(value)
  if (!source) return null
  let audioNoise = object(source.audioNoise)
  let backgroundNoiseConcern = object(audioNoise?.backgroundNoiseConcern)
  let concernLevel = backgroundNoiseConcern?.level
  return {
    interruptionSignals: strings(source.interruptionSignals),
    noiseSignals: strings(source.noiseSignals),
    segments: records(source.segments).map((segment, index) => ({
      id: text(segment.id) || `segment-${index + 1}`,
      startMs: number(segment.startMs) ?? 0,
      text: text(segment.text),
      speaker: text(segment.speaker) || undefined,
    })).filter((segment) => segment.text),
    audioNoise: audioNoise ? {
      available: audioNoise.available === true,
      maskedSpeechRatio: number(audioNoise.maskedSpeechRatio) ?? 0,
      severeLowMarginSpeechRatio: number(audioNoise.severeLowMarginSpeechRatio) ?? 0,
      burstsNearSpeech: number(audioNoise.burstsNearSpeech) ?? 0,
      sustainedNoiseRatio: number(audioNoise.sustainedNoiseRatio) ?? 0,
      averageSpeechSnrDb: number(audioNoise.averageSpeechSnrDb),
      backgroundNoiseConcern: backgroundNoiseConcern && (concernLevel === 'none' || concernLevel === 'some' || concernLevel === 'high' || concernLevel === 'veryHigh') ? {
        level: concernLevel,
        message: typeof backgroundNoiseConcern.message === 'string' ? backgroundNoiseConcern.message : null,
      } : null,
    } : null,
  }
}

export function participantNames(value: unknown): string[] {
  return records(value).map((participant) => text(participant.name)).filter(Boolean)
}

function reviewConfidence(value: unknown): ReviewUncertainty['confidence'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'unknown'
}
