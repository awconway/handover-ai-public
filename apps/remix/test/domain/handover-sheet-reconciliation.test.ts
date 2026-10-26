import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import type { HandoverSheetPatientField } from '../../app/data/handover-sheet.ts'
import {
  createHandoverSheetReconciliationPrompt,
  createOpenAIHandoverSheetReconciliationRequester,
  reconcileHandoverSheetWithSbar,
  type HandoverSheetReconciliationRequester,
  type HandoverSheetSbarReconciliationInput,
} from '../../app/domain/handover-sheet-reconciliation.server.ts'

function input(): HandoverSheetSbarReconciliationInput {
  let sheetFields: HandoverSheetPatientField[] = [{
    label: 'Assessment and Management',
    columnKey: 'assessment_management',
    value: 'Afebrile. IV antibiotics.',
    finalAcceptedValue: 'Afebrile. IV antibiotics.',
    reviewStatus: 'human_verified',
    reviewMethod: 'human',
    uncertain: false,
    issues: [],
  }]
  return {
    handoverId: 'handover-1',
    handoverTitle: 'Ward update',
    patient: { patientKey: 'molly-harper', displayName: 'Molly Harper', location: '3A-01' },
    sheetFields,
    structuredSummary: {
      situation: 'Molly Harper remains stable.',
      background: 'Admitted with pneumonia.',
      assessment: 'Afebrile. Changed to oral antibiotics today.',
      recommendation: 'Review observations at 16:00.',
    },
    sbarEvidence: [{ label: 'ASSESSMENT', quote: 'Changed to oral antibiotics today' }],
  }
}

describe('handover-sheet SBAR reconciliation', () => {
  it('sends the final reviewed sheet value and evidence to the model', () => {
    let prompt = JSON.parse(createHandoverSheetReconciliationPrompt(input()))
    let assessment = prompt.currentSheet.find((field: { columnKey: string }) => field.columnKey === 'assessment_management')
    assert.equal(assessment.value, 'Afebrile. IV antibiotics.')
    assert.equal(prompt.sbarSummary.assessment, 'Afebrile. Changed to oral antibiotics today.')
    assert.deepEqual(prompt.sbarEvidence, [{ label: 'ASSESSMENT', quote: 'Changed to oral antibiotics today' }])
  })

  it('keeps only unique changes whose quote occurs in the named SBAR section', async () => {
    let requester: HandoverSheetReconciliationRequester = {
      async request() {
        return { changes: [
          {
            columnKey: 'assessment_management',
            nextValue: 'Afebrile. Changed to oral antibiotics today.',
            sbarSection: 'assessment',
            summaryQuote: 'Changed to oral antibiotics today',
            rationale: 'The latest assessment changes current management.',
          },
          {
            columnKey: 'assessment_management',
            nextValue: 'Afebrile. Changed to oral antibiotics today.',
            sbarSection: 'assessment',
            summaryQuote: 'Changed to oral antibiotics today',
            rationale: 'Duplicate proposal.',
          },
          {
            columnKey: 'planning',
            nextValue: 'Discharge tomorrow.',
            sbarSection: 'recommendation',
            summaryQuote: 'Discharge tomorrow',
            rationale: 'Unsupported proposal.',
          },
        ] }
      },
    }
    let changes = await reconcileHandoverSheetWithSbar(input(), { requester })
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.columnKey, 'assessment_management')
    assert.equal(changes[0]!.summaryQuote, 'Changed to oral antibiotics today')
  })

  it('requires the configured OpenAI key without exposing it', () => {
    assert.throws(
      () => createOpenAIHandoverSheetReconciliationRequester({ apiKey: '' }),
      /OPENAI_API_KEY is required/,
    )
  })
})
