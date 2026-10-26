-- data-table/transaction: required
-- Complete schema for a fresh Handover AI database.

create table users (
  id text primary key,
  full_name text not null,
  occupation text not null,
  department text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_active_at timestamptz,
  local_first_processing_enabled boolean not null default false
);

create table sessions (
  id text primary key,
  user_id text references users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table shifts (
  id text primary key,
  created_by_user_id text,
  title text not null,
  department text not null,
  assigned_user_ids jsonb not null default '[]'::jsonb,
  notes text not null default '',
  patient_order jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table shift_sheet_patients (
  id text primary key,
  shift_id text not null references shifts(id) on delete cascade,
  patient_key text not null,
  display_name text not null,
  location text not null,
  fields jsonb not null default '[]'::jsonb,
  raw_text text not null default '',
  source_file_name text not null,
  source_file_key text,
  source_file_content_type text,
  source_file_size_bytes integer,
  extraction_method text not null,
  row_index integer not null,
  imported_by_user_id text references users(id) on delete set null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shift_id, patient_key)
);

create table handovers (
  id text primary key,
  created_by_user_id text,
  source_handover_id text,
  shift_id text references shifts(id) on delete set null,
  source_shift_id text references shifts(id) on delete set null,
  title text not null,
  direction text check (direction is null or direction in ('incoming', 'intra-shift', 'outgoing')),
  source_department text not null,
  destination_department text not null default '',
  context_type text not null,
  linked_patient_key text,
  linked_patient_display_name text,
  linked_patient_location text,
  participants jsonb not null default '[]'::jsonb,
  participants_edited boolean not null default false,
  shared_with_user_ids jsonb not null default '[]'::jsonb,
  consent_mode text not null,
  priority_preference text not null,
  notes text not null default '',
  audio_blob_key text,
  audio_content_type text,
  audio_original_filename text,
  audio_size_bytes integer,
  transcript text not null default '',
  transcription_metadata jsonb,
  analysis jsonb,
  processing_status text not null default 'queued' check (processing_status in ('queued', 'transcribing', 'analysing', 'completed', 'failed')),
  processing_started_at timestamptz,
  error_message text,
  version integer not null default 1 check (version > 0),
  current_job_id text,
  processing_lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  privacy_mode_floor text not null default 'cloud'
    constraint handovers_privacy_mode_floor_check
    check (privacy_mode_floor in ('cloud', 'local-first'))
);

create table handover_audio (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  revision integer not null check (revision > 0),
  purpose text not null check (purpose in ('initial', 'extension')),
  blob_key text not null,
  content_type text not null,
  original_filename text not null,
  size_bytes integer not null check (size_bytes >= 0),
  created_at timestamptz not null default now()
);

create table handover_jobs (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  revision integer not null check (revision > 0),
  kind text not null check (kind in ('create', 'extend')),
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  locked_by text,
  locked_until timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  error_message text
);

-- A browser persists each completed recording under a client-generated UUID
-- and retries with that same UUID until it receives the POST redirect. The
-- authenticated user forms part of the key, and the recorded request scope
-- prevents a UUID from being reused for a different mutation or handover.
create table handover_recording_uploads (
  user_id text not null references users(id) on delete cascade,
  recording_upload_id uuid not null,
  kind text not null check (kind in ('create', 'extend')),
  -- Result identifiers intentionally remain as audit/tombstone values after
  -- source deletion so a delayed upload cannot recreate deleted clinical data.
  target_handover_id text,
  handover_id text not null,
  job_id text not null unique,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, recording_upload_id),
  check (
    (kind = 'create' and target_handover_id is null)
    or (kind = 'extend' and target_handover_id = handover_id)
  )
);

