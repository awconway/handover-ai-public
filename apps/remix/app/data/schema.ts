import {
  column as c,
  table,
  type ColumnBuilder,
  type TableRow,
} from 'remix/data-table'

// The data-table metadata intentionally exposes driver-specific JSON and
// timestamp values as unknown. `pg` decodes JSON and timestamps on reads, while
// the documented beforeWrite lifecycle gives JSON values a driver-safe wire
// representation on writes (notably, JavaScript arrays otherwise become
// Postgres array literals). Untrusted JSON is still narrowed at the repository
// boundary before it reaches application code.
const json = <value = unknown>() => c.json() as ColumnBuilder<value>
const timestamp = () => c.timestamp({ withTimezone: true }) as ColumnBuilder<Date>

function encodeJsonColumns<row extends Record<string, unknown>>(
  value: Partial<row>,
  columns: ReadonlyArray<keyof row & string>,
): Partial<row> {
  let encoded = { ...value } as Record<string, unknown>
  for (let column of columns) {
    if (Object.prototype.hasOwnProperty.call(encoded, column) && encoded[column] != null && typeof encoded[column] !== 'string') {
      encoded[column] = JSON.stringify(encoded[column])
    }
  }
  return encoded as Partial<row>
}

export type HandoverJobKind = 'create' | 'extend'
export type ResourceCleanupStatus = 'queued' | 'running' | 'deferred' | 'completed' | 'failed'
export type HandoverJobPayload = {
  manualTranscript?: string
  audioBlobKey?: string | null
  audioOriginalFilename?: string | null
  privacyMode?: 'cloud' | 'local-first'
  privacyPolicyVersion?: 1
  /** Job whose durable cleanup row owns the audio consumed by this revision. */
  audioCleanupJobId?: string
  /** Every durable cleanup proof needed by a full stored-transcript reanalysis. */
  audioCleanupDependencies?: Array<{ jobId: string; revision: number }>
  retryFrom?: 'analysis'
  retrySegmentCount?: number
  /**
   * A short-lived, exact rollback point captured immediately before an
   * extension starts transcription. Successful jobs scrub these fields;
   * failed jobs retain them until the clinician retries or discards the
   * attempt.
   */
  rollbackTranscript?: string
  rollbackTranscriptionMetadata?: Record<string, unknown> | null
  discardedAt?: string
}

export const users = table({
  name: 'users',
  columns: {
    id: c.text().primaryKey(),
    full_name: c.text().notNull(),
    occupation: c.text().notNull(),
    department: c.text().notNull(),
    local_first_processing_enabled: c.boolean().notNull().default(false),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
    last_active_at: timestamp().nullable(),
  },
})

export const sessions = table({
  name: 'sessions',
  columns: {
    id: c.text().primaryKey(),
    user_id: c.text().nullable().references('users', 'id', 'sessions_user_id_fkey').onDelete('cascade'),
    payload: json<Record<string, unknown>>().notNull().default({}),
    expires_at: timestamp().notNull(),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
    last_seen_at: timestamp().notNull(),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['payload']) } },
})

export const usabilitySessions = table({
  name: 'usability_sessions',
  columns: {
    id: c.text().primaryKey(),
    auth_session_id: c.text().nullable().references('sessions', 'id', 'usability_sessions_auth_session_id_fkey').onDelete('set null'),
    user_id: c.text().nullable().references('users', 'id', 'usability_sessions_user_id_fkey').onDelete('set null'),
    started_at: timestamp().notNull(),
    last_seen_at: timestamp().notNull(),
    ended_at: timestamp().nullable(),
    entry_path: c.text().notNull().default(''),
    referrer: c.text().nullable(),
    user_agent: c.text().notNull().default(''),
    device: json<Record<string, unknown>>().notNull(),
    initial_viewport: json<Record<string, unknown>>().notNull(),
    metadata: json<Record<string, unknown>>().notNull().default({}),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['device', 'initial_viewport', 'metadata']) } },
})

