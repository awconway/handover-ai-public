import fs from 'node:fs/promises'

import * as assert from 'remix/assert'
import { type Database, type SqlStatement } from 'remix/data-table'
import { describe, it } from 'remix/test'

import {
  getLocalFirstProcessingPreferenceForUser,
  handoversHaveLocalFirstProcessingHistory,
  isLocalFirstProcessingPreferenceEditable,
  isLocalFirstAudioStorageBackendCompatible,
  isPrivacyMode,
  normalizePrivacyMode,
  parseHandoverJobPayload,
  resolveEffectiveProcessingMode,
  resolveLocalFirstProcessingPolicy,
  updateLocalFirstProcessingPreferenceForUser,
  type HandoverJobPayload,
} from '../../app/data/index.ts'

function user(id: string, enabled: boolean) {
  return {
    id,
    full_name: id === 'user-1' ? 'Avery Clinician' : 'Jordan Clinician',
    occupation: 'Nurse',
    department: 'Medicine',
    local_first_processing_enabled: enabled,
    created_at: new Date(),
    updated_at: new Date(),
    last_active_at: new Date(),
  }
}

class PreferenceDatabase {
  users = new Map([
    ['user-1', user('user-1', false)],
    ['user-2', user('user-2', true)],
  ])
  statements: SqlStatement[] = []

  async find(_table: unknown, id: string) {
    return this.users.get(id) ?? null
  }

  async exec(statement: SqlStatement | string) {
    assert.notEqual(typeof statement, 'string')
    this.statements.push(statement as SqlStatement)
    let [enabled, userId] = (statement as SqlStatement).values as [boolean, string]
    let existing = this.users.get(userId)
    if (!existing) return { rows: [] }
    let updated = { ...existing, local_first_processing_enabled: enabled, updated_at: new Date() }
    this.users.set(userId, updated)
    return { rows: [{ local_first_processing_enabled: enabled }] }
  }
}

class PrivacyHistoryDatabase {
  statements: SqlStatement[] = []

  constructor(private readonly value: boolean | string) {}

  async exec(statement: SqlStatement | string) {
    assert.notEqual(typeof statement, 'string')
    this.statements.push(statement as SqlStatement)
    return { rows: [{ local_first_history: this.value }] }
  }
}

