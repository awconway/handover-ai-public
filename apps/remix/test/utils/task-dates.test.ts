import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
  formatTaskDueDateTime,
  getTaskDueDisplay,
  taskDueIsoValue,
  taskDueLocalValue,
} from '../../app/assets/task-dates.ts'
import { DEFAULT_TASK_DUE_LABEL, resolveTaskDueInput } from '../../app/utils/task-dates.ts'

describe('task due dates', () => {
  it('keeps the browser ISO instant and its human-readable label together', () => {
    let resolved = resolveTaskDueInput({
      dueAt: '2026-07-14T05:30:00.000Z',
      dueLocal: '2026-07-14T15:30',
      dueLabel: '14 Jul 2026, 3:30 PM',
    })

    assert.equal(resolved.success, true)
    if (!resolved.success) return
    assert.equal(resolved.dueAt?.toISOString(), '2026-07-14T05:30:00.000Z')
    assert.equal(resolved.dueLabel, '14 Jul 2026, 3:30 PM')
  })

  it('accepts a native datetime-local value for the no-JS form path', () => {
    let resolved = resolveTaskDueInput({
      dueAt: '',
      dueLocal: '2026-07-14T15:30',
      dueLabel: DEFAULT_TASK_DUE_LABEL,
    })

    assert.equal(resolved.success, true)
    if (!resolved.success) return
    assert.equal(resolved.dueAt?.toISOString(), new Date(2026, 6, 14, 15, 30).toISOString())
    assert.equal(resolved.dueLabel, formatTaskDueDateTime(resolved.dueAt!))
  })

  it('rejects malformed or impossible dates and supports clearing a due date', () => {
    assert.deepEqual(resolveTaskDueInput({ dueAt: 'tomorrow', dueLocal: '', dueLabel: '' }), { success: false })
    assert.deepEqual(resolveTaskDueInput({ dueAt: '', dueLocal: '2026-02-30T12:00', dueLabel: '' }), { success: false })
    assert.deepEqual(resolveTaskDueInput({ dueAt: '', dueLocal: '', dueLabel: '' }), {
      success: true,
      dueAt: null,
      dueLabel: DEFAULT_TASK_DUE_LABEL,
    })
  })

  it('round-trips the browser-local input value and formats the display deterministically', () => {
    let dueAt = new Date(2026, 6, 14, 15, 30)
    let localValue = taskDueLocalValue(dueAt)
    assert.equal(localValue, '2026-07-14T15:30')
    assert.equal(taskDueIsoValue(localValue), dueAt.toISOString())
    assert.equal(formatTaskDueDateTime('2026-07-14T15:30:00.000Z', 'UTC'), '14 Jul 2026, 3:30 PM')
    assert.equal(getTaskDueDisplay(null), DEFAULT_TASK_DUE_LABEL)
  })
})
