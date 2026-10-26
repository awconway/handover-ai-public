import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  patientWorkspaceActionHref,
  patientWorkspaceHref,
  reviewHref,
} from '../../app/routes.ts'

describe('typed application route helpers', () => {
  it('builds individual and shift-scoped review routes', () => {
    assert.equal(
      reviewHref({ handoverId: 'handover-1', reviewTab: 'summary' }),
      '/handover/handover-1/summary',
    )
    assert.equal(
      reviewHref({ shiftId: 'shift-1', handoverId: 'handover-1', reviewTab: 'tasks' }),
      '/shift/shift-1/handover/handover-1/tasks',
    )
  })

  it('uses the canonical patient workspace path for each typed tab', () => {
    assert.equal(
      patientWorkspaceHref({ shiftId: 'shift-1', patientKey: 'patient-1', tab: 'handover-sheet' }),
      '/shift/shift-1/patients/patient-1',
    )
    assert.equal(
      patientWorkspaceHref({ shiftId: 'shift-1', patientKey: 'patient-1', tab: 'actions' }),
      '/shift/shift-1/patients/patient-1/actions',
    )
    assert.equal(
      patientWorkspaceActionHref({
        shiftId: 'shift-1',
        patientKey: 'patient-1',
        tab: 'actions',
        action: 'add',
      }),
      '/shift/shift-1/patients/patient-1/actions/add',
    )
  })
})

if (false) {
  // These calls are deliberately never executed. `tsc --noEmit` verifies that
  // application code cannot construct URLs with unsupported dynamic segments.
  // @ts-expect-error "overview" is not a registered review tab.
  reviewHref({ handoverId: 'handover-1', reviewTab: 'overview' })
  // @ts-expect-error "notes" is not a registered patient workspace tab.
  patientWorkspaceHref({ shiftId: 'shift-1', patientKey: 'patient-1', tab: 'notes' })
  // @ts-expect-error "edit" is not a registered patient workspace action.
  patientWorkspaceActionHref({ shiftId: 'shift-1', patientKey: 'patient-1', tab: 'actions', action: 'edit' })
}