export const usabilityEvents = table({
  name: 'usability_events',
  columns: {
    id: c.text().primaryKey(),
    usability_session_id: c.text().notNull().references('usability_sessions', 'id', 'usability_events_usability_session_id_fkey').onDelete('cascade'),
    auth_session_id: c.text().nullable().references('sessions', 'id', 'usability_events_auth_session_id_fkey').onDelete('set null'),
    user_id: c.text().nullable().references('users', 'id', 'usability_events_user_id_fkey').onDelete('set null'),
    event_type: c.text().notNull(),
    event_sequence: c.integer().notNull(),
    occurred_at: timestamp().notNull(),
    received_at: timestamp().notNull(),
    route: c.text().notNull().default(''),
    path: c.text().notNull().default(''),
    page_title: c.text().notNull().default(''),
    duration_ms: c.integer().nullable(),
    viewport: json<Record<string, unknown> | null>().nullable(),
    target: json<Record<string, unknown> | null>().nullable(),
    metrics: json<Record<string, string | number | boolean | null>>().notNull().default({}),
    properties: json<Record<string, string | number | boolean | null>>().notNull().default({}),
    payload: json<Record<string, unknown>>().notNull(),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['viewport', 'target', 'metrics', 'properties', 'payload']) } },
})

export const shifts = table({
  name: 'shifts',
  columns: {
    id: c.text().primaryKey(),
    created_by_user_id: c.text().nullable(),
    title: c.text().notNull(),
    department: c.text().notNull(),
    assigned_user_ids: json<string[]>().notNull().default([]),
    notes: c.text().notNull().default(''),
    patient_order: json<string[]>().notNull().default([]),
    status: c.enum(['active', 'archived'] as const).notNull().default('active'),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['assigned_user_ids', 'patient_order']) } },
})

export const shiftSheetPatients = table({
  name: 'shift_sheet_patients',
  columns: {
    id: c.text().primaryKey(),
    shift_id: c.text().notNull().references('shifts', 'id', 'shift_sheet_patients_shift_id_fkey').onDelete('cascade'),
    patient_key: c.text().notNull(),
    display_name: c.text().notNull(),
    location: c.text().notNull(),
    fields: json<Array<Record<string, unknown>>>().notNull().default([]),
    raw_text: c.text().notNull().default(''),
    source_file_name: c.text().notNull(),
    source_file_key: c.text().nullable(),
    source_file_content_type: c.text().nullable(),
    source_file_size_bytes: c.integer().nullable(),
    extraction_method: c.text().notNull(),
    row_index: c.integer().notNull(),
    imported_by_user_id: c.text().nullable().references('users', 'id', 'shift_sheet_patients_imported_by_user_id_fkey').onDelete('set null'),
    imported_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['fields']) } },
})

