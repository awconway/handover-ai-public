import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { routes } from '../../app/routes.ts'
import {
  analyticsSequenceStorageKey,
  createAnalyticsSequenceCounter,
  createClsSessionWindowTracker,
  createDocumentVitalsAccumulator,
  createInteractionLatencyTracker,
  sanitizeAnalyticsRoute,
  sanitizeTargetIdentifier,
} from '../../app/assets/analytics-coordinator.tsx'

describe('analytics route privacy', () => {
  it('redacts clinical route identifiers and encoded patient keys', () => {
    assert.equal(sanitizeAnalyticsRoute('/handover/handover-secret/checklist'), '/handover/:id/checklist')
    assert.equal(sanitizeAnalyticsRoute('/shift/shift-secret/handover/handover-secret/tasks'), '/shift/:id/handover/:id/tasks')
    assert.equal(sanitizeAnalyticsRoute('/shift/shift-secret/patients/Arthur%20Morgan/handover-sheet'), '/shift/:id/patients/:id/handover-sheet')
    assert.equal(sanitizeAnalyticsRoute('/resources/handovers/handover-secret/processing'), '/resources/handovers/:id/processing')
    assert.equal(sanitizeAnalyticsRoute('/actions/shifts/shift-secret/patients/patient-42/handover-sheet/fields/allergies'), '/actions/shifts/:id/patients/:id/handover-sheet/fields/:id')
  })

  it('collapses non-contract route variants', () => {
    assert.equal(sanitizeAnalyticsRoute('/individual/new'), '/unknown')
    assert.equal(sanitizeAnalyticsRoute('/actions/tasks'), '/unknown')
    assert.equal(sanitizeAnalyticsRoute('/actions/tasks/private-task-id/reminder'), '/unknown')
    assert.equal(sanitizeAnalyticsRoute('/future/private-workflow/start'), '/unknown')
  })

  it('collapses unknown route shapes instead of leaking new segments', () => {
    assert.equal(sanitizeAnalyticsRoute('/future/patient-name/private-view'), '/unknown')
  })

  it('retains the declared processing collection route', () => {
    let href = routes.resources.processingAll.href()
    assert.equal(sanitizeAnalyticsRoute(href), href)
  })
})

describe('analytics event sequence', () => {
  it('continues monotonically across collector installs and overlapping counters', () => {
    let values = new Map<string, string>()
    let storage = {
      getItem(key: string) { return values.get(key) ?? null },
      setItem(key: string, value: string) { values.set(key, value) },
    }
    let firstInstall = createAnalyticsSequenceCounter(storage)
    assert.equal(firstInstall.next(), 1)
    assert.equal(firstInstall.next(), 2)

    let secondInstall = createAnalyticsSequenceCounter(storage)
    assert.equal(secondInstall.next(), 3)
    assert.equal(firstInstall.next(), 4)
    assert.equal(values.get(analyticsSequenceStorageKey), '4')
  })

  it('recovers an invalid stored value', () => {
    let value = 'not-a-sequence'
    let storage = {
      getItem() { return value },
      setItem(_key: string, next: string) { value = next },
    }
    assert.equal(createAnalyticsSequenceCounter(storage).next(), 1)
    assert.equal(value, '1')
  })
})

describe('analytics target privacy', () => {
  it('redacts task ids, patient ids, and dates from target identifiers', () => {
    assert.equal(sanitizeTargetIdentifier('task-edit-OfXYiTnFgEk-hppiRU9Dx'), 'task-edit-:id')
    assert.equal(sanitizeTargetIdentifier('patient-card-Arthur-Dent'), 'patient-card-:id')
    assert.equal(sanitizeTargetIdentifier('new-task-due-picker-day-2026-07-31'), 'new-task-due-picker-day-:id')
    assert.equal(sanitizeTargetIdentifier('start-shift'), 'start-shift')
    assert.equal(sanitizeTargetIdentifier('unsafe patient name'), null)
  })
})

describe('document performance vitals', () => {
  it('uses the largest CLS session window instead of summing the full visit', () => {
    let tracker = createClsSessionWindowTracker()
    tracker.add([
      { startTime: 100, value: 0.1 },
      { startTime: 700, value: 0.12 },
      { startTime: 1_900, value: 0.2 },
      { startTime: 2_500, value: 0.08 },
      { startTime: 2_700, value: 0.9, hadRecentInput: true },
      { startTime: 7_600, value: 0.04 },
    ])

    assert.equal(tracker.value(), 0.28)
  })

  it('groups event timings by interaction and uses a p98-style INP value', () => {
    let shortVisit = createInteractionLatencyTracker()
    shortVisit.add([
      { interactionId: 1, duration: 80 },
      { interactionId: 1, duration: 250 },
      { interactionId: 2, duration: 200 },
    ])
    assert.equal(shortVisit.count(), 2)
    assert.equal(shortVisit.value(), 250)
    assert.equal(shortVisit.value(50), 200)

    let longerVisit = createInteractionLatencyTracker()
    longerVisit.add([
      { interactionId: 1, duration: 80 },
      { interactionId: 1, duration: 250 },
      { interactionId: 2, duration: 200 },
      ...Array.from({ length: 48 }, (_, index) => ({ interactionId: index + 3, duration: 100 + index })),
    ])
    assert.equal(longerVisit.count(), 50)
    assert.equal(longerVisit.value(), 200)
  })

  it('pins document-wide vitals to the sanitized document-entry route', () => {
    let vitals = createDocumentVitalsAccumulator('/shift/private-shift/handover/private-handover/checklist')
    vitals.addLargestContentfulPaint([{ startTime: 812.4 }])
    vitals.addLayoutShifts([{ startTime: 100, value: 0.12345 }])
    vitals.addInteractions([{ interactionId: 7, duration: 237.8 }])

    assert.deepEqual(vitals.measurements(), [
      { metric: 'lcp', value: 812, durationMs: 812, route: '/shift/:id/handover/:id/checklist' },
      { metric: 'cls', value: 0.1235, route: '/shift/:id/handover/:id/checklist' },
      { metric: 'inp', value: 238, durationMs: 238, route: '/shift/:id/handover/:id/checklist' },
    ])
  })
})
