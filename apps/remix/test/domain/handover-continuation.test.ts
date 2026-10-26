import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  mergeHandoverContinuation,
  preserveCreateReviewMetadata,
  preserveExtensionReviewMetadata,
} from '../../app/domain/handover-continuation.server.ts'
import type {
  HandoverAnalysisResult,
  PersistedChecklistItem,
  PersistedHandoverAnalysis,
  PersistedPatientAnalysis,
  PersistedTask,
  PersistedUncertainty,
} from '../../app/domain/handover-analysis.server.ts'

function checklist(
  label: string,
  status: PersistedChecklistItem['status'] = 'missing',
  id = `checklist-${label}`,
  note = `${label} note`,
): PersistedChecklistItem {
  return { id, label, status, note }
}

function task(
  id: string,
  title: string,
  overrides: Partial<PersistedTask> = {},
): PersistedTask {
  return {
    id,
    title,
    dueLabel: 'No due date set',
    dueAt: null,
    priority: 'medium',
    status: 'open',
    reminderEnabled: false,
    carriedForward: false,
    source: 'transcript',
    relatedUncertaintyId: null,
    ...overrides,
  }
}

function uncertainty(
  id: string,
  statement: string,
  overrides: Partial<PersistedUncertainty> = {},
): PersistedUncertainty {
  return {
    id,
    statement,
    confidence: 'high',
    verificationNeed: 'Verify this detail.',
    linkedTaskId: null,
    clinicianDecisionNote: '',
    ...overrides,
  }
}

function patient(
  patientKey: string,
  displayName: string,
  location: string,
  overrides: Partial<PersistedPatientAnalysis> = {},
): PersistedPatientAnalysis {
  let focus = [checklist('id_check'), checklist('rec_actions')]
  return {
    patientKey,
    displayName,
    location,
    priorityScores: { acuity: 30, risk: 35, workflow: 40 },
    priorityReason: 'Routine review is required.',
    summary: {
      situation: `${displayName} is receiving ward care.`,
      background: 'Background was supplied.',
      assessment: 'The patient is stable.',
      recommendation: 'Continue the current plan.',
    },
    keyRisks: [],
    checklist: focus,
    tasks: [],
    uncertainties: [],
    queryBookmarks: [],
    lastConfirmedPoint: 'The current plan was confirmed.',
    restartPrompt: `Confirm ${displayName} and resume the handover.`,
    ...overrides,
  }
}

function analysis(
  patients: PersistedPatientAnalysis[],
  overrides: Partial<PersistedHandoverAnalysis> = {},
): PersistedHandoverAnalysis {
  let summary = {
    situation: 'Molly is receiving ward care.',
    background: 'Background was supplied.',
    assessment: 'The patient is stable.',
    recommendation: 'Continue the current plan.',
  }
  return {
    titleSuggestion: 'Ward handover',
    headline: 'Ward handover is ready for review.',
    overview: 'The current plan and open actions were handed over.',
    participants: ['Nurse Avery'],
    structuredSummary: summary,
    structuredSummaryMeta: { llmDraft: { ...summary }, reviewed: false },
    sbarEvidence: [{ label: 'SITUATION', quote: 'Molly is receiving ward care.' }],
    checklistFocus: [checklist('id_check'), checklist('rec_actions')],
    transcriptHighlights: ['Molly is receiving ward care.'],
    patients,
    communicationRisks: [],
    openQuestions: [],
    feedback: {
      qualityScore: 75,
      whatWorked: ['The patient was identified.'],
      needsAttention: [],
      repeatedInformation: [],
      coachingTips: [],
      durationComment: 'The handover was concise.',
    },
    interruptionAssessment: {
      status: 'none',
      summary: 'No unrelated interruption was identified.',
      evidence: [],
      recommendation: 'Continue with standard review.',
    },
    analysisReadiness: {
      overview: true,
      patients: true,
      actions: true,
      communication: true,
      checklist: true,
      recommence: true,
      riskSignals: true,
      sbarEvidence: true,
      summary: true,
      uncertainty: true,
    },
    ...overrides,
  }
}