export const handovers = table({
  name: 'handovers',
  columns: {
    id: c.text().primaryKey(),
    created_by_user_id: c.text().nullable(),
    source_handover_id: c.text().nullable(),
    privacy_mode_floor: c.enum(['cloud', 'local-first'] as const).notNull().default('cloud'),
    shift_id: c.text().nullable().references('shifts', 'id', 'handovers_shift_id_fkey').onDelete('set null'),
    source_shift_id: c.text().nullable().references('shifts', 'id', 'handovers_source_shift_id_fkey').onDelete('set null'),
    title: c.text().notNull(),
    direction: c.enum(['incoming', 'intra-shift', 'outgoing'] as const).nullable(),
    source_department: c.text().notNull(),
    destination_department: c.text().notNull().default(''),
    context_type: c.text().notNull(),
    linked_patient_key: c.text().nullable(),
    linked_patient_display_name: c.text().nullable(),
    linked_patient_location: c.text().nullable(),
    participants: json<Array<Record<string, unknown>>>().notNull().default([]),
    participants_edited: c.boolean().notNull().default(false),
    shared_with_user_ids: json<string[]>().notNull().default([]),
    consent_mode: c.text().notNull(),
    priority_preference: c.text().notNull(),
    notes: c.text().notNull().default(''),
    audio_blob_key: c.text().nullable(),
    audio_content_type: c.text().nullable(),
    audio_original_filename: c.text().nullable(),
    audio_size_bytes: c.integer().nullable(),
    transcript: c.text().notNull().default(''),
    transcription_metadata: json<Record<string, unknown> | null>().nullable(),
    analysis: json<Record<string, unknown> | null>().nullable(),
    processing_status: c.enum(['queued', 'transcribing', 'analysing', 'completed', 'failed'] as const).notNull().default('queued'),
    processing_started_at: timestamp().nullable(),
    error_message: c.text().nullable(),
    version: c.integer().notNull().default(1),
    current_job_id: c.text().nullable(),
    processing_lease_until: timestamp().nullable(),
    created_at: timestamp().notNull(),
    updated_at: timestamp().notNull(),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['participants', 'shared_with_user_ids', 'transcription_metadata', 'analysis']) } },
})

export const handoverAudio = table({
  name: 'handover_audio',
  columns: {
    id: c.text().primaryKey(), handover_id: c.text().notNull().references('handovers', 'id', 'handover_audio_handover_id_fkey').onDelete('cascade'),
    revision: c.integer().notNull(), purpose: c.enum(['initial', 'extension'] as const).notNull(), blob_key: c.text().notNull(),
    content_type: c.text().notNull(), original_filename: c.text().notNull(), size_bytes: c.integer().notNull(), created_at: timestamp().notNull(),
  },
})

export const handoverJobs = table({
  name: 'handover_jobs',
  columns: {
    id: c.text().primaryKey(), handover_id: c.text().notNull().references('handovers', 'id', 'handover_jobs_handover_id_fkey').onDelete('cascade'),
    revision: c.integer().notNull(), kind: c.enum(['create', 'extend'] as const).notNull(),
    status: c.enum(['queued', 'running', 'completed', 'failed'] as const).notNull().default('queued'), attempts: c.integer().notNull().default(0),
    locked_by: c.text().nullable(), locked_until: timestamp().nullable(), payload: json<HandoverJobPayload>().notNull().default({}),
    created_at: timestamp().notNull(), started_at: timestamp().nullable(), completed_at: timestamp().nullable(), failed_at: timestamp().nullable(),
    updated_at: timestamp().notNull(), error_message: c.text().nullable(),
  },
  beforeWrite({ value }) { return { value: encodeJsonColumns(value, ['payload']) } },
})

/**
 * Durable idempotency records for browser-persisted audio uploads.
 *
 * The client-generated UUID is only unique within an authenticated user's
 * namespace. Keeping the requested kind, target, and fingerprint prevents the
 * same key from being repurposed for another mutation, while the result and
 * job identifiers let a lost response be replayed without enqueuing work twice.
 */
export const handoverRecordingUploads = table({
  name: 'handover_recording_uploads',
  columns: {
    user_id: c.text().notNull().references('users', 'id', 'handover_recording_uploads_user_id_fkey').onDelete('cascade'),
    recording_upload_id: c.uuid().notNull(),
    kind: c.enum(['create', 'extend'] as const).notNull(),
    // Result identifiers intentionally outlive source-row deletion. A delayed
    // browser retry must remain consumed rather than recreating deleted data.
    target_handover_id: c.text().nullable(),
    handover_id: c.text().notNull(),
    job_id: c.text().notNull().unique(),
    request_fingerprint: c.text().notNull(),
    created_at: timestamp().notNull(),
  },
  primaryKey: ['user_id', 'recording_upload_id'],
})