-- Durable resource cleanup outbox. Exact handover/job/revision identifiers are
-- intentionally not foreign keys: cleanup evidence and retries must survive a
-- source-row deletion. `kind` + `resource_id` leaves room for provider-owned
-- artifacts while the first implementation handles local audio objects.
create table resource_cleanup_outbox (
  id text primary key,
  kind text not null,
  resource_id text not null,
  blob_key text,
  handover_id text not null,
  job_id text not null,
  revision integer not null check (revision > 0),
  status text not null default 'queued' check (status in ('queued', 'running', 'deferred', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_retry_at timestamptz not null default now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  outcome text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  deletion_required boolean not null default false,
  check (kind <> 'local-audio-object' or (blob_key is not null and blob_key = resource_id)),
  unique (kind, resource_id, handover_id, job_id, revision)
);

create index resource_cleanup_outbox_claim_idx
  on resource_cleanup_outbox(kind, status, next_retry_at, created_at);
create index resource_cleanup_outbox_blob_key_idx
  on resource_cleanup_outbox(blob_key) where blob_key is not null;
create index resource_cleanup_outbox_locked_until_idx
  on resource_cleanup_outbox(locked_until) where status = 'running';
create index resource_cleanup_outbox_required_claim_idx
  on resource_cleanup_outbox(status, next_retry_at, created_at)
  where deletion_required = true;

create table transcription_runs (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  job_id text references handover_jobs(id) on delete set null,
  revision integer not null,
  provider text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  metadata jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  error_message text
);

create table analysis_runs (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  job_id text references handover_jobs(id) on delete set null,
  revision integer not null,
  provider text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  metadata jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  failed_at timestamptz,
  error_message text
);

create table handover_patients (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  patient_key text not null,
  display_name text not null,
  location text not null,
  acuity_score integer not null,
  risk_score integer not null,
  workflow_score integer not null,
  priority_reason text not null,
  created_at timestamptz not null default now()
);

create table handover_tasks (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  patient_key text not null,
  title text not null,
  due_label text not null,
  due_at timestamptz,
  priority text not null check (priority in ('low', 'routine', 'medium', 'high', 'urgent')),
  status text not null check (status in ('open', 'in_progress', 'done')),
  reminder_enabled boolean not null default true,
  carried_forward boolean not null default false,
  source text not null check (source in ('transcript', 'uncertainty', 'history', 'manual')),
  related_uncertainty_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table handover_bookmarks (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  patient_key text not null,
  label text not null,
  revisit_reason text not null,
  segment_id text,
  likely_query_context text not null default '',
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table handover_assignments (
  id text primary key,
  handover_id text not null references handovers(id) on delete cascade,
  assigned_by_user_id text not null references users(id) on delete cascade,
  assigned_to_user_id text not null references users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'individual', 'placed')),
  target_shift_id text references shifts(id) on delete set null,
  assigned_at timestamptz not null default now(),
  placed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table usability_sessions (
  id text primary key,
  auth_session_id text references sessions(id) on delete set null,
  user_id text references users(id) on delete set null,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  ended_at timestamptz,
  entry_path text not null default '',
  referrer text,
  user_agent text not null default '',
  device jsonb not null,
  initial_viewport jsonb not null,
  metadata jsonb not null default '{}'::jsonb
);

create table usability_events (
  id text primary key,
  usability_session_id text not null references usability_sessions(id) on delete cascade,
  auth_session_id text references sessions(id) on delete set null,
  user_id text references users(id) on delete set null,
  event_type text not null,
  event_sequence integer not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  route text not null default '',
  path text not null default '',
  page_title text not null default '',
  duration_ms integer,
  viewport jsonb,
  target jsonb,
  metrics jsonb not null default '{}'::jsonb,
  properties jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  unique (usability_session_id, event_sequence)
);

create index sessions_user_id_idx on sessions(user_id);
create index sessions_expires_at_idx on sessions(expires_at);
create index shifts_created_by_user_id_idx on shifts(created_by_user_id);
create index shift_sheet_patients_shift_id_idx on shift_sheet_patients(shift_id);
create index handovers_created_by_user_id_idx on handovers(created_by_user_id);
create index handovers_source_handover_id_idx on handovers(source_handover_id);
create index handovers_shift_id_idx on handovers(shift_id);
create index handovers_source_shift_id_idx on handovers(source_shift_id);
create index handovers_processing_status_idx on handovers(processing_status);
create index handovers_current_job_id_idx on handovers(current_job_id);
create index handover_audio_handover_id_idx on handover_audio(handover_id);
create index handover_audio_blob_key_idx on handover_audio(blob_key);
create index handover_jobs_handover_id_idx on handover_jobs(handover_id);
create index handover_jobs_status_created_at_idx on handover_jobs(status, created_at);
create index handover_jobs_locked_until_idx on handover_jobs(locked_until);
create index handover_recording_uploads_handover_id_idx on handover_recording_uploads(handover_id);
create index handover_recording_uploads_target_handover_id_idx on handover_recording_uploads(target_handover_id) where target_handover_id is not null;
create index transcription_runs_handover_id_idx on transcription_runs(handover_id);
create index transcription_runs_job_id_idx on transcription_runs(job_id);
create index analysis_runs_handover_id_idx on analysis_runs(handover_id);
create index analysis_runs_job_id_idx on analysis_runs(job_id);
create index handover_patients_handover_id_idx on handover_patients(handover_id);
create index handover_tasks_handover_id_idx on handover_tasks(handover_id);
create unique index handover_tasks_related_uncertainty_unique_idx
  on handover_tasks(handover_id, patient_key, related_uncertainty_id)
  where related_uncertainty_id is not null;
create index handover_bookmarks_handover_id_idx on handover_bookmarks(handover_id);
create index handover_assignments_handover_id_idx on handover_assignments(handover_id);
create index handover_assignments_assigned_to_user_id_idx on handover_assignments(assigned_to_user_id);
create index usability_sessions_user_id_idx on usability_sessions(user_id);
create index usability_sessions_auth_session_id_idx on usability_sessions(auth_session_id);
create index usability_sessions_started_at_idx on usability_sessions(started_at);
create index usability_events_user_id_idx on usability_events(user_id);
create index usability_events_event_type_idx on usability_events(event_type);
create index usability_events_occurred_at_idx on usability_events(occurred_at);
create index usability_events_received_at_idx on usability_events(received_at);
create index usability_events_route_idx on usability_events(route);

-- One immutable, workstation-local record for the exact text supplied to one
-- OpenMed de-identification operation. Both the identifiable source and the
-- de-identified cloud-bound copy are retained as clinical audit data.
create table local_privacy_audits (
  id text primary key,
  context_type text not null check (context_type in (
    'handover-dspy',
    'handover-openai',
    'handover-sheet-reconciliation',
    'shift-prioritisation'
  )),
  handover_id text references handovers(id) on delete cascade,
  shift_id text references shifts(id) on delete cascade,
  job_id text references handover_jobs(id) on delete set null,
  analysis_run_id text references analysis_runs(id) on delete set null,
  revision integer check (revision is null or revision > 0),
  initiated_by_user_id text references users(id) on delete set null,
  source_text text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_utf8_bytes bigint not null check (source_utf8_bytes >= 0),
  deidentified_text text not null,
  deidentified_sha256 text not null check (deidentified_sha256 ~ '^[0-9a-f]{64}$'),
  deidentified_utf8_bytes bigint not null check (deidentified_utf8_bytes >= 0),
  openmed_model_id text not null,
  openmed_model_revision text,
  openmed_sdk_version text not null,
  openmed_backend text,
  deidentification_method text not null,
  deidentification_policy text not null,
  offline boolean not null,
  smart_merging boolean not null,
  safety_sweep boolean not null,
  replacement_count integer not null check (replacement_count >= 0),
  created_at timestamptz not null default now(),
  -- Provenance is retained after deletion of the source handover and audit.
  copied_from_audit_id text,
  -- Retain the original model output alongside the effective cloud-bound text.
  openmed_deidentified_text text not null,
  openmed_deidentified_sha256 text not null,
  openmed_deidentified_utf8_bytes bigint not null,
  applied_exception_count integer not null default 0,
  check (
    (handover_id is not null and shift_id is null)
    or (handover_id is null and shift_id is not null)
  ),
  check (
    (context_type = 'shift-prioritisation' and shift_id is not null)
    or (context_type <> 'shift-prioritisation' and handover_id is not null)
  ),
  constraint local_privacy_audits_copy_provenance_check check (
    copied_from_audit_id is null
    or (
      handover_id is not null
      and shift_id is null
      and job_id is null
      and analysis_run_id is null
      and btrim(copied_from_audit_id) <> ''
    )
  ),
  constraint local_privacy_audits_openmed_sha256_check check (
    openmed_deidentified_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint local_privacy_audits_openmed_utf8_bytes_check check (
    openmed_deidentified_utf8_bytes >= 0
  ),
  constraint local_privacy_audits_applied_exception_count_check check (
    applied_exception_count >= 0
    and applied_exception_count <= replacement_count
  )
);

-- Normalized OpenMed findings keep Unicode-codepoint offsets and the exact
-- tagged/replacement surfaces queryable without indexing clinical text.
create table local_privacy_findings (
  audit_id text not null references local_privacy_audits(id) on delete cascade,
  ordinal integer not null check (ordinal >= 0),
  label text not null,
  entity_type text not null,
  canonical_label text,
  original_text text not null,
  replacement_text text not null,
  start_codepoint integer not null check (start_codepoint >= 0),
  end_codepoint integer not null check (end_codepoint > start_codepoint),
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  threshold double precision check (threshold is null or (threshold >= 0 and threshold <= 1)),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  action text,
  primary key (audit_id, ordinal)
);

-- A prepared row is the durable gate for one planned network request. The
-- transition to dispatching commits before the external operation starts.
create table local_privacy_cloud_requests (
  id text primary key,
  audit_id text not null references local_privacy_audits(id) on delete cascade,
  target_kind text not null check (target_kind in ('dspy-predict', 'openai-responses')),
  target_name text not null,
  provider text not null,
  model text not null,
  status text not null default 'prepared' check (status in ('prepared', 'dispatching', 'completed', 'failed')),
  error_type text check (
    error_type is null
    or (char_length(error_type) between 1 and 120 and error_type ~ '^[A-Za-z0-9_.:-]+$')
  ),
  prepared_at timestamptz not null default now(),
  dispatch_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  -- Terminal request evidence outlives the authoritative source request.
  copied_from_request_id text,
  unique (audit_id, target_kind, target_name),
  check (
    (status = 'prepared' and dispatch_started_at is null and completed_at is null and failed_at is null and error_type is null)
    or (status = 'dispatching' and dispatch_started_at is not null and completed_at is null and failed_at is null and error_type is null)
    or (status = 'completed' and dispatch_started_at is not null and completed_at is not null and failed_at is null and error_type is null)
    or (status = 'failed' and dispatch_started_at is not null and completed_at is null and failed_at is not null and error_type is not null)
  ),
  constraint local_privacy_cloud_requests_copy_check check (
    copied_from_request_id is null
    or (
      btrim(copied_from_request_id) <> ''
      and status in ('completed', 'failed')
    )
  )
);

-- The owner/time indexes also cover the handover and shift foreign keys.
create index local_privacy_audits_handover_created_idx
  on local_privacy_audits(handover_id, created_at desc, id)
  where handover_id is not null;
create index local_privacy_audits_shift_created_idx
  on local_privacy_audits(shift_id, created_at desc, id)
  where shift_id is not null;
create index local_privacy_audits_job_id_idx
  on local_privacy_audits(job_id) where job_id is not null;
create index local_privacy_audits_analysis_run_id_idx
  on local_privacy_audits(analysis_run_id) where analysis_run_id is not null;
create index local_privacy_audits_initiated_by_user_id_idx
  on local_privacy_audits(initiated_by_user_id) where initiated_by_user_id is not null;
create unique index local_privacy_audits_recipient_copy_idx
  on local_privacy_audits(handover_id, copied_from_audit_id)
  where copied_from_audit_id is not null;

-- The findings primary key and the cloud-request uniqueness constraint cover
-- their audit foreign keys. Only non-terminal dispatch work needs another index.
create index local_privacy_cloud_requests_pending_idx
  on local_privacy_cloud_requests(status, prepared_at, id)
  where status in ('prepared', 'dispatching');
create unique index local_privacy_cloud_requests_recipient_copy_idx
  on local_privacy_cloud_requests(audit_id, copied_from_request_id)
  where copied_from_request_id is not null;

-- One append-only clinician decision applies to exact normalized text plus an
-- exact OpenMed canonical label within one handover family. The family key is
-- deliberately not a foreign key: recipient copies can retain the exception
-- after the authoritative source handover is deleted.
create table local_privacy_exceptions (
  id text primary key,
  handover_family_id text not null check (btrim(handover_family_id) <> ''),
  normalized_text text not null check (
    btrim(normalized_text) <> '' and char_length(normalized_text) <= 512
  ),
  canonical_label text not null check (
    btrim(canonical_label) <> '' and char_length(canonical_label) <= 200
  ),
  source_handover_id text not null check (btrim(source_handover_id) <> ''),
  source_audit_id text,
  source_finding_ordinal integer,
  source_original_text text not null,
  created_by_user_id text references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (handover_family_id, normalized_text, canonical_label),
  check (
    (source_audit_id is null and source_finding_ordinal is null)
    or (source_audit_id is not null and source_finding_ordinal >= 0)
  ),
  foreign key (source_audit_id, source_finding_ordinal)
    references local_privacy_findings(audit_id, ordinal) on delete set null
);

create index local_privacy_exceptions_actor_created_idx
  on local_privacy_exceptions(created_by_user_id, created_at desc, id)
  where created_by_user_id is not null;
create index local_privacy_exceptions_source_finding_idx
  on local_privacy_exceptions(source_audit_id, source_finding_ordinal)
  where source_audit_id is not null;

-- Immutable run provenance identifies every exception actually applied to an
-- OpenMed finding in the exact cloud-bound audit text.
create table local_privacy_audit_applied_exceptions (
  audit_id text not null,
  finding_ordinal integer not null,
  exception_id text not null references local_privacy_exceptions(id),
  applied_at timestamptz not null default now(),
  primary key (audit_id, finding_ordinal),
  foreign key (audit_id, finding_ordinal)
    references local_privacy_findings(audit_id, ordinal) on delete cascade
);

create index local_privacy_audit_applied_exceptions_exception_idx
  on local_privacy_audit_applied_exceptions(exception_id, audit_id, finding_ordinal);

-- Analysis-only reruns must prove deletion for the exact recordings that
-- produced every transcript component sent through OpenMed. These immutable
-- links survive source handover/job deletion and are copied to recipients.
create table local_privacy_audit_audio_cleanup_dependencies (
  audit_id text not null references local_privacy_audits(id) on delete cascade,
  cleanup_job_id text not null check (btrim(cleanup_job_id) <> ''),
  cleanup_revision integer not null check (cleanup_revision > 0),
  primary key (audit_id, cleanup_job_id, cleanup_revision)
);

create index local_privacy_audit_audio_cleanup_job_idx
  on local_privacy_audit_audio_cleanup_dependencies(cleanup_job_id, cleanup_revision, audit_id);