function result(
  value: PersistedHandoverAnalysis,
  patientIds: Record<string, string>,
  tasks: Array<{ patientKey: string; task: PersistedTask }> = value.patients.flatMap(
    (patientValue) => patientValue.tasks.map((taskValue) => ({
      patientKey: patientValue.patientKey,
      task: taskValue,
    })),
  ),
): HandoverAnalysisResult {
  return {
    analysis: value,
    patientProjections: value.patients.map((patientValue) => ({
      id: patientIds[patientValue.patientKey] ?? `patient-row-${patientValue.patientKey}`,
      patientKey: patientValue.patientKey,
      displayName: patientValue.displayName,
      location: patientValue.location,
      acuityScore: patientValue.priorityScores.acuity,
      riskScore: patientValue.priorityScores.risk,
      workflowScore: patientValue.priorityScores.workflow,
      priorityReason: patientValue.priorityReason,
    })),
    taskProjections: tasks.map(({ patientKey, task: taskValue }) => ({
      patientKey,
      ...taskValue,
    })),
  }
}

describe('handover continuation merge', () => {
  it('overlays authoritative create metadata without discarding model clinical projections', () => {
    let modelPatient = patient('molly-harper', 'Model-extracted Molly Harper', 'Model bed', {
      priorityScores: { acuity: 72, risk: 81, workflow: 64 },
      priorityReason: 'Model-derived risk remains important.',
    })
    let incoming = result(analysis([modelPatient], {
      participants: ['Model-extracted participant'],
      structuredSummary: {
        situation: 'Model situation remains available.',
        background: 'Model background remains available.',
        assessment: 'Model assessment remains available.',
        recommendation: 'Model recommendation remains available.',
      },
    }), { 'molly-harper': 'patient-row-model' })
    let initial = {
      title: 'Delivering handover · Molly Sheet',
      participants: ['Nurse Avery', 'Registered Nurse'],
      participantsEdited: false,
      linkedPatientKey: 'molly-harper',
      linkedPatientDisplayName: 'Molly Sheet',
      linkedPatientLocation: 'Bed 3',
    }

    let preserved = preserveCreateReviewMetadata(incoming, initial, {
      ...initial,
      title: 'Delivering handover · Molly Corrected',
      participants: ['Nurse Avery', 'Receiving registrar'],
      participantsEdited: true,
      linkedPatientDisplayName: 'Molly Corrected',
    })

    assert.deepEqual(preserved.result.analysis.participants, ['Nurse Avery', 'Receiving registrar'])
    assert.equal(preserved.result.analysis.patients[0]?.displayName, 'Molly Corrected')
    assert.equal(preserved.result.analysis.patients[0]?.location, 'Bed 3')
    assert.equal(preserved.result.patientProjections[0]?.id, 'patient-row-model')
    assert.equal(preserved.result.patientProjections[0]?.displayName, 'Molly Corrected')
    assert.equal(preserved.result.patientProjections[0]?.location, 'Bed 3')
    assert.deepEqual(
      preserved.result.analysis.patients[0]?.priorityScores,
      { acuity: 72, risk: 81, workflow: 64 },
    )
    assert.equal(
      preserved.result.analysis.structuredSummary.recommendation,
      'Model recommendation remains available.',
    )
    assert.equal(preserved.titleOverride, 'Delivering handover · Molly Corrected')
    assert.deepEqual(preserved.participantsOverride, ['Nurse Avery', 'Receiving registrar'])
  })

  it('lets extracted participants replace unchanged automatic recording defaults', () => {
    let incoming = result(
      analysis([patient('patient-1', 'Extracted patient', 'Bed 7')], {
        participants: ['Nurse Avery', 'Dr Morgan'],
      }),
      { 'patient-1': 'patient-row-1' },
    )
    let automaticDefaults = {
      title: 'Receiving handover · Extracted patient',
      participants: ['Nurse Avery', 'Registered Nurse'],
      participantsEdited: false,
      linkedPatientKey: 'patient-1',
      linkedPatientDisplayName: 'Extracted patient',
      linkedPatientLocation: 'Bed 7',
    }

    let preserved = preserveCreateReviewMetadata(
      incoming,
      automaticDefaults,
      automaticDefaults,
    )

    assert.deepEqual(preserved.result.analysis.participants, ['Nurse Avery', 'Dr Morgan'])
    assert.equal(preserved.participantsOverride, null)
  })

  it('honours durable create participant edits made before worker claim', () => {
    let incoming = result(
      analysis([patient('patient-1', 'Extracted patient', 'Bed 7')], {
        participants: ['Model participant'],
      }),
      { 'patient-1': 'patient-row-1' },
    )
    let editedBeforeClaim = {
      title: 'Receiving handover · Extracted patient',
      participants: ['Nurse Avery', 'Receiving registrar'],
      participantsEdited: true,
      linkedPatientKey: 'patient-1',
      linkedPatientDisplayName: 'Extracted patient',
      linkedPatientLocation: 'Bed 7',
    }

    let preserved = preserveCreateReviewMetadata(
      incoming,
      editedBeforeClaim,
      editedBeforeClaim,
    )

    assert.deepEqual(
      preserved.result.analysis.participants,
      ['Nurse Avery', 'Receiving registrar'],
    )
  })

  it('three-way merges concurrent continuation edits and keeps the existing title', () => {
    let incoming = result(
      analysis([patient('patient-1', 'Molly Harper', 'Bed 7')], {
        participants: ['Nurse Avery', 'Dr Morgan', 'Respiratory therapist'],
      }),
      { 'patient-1': 'patient-row-1' },
    )
    let initial = {
      title: 'Receiving handover · Molly Harper (reviewed before claim)',
      participants: ['Nurse Avery', 'Dr Morgan'],
      participantsEdited: true,
      linkedPatientKey: 'patient-1',
      linkedPatientDisplayName: 'Molly Harper',
      linkedPatientLocation: 'Bed 7',
    }

    let preserved = preserveExtensionReviewMetadata(incoming, initial, {
      ...initial,
      participants: ['Nurse Avery'],
      participantsEdited: true,
    })

    assert.equal(
      preserved.titleOverride,
      'Receiving handover · Molly Harper (reviewed before claim)',
    )
    assert.deepEqual(
      preserved.participantsOverride,
      ['Nurse Avery', 'Respiratory therapist'],
    )
    assert.deepEqual(
      preserved.result.analysis.participants,
      ['Nurse Avery', 'Respiratory therapist'],
    )
  })

  it('allows model metadata when no clinician-owned creation values exist', () => {
    let incoming = result(
      analysis([patient('patient-1', 'Extracted patient', 'Bed 7')], {
        participants: ['Extracted clinician'],
      }),
      { 'patient-1': 'patient-row-1' },
    )
    let empty = {
      title: 'Individual handover',
      participants: [],
      participantsEdited: false,
      linkedPatientKey: null,
      linkedPatientDisplayName: null,
      linkedPatientLocation: null,
    }

    let preserved = preserveCreateReviewMetadata(incoming, empty, empty)

    assert.equal(preserved.result, incoming)
    assert.equal(preserved.participantsOverride, null)
    assert.equal(preserved.titleOverride, null)
  })

  it('preserves clinician review state and persisted tasks while adding new evidence and actions', () => {
    let currentChecklist = [
      checklist('id_check', 'addressed', 'reviewed-id-check', 'Clinician confirmed identity.'),
      checklist('rec_actions', 'missing', 'reviewed-rec-actions', 'No action stated yet.'),
    ]
    let currentTask = task('task-current', 'Confirm allergy status', {
      status: 'done',
      reminderEnabled: true,
    })
    let manualTask = task('task-manual', 'Call family with an update', {
      source: 'manual',
      priority: 'high',
    })
    let removedStaleTask = task('task-deleted', 'This task was deleted')
    let currentUncertainty = uncertainty('uncertainty-current', 'Allergy status is unknown.', {
      confidence: 'low',
      linkedTaskId: 'task-current',
      clinicianDecisionNote: 'The chart was checked; pharmacy confirmation is pending.',
    })
    let currentPatient = patient('molly-harper-3a-01', 'Molly Harper', '3A-01', {
      priorityScores: { acuity: 40, risk: 60, workflow: 45 },
      checklist: currentChecklist,
      tasks: [
        task('task-current', 'Confirm allergy status'),
        removedStaleTask,
      ],
      uncertainties: [currentUncertainty],
    })
    let currentSummaryDraft = {
      situation: 'Molly is receiving ward care.',
      background: 'Asthma is part of the relevant history.',
      assessment: 'Molly is stable on room air.',
      recommendation: 'Confirm allergy status.',
    }
    let currentAnalysis = analysis([currentPatient], {
      structuredSummary: {
        ...currentSummaryDraft,
        situation: 'Clinician-edited situation for Molly.',
      },
      structuredSummaryMeta: { llmDraft: currentSummaryDraft, reviewed: true },
      checklistFocus: currentChecklist,
    })
    let existing = result(currentAnalysis, { 'molly-harper-3a-01': 'patient-row-current' }, [
      { patientKey: 'molly-harper-3a-01', task: currentTask },
      { patientKey: 'molly-harper-3a-01', task: manualTask },
    ])

    let continuationChecklist = [
      checklist('id_check', 'missing', 'incoming-id-check', 'No identifier in the extension.'),
      checklist('rec_actions', 'addressed', 'incoming-rec-actions', 'Repeat observations were requested.'),
    ]
    let duplicateTask = task('task-incoming-duplicate', 'Confirm allergy status', {
      relatedUncertaintyId: 'uncertainty-incoming-duplicate',
    })
    let newTask = task('task-new', 'Repeat observations at 18:00', {
      dueLabel: '18:00 today',
      relatedUncertaintyId: 'uncertainty-new',
    })
    let genericPatient = patient('patient-1', 'Unnamed female', 'Location not stated', {
      priorityScores: { acuity: 55, risk: 50, workflow: 70 },
      priorityReason: 'Observations are due after the extension.',
      summary: {
        situation: 'The unnamed patient remains on the ward.',
        background: 'Not mentioned in supplied evidence.',
        assessment: 'Repeat observations are required.',
        recommendation: 'Repeat observations at 18:00.',
      },
      checklist: continuationChecklist,
      tasks: [duplicateTask, newTask],
      uncertainties: [
        uncertainty('uncertainty-incoming-duplicate', 'Allergy status is unknown.', {
          linkedTaskId: 'task-incoming-duplicate',
          verificationNeed: 'Confirm with pharmacy.',
        }),
        uncertainty('uncertainty-new', 'The latest observations were not stated.', {
          linkedTaskId: 'task-new',
        }),
      ],
    })
    let continuationAnalysis = analysis([genericPatient], {
      headline: 'Ward handover is ready for review with repeat observations due.',
      structuredSummary: {
        situation: 'The unnamed patient remains on the ward.',
        background: 'Not mentioned in supplied evidence.',
        assessment: 'Repeat observations are required.',
        recommendation: 'Repeat observations at 18:00.',
      },
      structuredSummaryMeta: {
        llmDraft: {
          situation: 'The unnamed patient remains on the ward.',
          background: 'Not mentioned in supplied evidence.',
          assessment: 'Repeat observations are required.',
          recommendation: 'Repeat observations at 18:00.',
        },
        reviewed: false,
      },
      checklistFocus: continuationChecklist,
      communicationRisks: [{
        id: 'risk-new',
        type: 'handover-gap',
        severity: 'medium',
        evidence: 'Latest observations were not stated.',
        mitigation: 'Verify the latest observations.',
        patientKey: 'patient-1',
      }],
      openQuestions: ['Verify: The latest observations were not stated.'],
    })
    let incoming = result(continuationAnalysis, { 'patient-1': 'patient-row-incoming' })

    let merged = mergeHandoverContinuation(existing, incoming)
    let mergedPatient = merged.analysis.patients[0]!

    assert.equal(merged.analysis.patients.length, 1)
    assert.equal(mergedPatient.patientKey, 'molly-harper-3a-01')
    assert.equal(mergedPatient.displayName, 'Molly Harper')
    assert.equal(mergedPatient.location, '3A-01')
    assert.equal(merged.patientProjections[0]?.id, 'patient-row-current')
    assert.deepEqual(mergedPatient.priorityScores, { acuity: 55, risk: 60, workflow: 70 })
    assert.match(
      merged.analysis.structuredSummary.situation,
      /Clinician-edited situation for Molly\.[\s\S]*The unnamed patient remains on the ward\./,
    )
    assert.match(
      merged.analysis.structuredSummary.recommendation,
      /Confirm allergy status\.[\s\S]*Repeat observations at 18:00\./,
    )
    assert.match(
      merged.analysis.structuredSummaryMeta.llmDraft.recommendation,
      /Repeat observations at 18:00/,
    )
    assert.equal(merged.analysis.structuredSummaryMeta.reviewed, false)

    assert.equal(
      merged.analysis.checklistFocus.find((item) => item.label === 'id_check')?.id,
      'reviewed-id-check',
    )
    assert.equal(
      merged.analysis.checklistFocus.find((item) => item.label === 'id_check')?.status,
      'addressed',
    )
    assert.equal(
      merged.analysis.checklistFocus.find((item) => item.label === 'rec_actions')?.status,
      'addressed',
    )

    assert.equal(mergedPatient.tasks.length, 3)
    assert.equal(mergedPatient.tasks.some((item) => item.id === 'task-deleted'), false)
    assert.equal(
      mergedPatient.tasks.some((item) => item.id === 'task-incoming-duplicate'),
      false,
    )
    assert.deepEqual(
      mergedPatient.tasks.find((item) => item.id === 'task-current'),
      {
        ...currentTask,
        relatedUncertaintyId: 'uncertainty-current',
      },
    )
    assert.deepEqual(
      mergedPatient.tasks.find((item) => item.id === 'task-manual'),
      manualTask,
    )
    assert.equal(mergedPatient.tasks.some((item) => item.id === 'task-new'), true)

    let mergedCurrentUncertainty = mergedPatient.uncertainties.find(
      (item) => item.id === 'uncertainty-current',
    )
    assert.equal(mergedCurrentUncertainty?.confidence, 'low')
    assert.equal(
      mergedCurrentUncertainty?.clinicianDecisionNote,
      'The chart was checked; pharmacy confirmation is pending.',
    )
    assert.equal(mergedCurrentUncertainty?.linkedTaskId, 'task-current')
    assert.match(mergedCurrentUncertainty?.verificationNeed ?? '', /Confirm with pharmacy/)
    assert.equal(
      mergedPatient.uncertainties.find((item) => item.id === 'uncertainty-new')?.linkedTaskId,
      'task-new',
    )
    assert.equal(merged.analysis.communicationRisks[0]?.patientKey, 'molly-harper-3a-01')
  })

  it('keeps the clinician task when an extension proposes different wording for the same uncertainty', () => {
    let clinicianTask = task('task-clinician', 'Check the chart with pharmacy', {
      dueLabel: 'Tomorrow at 09:00',
      dueAt: '2026-07-17T23:00:00.000Z',
      priority: 'high',
      status: 'in_progress',
      reminderEnabled: true,
      carriedForward: true,
      source: 'uncertainty',
      relatedUncertaintyId: 'uncertainty-current',
    })
    let currentPatient = patient('molly-harper', 'Molly Harper', 'Bed 1', {
      tasks: [clinicianTask],
      uncertainties: [uncertainty('uncertainty-current', 'The allergy status is unclear.', {
        linkedTaskId: clinicianTask.id,
        clinicianDecisionNote: 'Pharmacy will call the ward in the morning.',
      })],
    })
    let existing = result(
      analysis([currentPatient]),
      { 'molly-harper': 'patient-row-molly' },
      [{ patientKey: 'molly-harper', task: clinicianTask }],
    )

    let modelTask = task('task-model', 'Verify allergy documentation before the next dose', {
      priority: 'low',
      relatedUncertaintyId: 'uncertainty-incoming',
    })
    let incomingPatient = patient('molly-harper', 'Molly Harper', 'Bed 1', {
      tasks: [modelTask],
      uncertainties: [uncertainty('uncertainty-incoming', 'The allergy status is unclear.', {
        linkedTaskId: modelTask.id,
        verificationNeed: 'Verify the allergy documentation before the next dose.',
      })],
    })
    let incoming = result(
      analysis([incomingPatient]),
      { 'molly-harper': 'patient-row-regenerated' },
      [{ patientKey: 'molly-harper', task: modelTask }],
    )

    let merged = mergeHandoverContinuation(existing, incoming)
    let mergedPatient = merged.analysis.patients[0]!

    assert.deepEqual(mergedPatient.tasks, [clinicianTask])
    assert.deepEqual(merged.taskProjections, [{ patientKey: 'molly-harper', ...clinicianTask }])
    assert.equal(mergedPatient.uncertainties.length, 1)
    assert.equal(mergedPatient.uncertainties[0]?.id, 'uncertainty-current')
    assert.equal(mergedPatient.uncertainties[0]?.linkedTaskId, clinicianTask.id)
    assert.equal(
      mergedPatient.uncertainties[0]?.clinicianDecisionNote,
      'Pharmacy will call the ward in the morning.',
    )
    assert.match(
      mergedPatient.uncertainties[0]?.verificationNeed ?? '',
      /Verify the allergy documentation before the next dose\./,
    )
  })

  it('retains the prior roster and appends a genuinely new patient with its stable rows', () => {
    let molly = patient('molly-harper', 'Molly Harper', 'Bed 1')
    let existing = result(analysis([molly]), { 'molly-harper': 'patient-row-molly' })
    let jordanTask = task('task-jordan', 'Review Jordan before transfer')
    let jordan = patient('jordan-lee', 'Jordan Lee', 'Bed 2', { tasks: [jordanTask] })
    let incoming = result(
      analysis([jordan], {
        headline: 'Jordan was added after the handover resumed.',
        participants: ['Nurse Jules'],
      }),
      { 'jordan-lee': 'patient-row-jordan' },
    )

    let merged = mergeHandoverContinuation(existing, incoming)

    assert.deepEqual(
      merged.analysis.patients.map((item) => item.patientKey),
      ['molly-harper', 'jordan-lee'],
    )
    assert.deepEqual(
      merged.patientProjections.map((item) => [item.id, item.patientKey]),
      [
        ['patient-row-molly', 'molly-harper'],
        ['patient-row-jordan', 'jordan-lee'],
      ],
    )
    assert.equal(merged.taskProjections[0]?.id, 'task-jordan')
    assert.deepEqual(merged.analysis.participants, ['Nurse Avery', 'Nurse Jules'])
  })

  it('accepts a full combined re-analysis without duplicating prior facts or task rows', () => {
    let existingTask = task('task-existing', 'Repeat observations')
    let currentPatient = patient('molly-harper', 'Molly Harper', 'Bed 1', {
      tasks: [existingTask],
    })
    let existing = result(analysis([currentPatient], {
      headline: 'Molly is stable.',
    }), { 'molly-harper': 'patient-row-molly' })
    let newTask = task('task-new', 'Call respiratory team')
    let reanalysedPatient = patient('molly-harper', 'Molly Harper', 'Bed 1', {
      tasks: [
        task('task-regenerated', 'Repeat observations'),
        newTask,
      ],
      summary: {
        situation: 'Molly is receiving ward care.',
        background: 'Background was supplied.',
        assessment: 'The patient is stable with a new wheeze.',
        recommendation: 'Continue the current plan and call the respiratory team.',
      },
    })
    let incoming = result(analysis([reanalysedPatient], {
      headline: 'Molly is stable. A respiratory review is now required.',
      transcriptHighlights: [
        'Molly is receiving ward care.',
        'Call the respiratory team.',
      ],
    }), { 'molly-harper': 'regenerated-patient-row' })

    let merged = mergeHandoverContinuation(existing, incoming)

    assert.equal(
      merged.analysis.headline,
      'Molly is stable. A respiratory review is now required.',
    )
    assert.deepEqual(
      merged.analysis.transcriptHighlights,
      ['Molly is receiving ward care.', 'Call the respiratory team.'],
    )
    assert.deepEqual(
      merged.analysis.patients[0]?.tasks.map((item) => item.id),
      ['task-existing', 'task-new'],
    )
    assert.equal(merged.patientProjections[0]?.id, 'patient-row-molly')
  })

  it('keeps an already reviewed summary reviewed when the continuation adds no SBAR evidence', () => {
    let current = analysis([patient('molly-harper', 'Molly Harper', 'Bed 1')])
    current.structuredSummaryMeta.reviewed = true
    let incoming = analysis([patient('patient-1', 'Unnamed patient', 'Location not stated')], {
      structuredSummary: {
        situation: 'Not mentioned in supplied evidence.',
        background: 'Not mentioned in supplied evidence.',
        assessment: 'Not mentioned in supplied evidence.',
        recommendation: 'Not mentioned in supplied evidence.',
      },
      structuredSummaryMeta: {
        llmDraft: {
          situation: 'Not mentioned in supplied evidence.',
          background: 'Not mentioned in supplied evidence.',
          assessment: 'Not mentioned in supplied evidence.',
          recommendation: 'Not mentioned in supplied evidence.',
        },
        reviewed: false,
      },
      sbarEvidence: [],
    })

    let merged = mergeHandoverContinuation(
      result(current, { 'molly-harper': 'patient-row-molly' }),
      result(incoming, { 'patient-1': 'patient-row-generic' }),
    )

    assert.equal(merged.analysis.structuredSummaryMeta.reviewed, true)
    assert.deepEqual(merged.analysis.structuredSummary, current.structuredSummary)
    assert.equal(merged.analysis.patients.length, 1)
  })
})