export const handoverPatients = table({
  name: 'handover_patients', columns: {
    id: c.text().primaryKey(), handover_id: c.text().notNull().references('handovers', 'id', 'handover_patients_handover_id_fkey').onDelete('cascade'),
    patient_key: c.text().notNull(), display_name: c.text().notNull(), location: c.text().notNull(), acuity_score: c.integer().notNull(),
    risk_score: c.integer().notNull(), workflow_score: c.integer().notNull(), priority_reason: c.text().notNull(), created_at: timestamp().notNull(),
  },
})

export const handoverTaskPriorities = ['low', 'routine', 'medium', 'high', 'urgent'] as const
export const handoverTaskStatuses = ['open', 'in_progress', 'done'] as const
export const handoverTaskSources = ['transcript', 'uncertainty', 'history', 'manual'] as const

export type HandoverTaskStatus = (typeof handoverTaskStatuses)[number]

export const handoverTasks = table({
  name: 'handover_tasks', columns: {
    id: c.text().primaryKey(), handover_id: c.text().notNull().references('handovers', 'id', 'handover_tasks_handover_id_fkey').onDelete('cascade'),
    patient_key: c.text().notNull(), title: c.text().notNull(),
    due_label: c.text().notNull(), due_at: timestamp().nullable(),
    priority: c.enum(handoverTaskPriorities).notNull(),
    status: c.enum(handoverTaskStatuses).notNull(),
    reminder_enabled: c.boolean().notNull().default(true), carried_forward: c.boolean().notNull().default(false),
    source: c.enum(handoverTaskSources).notNull(),
    related_uncertainty_id: c.text().nullable(), created_at: timestamp().notNull(), updated_at: timestamp().notNull(),
  },
})

export const handoverBookmarks = table({
  name: 'handover_bookmarks', columns: {
    id: c.text().primaryKey(), handover_id: c.text().notNull().references('handovers', 'id', 'handover_bookmarks_handover_id_fkey').onDelete('cascade'),
    patient_key: c.text().notNull(), label: c.text().notNull(), revisit_reason: c.text().notNull(), segment_id: c.text().nullable(), likely_query_context: c.text().notNull().default(''),
    status: c.text().notNull(), created_at: timestamp().notNull(), updated_at: timestamp().notNull(),
  },
})

export const handoverAssignments = table({
  name: 'handover_assignments', columns: {
    id: c.text().primaryKey(), handover_id: c.text().notNull().references('handovers', 'id', 'handover_assignments_handover_id_fkey').onDelete('cascade'),
    assigned_by_user_id: c.text().notNull().references('users', 'id', 'handover_assignments_assigned_by_user_id_fkey').onDelete('cascade'),
    assigned_to_user_id: c.text().notNull().references('users', 'id', 'handover_assignments_assigned_to_user_id_fkey').onDelete('cascade'),
    status: c.enum(['pending', 'individual', 'placed'] as const).notNull().default('pending'),
    target_shift_id: c.text().nullable().references('shifts', 'id', 'handover_assignments_target_shift_id_fkey').onDelete('set null'),
    assigned_at: timestamp().notNull(), placed_at: timestamp().nullable(), updated_at: timestamp().notNull(),
  },
})

export type UserRow = TableRow<typeof users>
export type ShiftRow = TableRow<typeof shifts>
export type ShiftSheetPatientRow = TableRow<typeof shiftSheetPatients>
export type HandoverRow = TableRow<typeof handovers>
export type HandoverJobRow = TableRow<typeof handoverJobs>
export type HandoverRecordingUploadRow = TableRow<typeof handoverRecordingUploads>
export type HandoverAudioRow = TableRow<typeof handoverAudio>
export type HandoverTaskRow = TableRow<typeof handoverTasks>
export type HandoverPatientRow = TableRow<typeof handoverPatients>
export type HandoverAssignmentRow = TableRow<typeof handoverAssignments>
export type UsabilitySessionRow = TableRow<typeof usabilitySessions>
export type UsabilityEventRow = TableRow<typeof usabilityEvents>