describe('local-first processing settings', () => {
  it('defaults only an absent policy to cloud and rejects unknown values', () => {
    assert.equal(resolveLocalFirstProcessingPolicy(undefined), 'disabled')
    assert.equal(resolveLocalFirstProcessingPolicy('   '), 'disabled')
    assert.throws(
      () => resolveLocalFirstProcessingPolicy('requred'),
      /LOCAL_FIRST_PROCESSING_POLICY must be disabled, optional, or required/,
    )
    assert.equal(resolveLocalFirstProcessingPolicy(' OPTIONAL '), 'optional')
    assert.equal(resolveLocalFirstProcessingPolicy('required'), 'required')
  })

  it('applies deployment policy before the per-user preference', () => {
    assert.equal(resolveEffectiveProcessingMode({ policy: 'disabled', userEnabled: true }), 'cloud')
    assert.equal(resolveEffectiveProcessingMode({ policy: 'optional', userEnabled: false }), 'cloud')
    assert.equal(resolveEffectiveProcessingMode({ policy: 'optional', userEnabled: true }), 'local-first')
    assert.equal(resolveEffectiveProcessingMode({ policy: 'required', userEnabled: false }), 'local-first')
    assert.equal(resolveEffectiveProcessingMode({
      policy: 'optional',
      userEnabled: false,
      localFirstHistory: true,
    }), 'local-first')
    assert.equal(isLocalFirstProcessingPreferenceEditable('optional'), true)
    assert.equal(isLocalFirstProcessingPreferenceEditable('required'), false)
    assert.equal(isLocalFirstProcessingPreferenceEditable('disabled'), false)
  })

  it('allows only workstation-local audio storage for local-first jobs', () => {
    assert.equal(isLocalFirstAudioStorageBackendCompatible(undefined), true)
    assert.equal(isLocalFirstAudioStorageBackendCompatible(' filesystem '), true)
    assert.equal(isLocalFirstAudioStorageBackendCompatible('azure-blob'), false)
    assert.equal(isLocalFirstAudioStorageBackendCompatible('future-remote-store'), false)
  })

  it('checks local-first history across unique handover and source IDs', async () => {
    let db = new PrivacyHistoryDatabase('true')
    assert.equal(await handoversHaveLocalFirstProcessingHistory(
      db as unknown as Database,
      ['copy-1', 'source-1', 'copy-1', ''],
    ), true)
    assert.match(db.statements[0]!.text, /handover\.privacy_mode_floor = 'local-first'/)
    assert.match(db.statements[0]!.text, /job\.payload ->> 'privacyMode' = 'local-first'/)
    assert.deepEqual(db.statements[0]!.values, [JSON.stringify(['copy-1', 'source-1'])])

    let unused = new PrivacyHistoryDatabase(true)
    assert.equal(await handoversHaveLocalFirstProcessingHistory(
      unused as unknown as Database,
      [],
    ), false)
    assert.equal(unused.statements.length, 0)
  })

  it('normalizes legacy job payloads without changing their cloud behavior', () => {
    assert.equal(normalizePrivacyMode(undefined), 'cloud')
    assert.equal(normalizePrivacyMode('not-a-mode'), 'cloud')
    assert.equal(normalizePrivacyMode('local-first'), 'local-first')
    assert.equal(isPrivacyMode('cloud'), true)
    assert.equal(isPrivacyMode('local'), false)

    let payload: HandoverJobPayload = {
      privacyMode: 'local-first',
      privacyPolicyVersion: 1,
    }
    assert.equal(payload.privacyMode, 'local-first')
  })

  it('accepts legacy payloads but rejects malformed privacy snapshots', () => {
    assert.deepEqual(parseHandoverJobPayload({ manualTranscript: 'Legacy transcript' }), {
      manualTranscript: 'Legacy transcript',
    })
    assert.deepEqual(parseHandoverJobPayload({
      privacyMode: 'local-first',
      privacyPolicyVersion: 1,
    }), {
      privacyMode: 'local-first',
      privacyPolicyVersion: 1,
    })
    assert.throws(() => parseHandoverJobPayload({ privacyMode: 'local' }), /Invalid privacyMode/)
    assert.throws(() => parseHandoverJobPayload({ privacyPolicyVersion: 2 }), /Invalid privacyPolicyVersion/)
    assert.throws(() => parseHandoverJobPayload({ audioCleanupJobId: '' }), /Invalid audioCleanupJobId/)
  })

  it('reads and updates only the selected user preference with parameterized SQL', async () => {
    let db = new PreferenceDatabase()
    assert.equal(
      await getLocalFirstProcessingPreferenceForUser(db as unknown as Database, 'user-1'),
      false,
    )

    let updated = await updateLocalFirstProcessingPreferenceForUser(
      db as unknown as Database,
      { userId: 'user-1', enabled: true },
    )

    assert.equal(updated, true)
    assert.equal(db.users.get('user-1')?.local_first_processing_enabled, true)
    assert.equal(db.users.get('user-2')?.local_first_processing_enabled, true)
    assert.match(db.statements[0]!.text, /update users/i)
    assert.match(db.statements[0]!.text, /where id =/i)
    assert.deepEqual(db.statements[0]!.values, [true, 'user-1'])
    assert.equal(
      await updateLocalFirstProcessingPreferenceForUser(
        db as unknown as Database,
        { userId: 'missing-user', enabled: true },
      ),
      null,
    )
  })

  it('creates opt-in preferences and a constrained privacy floor in the initial schema', async () => {
    let up = await fs.readFile(
      new URL('../../db/migrations/20261026000000_initial_schema/up.sql', import.meta.url),
      'utf8',
    )

    assert.match(up, /local_first_processing_enabled boolean not null default false/i)
    assert.match(up, /privacy_mode_floor text not null default 'cloud'/i)
    assert.match(up, /privacy_mode_floor in \('cloud', 'local-first'\)/i)
  })

  it('snapshots the effective privacy mode into create and extension jobs', async () => {
    let source = await fs.readFile(
      new URL('../../app/actions/actions/controller.tsx', import.meta.url),
      'utf8',
    )
    assert.match(source, /async function privacyJobSnapshot/)
    assert.match(source, /resolveEffectiveProcessingMode\(\{ policy, userEnabled, localFirstHistory \}\)/)
    assert.match(source, /privacyPolicyVersion: currentPrivacyPolicyVersion/)
    assert.match(source, /handoversHaveLocalFirstProcessingHistory\(db, handoverIds\)/)
    assert.match(source, /handover\.source_handover_id \?\? ''/)
    assert.equal(source.match(/\.\.\.privacy,/g)?.length, 2)
  })
})
