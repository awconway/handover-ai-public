import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'
import type { Database, SqlStatement } from 'remix/data-table'

import {
  updateHandoverChecklistItem,
  updateHandoverSummaryReviewStatus,
  updateHandoverSummarySection,
} from '../../app/data/repository.ts'

class ReviewMutationDatabase {
  statements: SqlStatement[] = []
  analysis: Record<string, unknown>

  constructor(analysis: Record<string, unknown>) {
    this.analysis = analysis
  }

  async transaction<T>(callback: (db: Database) => Promise<T>): Promise<T> {
    return callback(this as unknown as Database)
  }

  async exec(statement: SqlStatement) {
    this.statements.push(statement)
    if (/select h\.\* from handovers h/.test(statement.text)) {
      return { rows: [{
        id: 'handover-1', created_by_user_id: 'user-1', participants: [], shared_with_user_ids: [],
        transcription_metadata: null, analysis: structuredClone(this.analysis),
      }] }
    }
    if (/update handovers set analysis=/.test(statement.text)) {
      this.analysis = JSON.parse(String(statement.values[0])) as Record<string, unknown>
    }
    return { rows: [] }
  }
}

describe('clinician review mutations', () => {
  it('locks the accessible handover and changes only the requested checklist item', async () => {
    let db = new ReviewMutationDatabase({
      checklistFocus: [
        { id: 'identity', label: 'id_check', status: 'missing', note: 'Confirm identity' },
        { id: 'allergies', label: 'bg_allergies', status: 'partial', note: 'Allergy unclear' },
      ],
      structuredSummary: { situation: 'Stable' },
      clinicianMarker: 'preserve-me',
    })

    assert.equal(await updateHandoverChecklistItem(db as unknown as Database, {
      id: 'handover-1', userId: 'user-1', checklistItemId: 'identity', covered: true,
    }), true)
    assert.match(db.statements[0]!.text, /for update of h/)
    assert.deepEqual(db.analysis.checklistFocus, [
      { id: 'identity', label: 'id_check', status: 'addressed', note: 'Confirm identity' },
      { id: 'allergies', label: 'bg_allergies', status: 'partial', note: 'Allergy unclear' },
    ])
    assert.equal(db.analysis.clinicianMarker, 'preserve-me')
  })

  it('patches one latest SBAR section while preserving another edit and the model draft', async () => {
    let draft = { situation: 'Draft situation', background: 'Draft background', assessment: 'Draft assessment', recommendation: 'Draft recommendation' }
    let db = new ReviewMutationDatabase({
      structuredSummary: { ...draft, background: 'Earlier clinician edit' },
      structuredSummaryMeta: { llmDraft: draft, reviewed: true, marker: 'preserve-me' },
      checklistFocus: [{ id: 'identity', status: 'addressed' }],
    })

    assert.equal(await updateHandoverSummarySection(db as unknown as Database, {
      id: 'handover-1', userId: 'user-1', section: 'assessment', value: 'Latest clinician assessment',
    }), true)
    assert.equal((db.analysis.structuredSummary as any).background, 'Earlier clinician edit')
    assert.equal((db.analysis.structuredSummary as any).assessment, 'Latest clinician assessment')
    assert.deepEqual((db.analysis.structuredSummaryMeta as any).llmDraft, draft)
    assert.equal((db.analysis.structuredSummaryMeta as any).reviewed, false)
    assert.equal((db.analysis.structuredSummaryMeta as any).marker, 'preserve-me')
    assert.deepEqual((db.analysis.structuredSummaryMeta as any).edits.map((edit: any) => ({
      section: edit.section,
      previousValue: edit.previousValue,
      nextValue: edit.nextValue,
      byUserId: edit.byUserId,
    })), [{
      section: 'assessment',
      previousValue: 'Draft assessment',
      nextValue: 'Latest clinician assessment',
      byUserId: 'user-1',
    }])

    assert.equal(await updateHandoverSummaryReviewStatus(db as unknown as Database, {
      id: 'handover-1', userId: 'user-1', reviewed: true,
    }), true)
    assert.equal((db.analysis.structuredSummary as any).assessment, 'Latest clinician assessment')
    assert.deepEqual((db.analysis.structuredSummaryMeta as any).llmDraft, draft)
    assert.equal((db.analysis.structuredSummaryMeta as any).reviewed, true)
  })
})
