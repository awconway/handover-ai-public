import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import { render } from 'remix/component/test'
import { computedStyle } from './styles.ts'

import { PatientWorkspacePage } from '../../app/ui/workspace-pages.tsx'
import type { HandoverSheetField } from '../../app/ui/models.ts'
import { patientWorkspaceHref, reviewHref, routes } from '../../app/routes.ts'

const shiftHref = routes.workspace.shift.href({ shiftId: 's1' })
const patientHref = routes.workspace.patient.href({ shiftId: 's1', patientKey: 'p1' })
const patientActionsHref = patientWorkspaceHref({ shiftId: 's1', patientKey: 'p1', tab: 'actions' })
const summaryHref = reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'summary' })

const canonicalFields: HandoverSheetField[] = [
  { key: 'bed', label: 'Bed', value: '3A-01', editValue: '3A-01', confidence: 'high', status: 'accepted' },
  { key: 'name', label: 'Name', value: 'Molly Harper', editValue: 'Molly Harper', confidence: 'high', status: 'accepted' },
  { key: 'alerts_allergies', label: 'Alerts / Allergies', value: 'Penicillin allergy', editValue: 'Penicillin allergy', confidence: 'high', status: 'accepted' },
  { key: 'consultant', label: 'Consultant', value: 'Dr Priya Shah', editValue: 'Dr Priya Shah', confidence: 'high', status: 'accepted' },
  {
    key: 'diagnosis',
    label: 'Diagnosis',
    value: 'Sepsis',
    editValue: 'Sepsis',
    confidence: 'low',
    status: 'edited',
    reviewStatus: 'needs_review',
    alternatives: ['Septic illness'],
    reviewEvents: [{ at: '2026-07-13T01:00:00.000Z', byUserId: 'u1', previousValue: 'Seps1s', nextValue: 'Sepsis', method: 'human' }],
  },
  { key: 'background', label: 'Background', value: 'Independent baseline.', editValue: 'Independent baseline.', confidence: 'high', status: 'pending', multiline: true },
  { key: 'diet', label: 'Diet', value: 'Soft diet', editValue: 'Soft diet', confidence: 'high', status: 'pending' },
  { key: 'mobility_fall', label: 'Mobility/Fall', value: 'One assist', editValue: 'One assist', confidence: 'high', status: 'pending' },
  {
    key: 'assessment_management',
    label: 'Assessment and Management',
    value: 'Afebrile and antibiotics changed to oral.',
    editValue: 'Afebrile and antibiotics changed to oral.',
    confidence: 'low',
    status: 'pending',
    reviewStatus: 'needs_review',
    multiline: true,
    reviewEvents: [{
      at: '2026-07-13T02:00:00.000Z',
      byUserId: 'system:sbar-reconciliation',
      previousValue: 'Afebrile.',
      nextValue: 'Afebrile and antibiotics changed to oral.',
      method: 'llm',
    }],
    sbarUpdateEvents: [{
      at: '2026-07-13T02:00:00.000Z',
      handoverId: 'h1',
      handoverTitle: 'Ward update',
      sbarSection: 'assessment',
      previousValue: 'Afebrile.',
      nextValue: 'Afebrile and antibiotics changed to oral.',
      summaryQuote: 'Changed to oral antibiotics.',
      rationale: 'Current management plan.',
      sourceHref: summaryHref,
    }],
  },
  { key: 'edd', label: 'EDD', value: '27 Jun', editValue: '27 Jun', confidence: 'high', status: 'pending' },
  { key: 'planning', label: 'Planning', value: 'Home with community review.', editValue: 'Home with community review.', confidence: 'high', status: 'pending', multiline: true },
]

