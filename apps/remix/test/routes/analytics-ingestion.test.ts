import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { analyticsProperties, sanitizeAnalyticsRoute } from '../../app/actions/resources/controller.tsx'
import { routes } from '../../app/routes.ts'

describe('analytics ingestion privacy and reporting parity', () => {
  it('retains literal review tabs while redacting record identifiers', () => {
    assert.equal(sanitizeAnalyticsRoute('/handover/h-secret/checklist'), '/handover/:id/checklist')
    assert.equal(sanitizeAnalyticsRoute('/shift/s-secret/handover/h-secret/tasks'), '/shift/:id/handover/:id/tasks')
    assert.equal(sanitizeAnalyticsRoute('/shift/s-secret/patients/p-secret/actions/add'), '/shift/:id/patients/:id/actions/add')
    assert.equal(sanitizeAnalyticsRoute('/shift/s-secret/handover/h-secret/not-a-tab'), '/unknown')
  })

  it('retains the content-free workflow fields used by usability reports', () => {
    assert.deepEqual(analyticsProperties({
      workflow: 'update-task-reminder',
      studyTask: 'task-update-reminder',
      step: 'submit',
      outcome: 'success',
      reason: 'mutation-failed',
      prevented: true,
      nextRoute: '/shift/private/handover/private/tasks',
      patientName: 'must not be retained',
      sandbox: false,
    }), {
      workflow: 'update-task-reminder',
      studyTask: 'task-update-reminder',
      studyTaskId: 'task-update-reminder',
      step: 'submit',
      outcome: 'success',
      reason: 'mutation-failed',
      prevented: true,
      nextRoute: '/shift/:id/handover/:id/tasks',
      sandbox: false,
    })
  })

  it('retains sanitized API and performance metadata without endpoint identifiers', () => {
    let taskAction = routes.actions.updateTask.href({ taskId: 'private-task-id' })
    let processingPath = routes.resources.processing.href({ handoverId: 'private-handover-id' })
    assert.deepEqual(analyticsProperties({
      action: taskAction,
      path: processingPath,
      method: 'POST',
      metric: 'inp',
      errorCategory: 'dom-exception',
      errorName: 'HierarchyRequestError',
      source: 'performance-observer',
    }), {
      action: '/actions/tasks/:id',
      path: '/resources/handovers/:id/processing',
      method: 'POST',
      metric: 'inp',
      errorCategory: 'dom-exception',
      errorName: 'HierarchyRequestError',
      source: 'performance-observer',
      sandbox: false,
    })
  })

  it('retains the declared processing collection route', () => {
    let href = routes.resources.processingAll.href()
    assert.equal(sanitizeAnalyticsRoute(href), href)
  })

  it('rejects an undeclared task collection route', () => {
    assert.equal(sanitizeAnalyticsRoute('/actions/tasks'), '/unknown')
    assert.equal(sanitizeAnalyticsRoute('/actions/tasks/private-task-id/reminder'), '/unknown')
  })

  it('accepts every declared action shape without retaining route parameters', () => {
    let id = 'private-id'
    let hrefs = [
      routes.actions.createShift.href(),
      routes.actions.deleteShift.href({ shiftId: id }),
      routes.actions.updateShiftPatient.href({ shiftId: id, patientKey: id }),
      routes.actions.orderPatients.href({ shiftId: id }),
      routes.actions.prioritiseShift.href({ shiftId: id }),
      routes.actions.createHandover.href(),
      routes.actions.deleteHandover.href({ handoverId: id }),
      routes.actions.discardFailedHandover.href({ handoverId: id }),
      routes.actions.extendHandover.href({ handoverId: id }),
      routes.actions.retryHandover.href({ handoverId: id }),
      routes.actions.updateMetadata.href({ handoverId: id }),
      routes.actions.updateChecklist.href({ handoverId: id }),
      routes.actions.updateSummary.href({ handoverId: id }),
      routes.actions.updateSummaryReview.href({ handoverId: id }),
      routes.actions.createTask.href({ handoverId: id }),
      routes.actions.createUncertaintyTask.href({ handoverId: id, uncertaintyId: id }),
      routes.actions.updateTask.href({ taskId: id }),
      routes.actions.deleteTask.href({ taskId: id }),
      routes.actions.createAssignments.href(),
      routes.actions.placeAssignment.href({ assignmentId: id }),
      routes.actions.addAssignmentToIndividual.href({ assignmentId: id }),
      routes.actions.dismissAssignment.href({ assignmentId: id }),
      routes.actions.importHandoverSheet.href({ shiftId: id }),
      routes.actions.reviewPatientDetails.href({ shiftId: id, patientKey: id }),
      routes.actions.reviewPatientField.href({ shiftId: id, patientKey: id, fieldKey: id }),
    ]

    for (let href of hrefs) {
      let sanitized = sanitizeAnalyticsRoute(href)
      assert.notEqual(sanitized, '/unknown', href)
      assert.doesNotMatch(sanitized, /private-id/)
    }
  })
})
