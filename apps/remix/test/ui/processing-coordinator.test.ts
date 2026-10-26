import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { createProcessingPollGate } from '../../app/assets/processing-coordinator.tsx'

describe('processing poll gate', () => {
  it('runs a wake-up received during an in-flight reconciliation immediately', () => {
    let scheduled: number[] = []
    let gate = createProcessingPollGate((delay) => scheduled.push(delay))

    assert.equal(gate.start(), true)
    gate.request()
    gate.finish(15_000)

    assert.deepEqual(scheduled, [0])
  })

  it('uses the recovery interval only when no wake-up is pending', () => {
    let scheduled: number[] = []
    let gate = createProcessingPollGate((delay) => scheduled.push(delay))

    assert.equal(gate.start(), true)
    gate.finish(15_000)

    assert.deepEqual(scheduled, [15_000])
  })
})