describe('patient handover-sheet parity', () => {
  it('renders the canonical row order, pencil review flow, alternatives, and provenance', async () => {
    let result = render(<PatientWorkspacePage
      patient={{ key: 'p1', displayName: 'Molly Harper', bed: '3A-01', href: patientHref, handovers: [], processingHandovers: [] }}
      shift={{ id: 's1', title: 'Day shift', department: 'Medicine', href: shiftHref }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }, { key: 'actions', label: 'Actions', href: patientActionsHref }]}
      activeTab="sheet"
      sheetFields={canonicalFields.map((field) => ({
        ...field,
        reviewAction: routes.actions.reviewPatientField.href({ shiftId: 's1', patientKey: 'p1', fieldKey: field.key }),
      }))}
      csrfToken="csrf"
    />)

    let rows = Array.from(result.container.querySelectorAll<HTMLElement>('[data-testid^="patient-sheet-field-"]'))
    assert.equal(rows.length, 11)
    assert.deepEqual(rows.map((row) => row.querySelector('[data-field-label]')?.textContent), canonicalFields.map((field) => field.label))
    let diagnosis = result.$('[data-testid="patient-sheet-field-diagnosis"]')!
    assert.equal(diagnosis.getAttribute('data-confidence'), null)
    assert.doesNotMatch(diagnosis.textContent ?? '', /low confidence|accepted|edited/)
    assert.match(diagnosis.textContent ?? '', /Model alternatives/)
    assert.match(diagnosis.textContent ?? '', /Septic illness/)

    assert.equal(diagnosis.querySelector('[data-edited="true"]'), null)
    assert.match(diagnosis.querySelector('details')?.textContent ?? '', /View version history.*Manual edit.*Seps1s/s)

    await result.act(() => diagnosis.querySelector<HTMLButtonElement>('button[aria-label="Edit Diagnosis"]')?.click())
    let diagnosisForm = diagnosis.querySelector<HTMLFormElement>('form[data-workflow="review-patient-sheet-field"]')!
    assert.equal(diagnosisForm.getAttribute('action'), routes.actions.reviewPatientField.href({ shiftId: 's1', patientKey: 'p1', fieldKey: 'diagnosis' }))
    assert.equal(diagnosisForm.querySelector<HTMLTextAreaElement>('textarea[name="value"]')?.value, 'Sepsis')
    assert.equal(diagnosisForm.querySelector<HTMLInputElement>('input[name="decision"]')?.value, 'edited')
    assert.match(diagnosis.textContent ?? '', /Model alternativesSeptic illness/)
    assert.deepEqual(
      Array.from(diagnosisForm.querySelectorAll<HTMLButtonElement>('button')).map((button) => button.textContent?.trim()),
      ['Save review', 'Cancel'],
    )

    let background = result.$('[data-testid="patient-sheet-field-background"]')!
    await result.act(() => background.querySelector<HTMLButtonElement>('button[aria-label="Edit Background"]')?.click())
    assert.ok(background.querySelector('textarea[name="value"]'))

    let assessment = result.$('[data-testid="patient-sheet-field-assessment_management"]')!
    let assessmentHistory = assessment.querySelector<HTMLDetailsElement>('details')!
    await result.act(() => assessmentHistory.querySelector<HTMLElement>('summary')?.click())
    assert.equal(assessmentHistory.open, true)
    assert.equal(assessment.querySelectorAll('ol > li').length, 1)
    assert.doesNotMatch(assessmentHistory.textContent ?? '', /Model update/)
    assert.equal(
      assessment.querySelector('a[aria-label="Open SBAR Assessment for Ward update"]')?.getAttribute('href'),
      summaryHref,
    )
    result.cleanup()
  })

  it('matches the processing log and keeps the canonical table instead of a Remix-only import panel', () => {
    let result = render(<PatientWorkspacePage
      patient={{
        key: 'p1',
        displayName: 'Molly Harper',
        bed: '3A-01',
        handoverCount: 0,
        href: patientHref,
        handovers: [],
        processingHandovers: [{ id: 'h1', title: 'Ward update', status: 'queued', direction: 'intra-shift', updatedAt: '2026-07-13T02:00:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'checklist' }) }],
      }}
      shift={{ id: 's1', title: 'Day shift', department: 'Medicine', href: shiftHref }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }]}
      activeTab="sheet"
      sheetFields={canonicalFields}
      csrfToken="csrf"
    />)
    assert.match(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /^Processing handovers/)
    assert.doesNotMatch(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /communication events? linked to this patient|open actions/)
    assert.match(result.$('[aria-label="Processing handovers"]')?.textContent ?? '', /1 pending/)
    assert.match(result.$('[data-testid="patient-sheet-table"]')?.textContent ?? '', /Update processing/)
    assert.equal(result.$$('[data-testid^="patient-sheet-field-"]').length, 11)
    assert.doesNotMatch(result.container.textContent ?? '', /Extracting patient details|Import a handover sheet/)
    result.cleanup()
  })

  it('matches completed and persisted-processing handover log states', () => {
    let result = render(<PatientWorkspacePage
      patient={{
        key: 'p1',
        displayName: 'Molly Harper',
        bed: '3A-01',
        handoverCount: 2,
        latestHandoverId: 'h2',
        openTaskCount: 1,
        href: patientHref,
        handovers: [
          { id: 'h1', title: 'Receiving handover', status: 'completed', direction: 'incoming', updatedAt: '2026-07-13T01:00:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'checklist' }) },
          { id: 'h2', title: 'Current ward update', status: 'analysing', direction: 'intra-shift', updatedAt: '2026-07-13T02:00:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h2', reviewTab: 'checklist' }) },
        ],
        processingHandovers: [],
      }}
      shift={{ id: 's1', title: 'Day shift', department: 'Medicine', href: shiftHref }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }]}
      activeTab="sheet"
      sheetFields={canonicalFields}
    />)
    let log = result.$('[data-testid="patient-handover-log"]')!
    assert.equal(log.querySelector('header'), null)
    assert.doesNotMatch(log.textContent ?? '', /Handover log/)
    assert.doesNotMatch(log.textContent ?? '', /communication events? linked to this patient|open actions/)
    assert.match(log.textContent ?? '', /intra-shiftAnalysing/)
    assert.match(log.textContent ?? '', /receiving/)
    assert.equal(log.querySelector('[aria-label="Processing handovers"]'), null)
    let handoverGrid = log.querySelector(':scope > div > div')
    assert.equal(computedStyle(handoverGrid).display, 'grid')
    assert.equal(computedStyle(handoverGrid).gridTemplateColumns.split(' ').length, matchMedia('(min-width: 48rem)').matches ? 2 : 1)
    assert.doesNotMatch(result.$('[data-testid="patient-sheet-table"]')?.textContent ?? '', /Open latest SBAR/)
    assert.match(result.$('[data-testid="patient-sheet-table"]')?.textContent ?? '', /Update processing/)
    result.cleanup()
  })

  it('shows a persisted failure without treating it as an active sheet update', () => {
    let result = render(<PatientWorkspacePage
      patient={{
        key: 'p1',
        displayName: 'Molly Harper',
        bed: '3A-01',
        handoverCount: 1,
        href: patientHref,
        handovers: [{ id: 'h1', title: 'Interrupted handover', status: 'failed', direction: 'incoming', updatedAt: '2026-07-13T01:00:00.000Z', href: reviewHref({ shiftId: 's1', handoverId: 'h1', reviewTab: 'checklist' }) }],
        processingHandovers: [],
      }}
      shift={{ id: 's1', title: 'Day shift', department: 'Medicine', href: shiftHref }}
      tabs={[{ key: 'sheet', label: 'Handover sheet', href: patientHref }]}
      activeTab="sheet"
      sheetFields={canonicalFields}
    />)
    assert.match(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /Processing failed/)
    assert.doesNotMatch(result.$('[data-testid="patient-handover-log"]')?.textContent ?? '', /still processing/)
    assert.doesNotMatch(result.$('[data-testid="patient-sheet-table"]')?.textContent ?? '', /Update processing/)
    result.cleanup()
  })
})
