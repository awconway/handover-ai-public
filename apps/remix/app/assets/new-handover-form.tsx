import { clientEntry, css, on, ref, type Handle, type SerializableProps } from 'remix/component'
import { onSelectChange } from '@remix-run/ui/select'

import { Option, Select } from './form-select.tsx'

import {
  RECORDING_STATUS_EVENT,
  requestPersistentRecording,
  type RecorderState,
  type RecordingStatusDetail,
} from './recording-events.ts'

type HandoverContext =
  'shift-handover' | 'department-transfer' | 'short-transfer' | 'interprofessional-briefing' | 'community-transfer'
type HandoverDirection = 'incoming' | 'intra-shift' | 'outgoing'

export interface NewHandoverFormProps extends SerializableProps {
  action: string
  uploadAction?: string
  csrfToken?: string
  mode?: 'shift' | 'individual'
  shifts?: Array<{ id: string; title: string; department?: string }>
  defaultDepartment?: string
  defaultShiftId?: string
  defaultDirection?: HandoverDirection
  defaultParticipants?: string[]
  linkedPatient?: {
    key: string
    displayName: string
    location?: string
    direction?: HandoverDirection
  }
  error?: string
  formId?: string
  presentation?: 'inline' | 'embedded' | 'dialog'
}

const SHIFT_CONTEXT_OPTION: { value: HandoverContext; label: string } = {
  value: 'shift-handover',
  label: 'Shift to shift handover',
}
const CONTEXT_OPTIONS: Array<{ value: HandoverContext; label: string }> = [
  { value: 'department-transfer', label: 'Department transfer' },
  { value: 'short-transfer', label: 'Short transfer of care' },
  { value: 'interprofessional-briefing', label: 'Inter-professional briefing' },
  { value: 'community-transfer', label: 'Inpatient to community transfer' },
]

const DIRECTION_OPTIONS: Array<{ value: HandoverDirection; label: string }> = [
  { value: 'incoming', label: 'Receiving' },
  { value: 'intra-shift', label: 'Intra-shift' },
  { value: 'outgoing', label: 'Delivering' },
]

/**
 * The native Remix composer used by the individual, shift and direct-create
 * surfaces. Only this small interaction island hydrates; submission remains a
 * normal multipart form handled by the Remix action.
 */
export const NewHandoverForm = clientEntry(
  import.meta.url + '#NewHandoverForm',
  function NewHandoverForm(handle: Handle<NewHandoverFormProps>) {
    let mode = handle.props.mode ?? 'individual'
    let direction: HandoverDirection =
      handle.props.defaultDirection ?? handle.props.linkedPatient?.direction ?? 'incoming'
    let contextType: HandoverContext =
      mode === 'shift'
        ? direction === 'intra-shift' && handle.props.linkedPatient
          ? 'interprofessional-briefing'
          : 'shift-handover'
        : 'short-transfer'
    let selectedShiftId =
      mode === 'individual' ? '' : (handle.props.defaultShiftId ?? handle.props.shifts?.[0]?.id ?? '')
    let sourceDepartment = handle.props.defaultDepartment ?? ''
    let destinationDepartment = ''
    let consentAgreed = false
    let showManualTranscript = false
    let recorderState: RecorderState = 'idle'
    let recorderMessage = ''

    return () => {
      let formId = handle.props.formId ?? 'new-handover-form'
      let isSameDepartmentHandover = contextType === 'shift-handover'
      let contextLabel =
        [SHIFT_CONTEXT_OPTION, ...CONTEXT_OPTIONS].find((option) => option.value === contextType)?.label ?? 'Handover'
      let directionLabel = DIRECTION_OPTIONS.find((option) => option.value === direction)?.label ?? 'Receiving'
      let selectedShift = handle.props.shifts?.find((shift) => shift.id === selectedShiftId)
      let linkedPatient = handle.props.linkedPatient
      let linkedContextOptions =
        direction === 'intra-shift' ? CONTEXT_OPTIONS : [SHIFT_CONTEXT_OPTION, ...CONTEXT_OPTIONS]
      let routeSource = sourceDepartment
      let routeDestination = destinationDepartment
      if (isSameDepartmentHandover && direction === 'incoming' && destinationDepartment) {
        routeSource = destinationDepartment
        routeDestination = sourceDepartment
      } else if (isSameDepartmentHandover) {
        routeDestination = ''
      }
      let routeLabel = routeDestination ? `${routeSource} -> ${routeDestination}` : routeSource
      let title =
        handle.props.linkedPatient?.displayName && (direction === 'outgoing' || direction === 'intra-shift')
          ? `${directionLabel} handover · ${handle.props.linkedPatient.displayName}`
          : isSameDepartmentHandover
            ? `Shift handover${routeLabel ? ` · ${routeLabel}` : ''}`
            : `${contextLabel}${routeLabel ? ` · ${routeLabel}` : ''}`

      let form = (
        <form
          id={formId}
          method="post"
          encType="multipart/form-data"
          action={handle.props.action}
          data-testid="new-handover-form"
          data-workflow="create-handover"
          data-study-task="task-create-handover"
          mix={[
            css({
              display: 'grid',
              ...(handle.props.presentation === 'dialog' ? { gap: '1.25rem' } : { gap: '1rem' }),
            }),
            ref((_form, signal) => {
              window.addEventListener(
                RECORDING_STATUS_EVENT,
                (event) => {
                  let detail = (event as CustomEvent<RecordingStatusDetail>).detail
                  if (detail.formId !== formId) return
                  recorderState = detail.status
                  recorderMessage = detail.message ?? ''
                  handle.update()
                },
                { signal },
              )
            }),
          ]}
        >
          {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
          <input type="hidden" name="title" value={title.slice(0, 120)} />
          <input type="hidden" name="sourceShiftId" value="" />
          <input type="hidden" name="linkedPatientKey" value={handle.props.linkedPatient?.key ?? ''} />
          <input type="hidden" name="linkedPatientDisplayName" value={handle.props.linkedPatient?.displayName ?? ''} />
          <input type="hidden" name="linkedPatientLocation" value={handle.props.linkedPatient?.location ?? ''} />
          <input type="hidden" name="participants" value={JSON.stringify(handle.props.defaultParticipants ?? [])} />
          <input type="hidden" name="sharedWithUserIds" value="[]" />
          <input type="hidden" name="priorityPreference" value="balanced" />
          <input type="hidden" name="notes" value="" />

          {handle.props.error ? (
            <div
              role="alert"
              mix={css({
                borderRadius: '16px',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: 'var(--color-rose-200)',
                backgroundColor: 'var(--color-rose-50)',
                paddingLeft: '0.75rem',
                paddingRight: '0.75rem',
                paddingTop: '0.5rem',
                paddingBottom: '0.5rem',
                fontSize: '.875rem',
                lineHeight: '1.5rem',
                color: 'var(--color-rose-800)',
              })}
            >
              <strong mix={css({ display: 'block', fontWeight: 500 })}>Handover could not be created</strong>
              {handle.props.error}
            </div>
          ) : null}

          <div
            mix={css({
              display: 'grid',
              gap: '1rem',
              ...(handle.props.presentation === 'inline'
                ? {
                    '@media (min-width: 80rem)': {
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      alignItems: 'flex-start',
                    },
                  }
                : {}),
            })}
          >
            {mode === 'shift' && !linkedPatient ? (
              <div mix={css(fieldStyles)}>
                <label mix={css(fieldLabelStyles)} htmlFor={`${formId}-direction`}>
                  Context
                </label>
                <Select
                  id={`${formId}-direction`}
                  name="direction"
                  defaultLabel={directionLabel}
                  defaultValue={direction}
                  data-analytics-id="handover-direction-select"
                  mix={[
                    css(selectStyles),
                    onSelectChange((event) => {
                      direction = event.value as HandoverDirection
                      handle.update()
                    }),
                  ]}
                >
                  {DIRECTION_OPTIONS.map((option) => (
                    <Option key={option.value} value={option.value} label={option.label}>
                      {option.label}
                    </Option>
                  ))}
                </Select>
              </div>
            ) : mode === 'individual' || (linkedPatient && direction !== 'outgoing') ? (
              <div mix={css(fieldStyles)}>
                <label mix={css(fieldLabelStyles)} htmlFor={`${formId}-context-type`}>
                  Context
                </label>
                <Select
                  id={`${formId}-context-type`}
                  name="contextType"
                  defaultLabel={contextLabel}
                  defaultValue={contextType}
                  data-analytics-id="handover-context-type-select"
                  mix={[
                    css(selectStyles),
                    onSelectChange((event) => {
                      contextType = event.value as HandoverContext
                      handle.update()
                    }),
                  ]}
                >
                  {(linkedPatient ? linkedContextOptions : CONTEXT_OPTIONS).map((option) => (
                    <Option key={option.value} value={option.value} label={option.label}>
                      {option.label}
                    </Option>
                  ))}
                </Select>
                <input type="hidden" name="direction" value={direction} />
              </div>
            ) : (
              <>
                <input type="hidden" name="direction" value={direction} />
                <input type="hidden" name="contextType" value="shift-handover" />
              </>
            )}

            {mode === 'shift' && !linkedPatient ? (
              <input type="hidden" name="contextType" value="shift-handover" />
            ) : null}

            {mode === 'shift' && linkedPatient && direction === 'outgoing' && selectedShift ? (
              <div mix={css(fieldStyles)}>
                <span mix={css(fieldLabelStyles)}>Source shift</span>
                <div
                  mix={css({
                    display: 'flex',
                    minHeight: '2.5rem',
                    alignItems: 'center',
                    borderRadius: 'var(--radius)',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: 'var(--color-slate-200)',
                    backgroundColor: 'var(--color-slate-50)',
                    paddingLeft: '0.75rem',
                    paddingRight: '0.75rem',
                    fontSize: '.875rem',
                    lineHeight: 1.4285714285714286,
                    color: 'var(--color-slate-700)',
                  })}
                >
                  {selectedShift.title} · {selectedShift.department ?? ''}
                </div>
              </div>
            ) : null}

            {mode === 'shift' && !handle.props.defaultShiftId && handle.props.shifts?.length ? (
              <div mix={css(fieldStyles)}>
                <label mix={css(fieldLabelStyles)} htmlFor={`${formId}-shift`}>
                  Shift
                </label>
                <Select
                  id={`${formId}-shift`}
                  name="shiftId"
                  defaultLabel={
                    selectedShift ? `${selectedShift.title} · ${selectedShift.department ?? ''}` : 'Select a shift'
                  }
                  defaultValue={selectedShiftId}
                  data-analytics-id="handover-shift-select"
                  mix={[
                    css(selectStyles),
                    onSelectChange((event) => {
                      selectedShiftId = event.value ?? ''
                      let nextShift = handle.props.shifts?.find((shift) => shift.id === selectedShiftId)
                      if (nextShift?.department) sourceDepartment = nextShift.department
                      handle.update()
                    }),
                  ]}
                >
                  {handle.props.shifts.map((shift) => (
                    <Option key={shift.id} value={shift.id} label={`${shift.title} · ${shift.department ?? ''}`}>
                      {shift.title} · {shift.department ?? ''}
                    </Option>
                  ))}
                </Select>
                <p mix={css(fieldDescriptionStyles)}>
                  Start a shift first, then attach each shift-to-shift handover to it.
                </p>
              </div>
            ) : (
              <input type="hidden" name="shiftId" value={selectedShiftId} />
            )}

            <div
              role="group"
              mix={css({
                display: 'flex',
                width: '100%',
                gap: '0.5rem',
                flexDirection: 'column',
                ...(handle.props.presentation === 'embedded'
                  ? {}
                  : { '@media (min-width: 40rem)': { flexDirection: 'row', alignItems: 'flex-start' } }),
              })}
            >
              <div mix={css({ ...fieldStyles, flex: '1' })}>
                <label mix={css(fieldLabelStyles)} htmlFor={`${formId}-source-department`}>
                  {isSameDepartmentHandover ? 'Ward or unit' : 'Source department'}
                </label>
                <input
                  id={`${formId}-source-department`}
                  name="sourceDepartment"
                  value={sourceDepartment}
                  required
                  data-analytics-id="handover-source-unit-input"
                  mix={[
                    css(inputStyles),
                    on('input', (event) => {
                      sourceDepartment = (event.currentTarget as HTMLInputElement).value
                      handle.update()
                    }),
                  ]}
                />
              </div>

              {isSameDepartmentHandover && direction !== 'incoming' ? (
                <div mix={css({ ...fieldStyles, flex: '1' })}>
                  <span mix={css(fieldLabelStyles)}>Destination</span>
                  <div
                    mix={css({
                      display: 'flex',
                      height: '2rem',
                      alignItems: 'center',
                      borderRadius: 'var(--radius)',
                      borderWidth: '1px',
                      borderStyle: 'solid',
                      borderColor: 'var(--color-slate-200)',
                      backgroundColor: 'var(--color-slate-50)',
                      paddingLeft: '0.75rem',
                      paddingRight: '0.75rem',
                      fontSize: '.875rem',
                      lineHeight: 1.4285714285714286,
                      color: 'var(--color-slate-500)',
                    })}
                  >
                    Same ward or unit as source
                  </div>
                  <input type="hidden" name="destinationDepartment" value="" />
                </div>
              ) : (
                <div mix={css({ ...fieldStyles, flex: '1' })}>
                  <label mix={css(fieldLabelStyles)} htmlFor={`${formId}-destination-department`}>
                    {isSameDepartmentHandover ? 'Departing department' : 'Destination department'}
                  </label>
                  <input
                    id={`${formId}-destination-department`}
                    name="destinationDepartment"
                    value={destinationDepartment}
                    data-analytics-id={
                      isSameDepartmentHandover ? 'handover-departing-unit-input' : 'handover-destination-unit-input'
                    }
                    mix={[
                      css(inputStyles),
                      on('input', (event) => {
                        destinationDepartment = (event.currentTarget as HTMLInputElement).value
                        handle.update()
                      }),
                    ]}
                  />
                  {isSameDepartmentHandover ? (
                    <p mix={css(fieldDescriptionStyles)}>
                      Leave blank for the same ward, or enter the area the patient is coming from.
                    </p>
                  ) : null}
                </div>
              )}
            </div>

            <fieldset
              mix={css({
                display: 'flex',
                flexDirection: 'column',
                ...(handle.props.presentation === 'dialog' ? { gap: '0.625rem' } : { gap: '1rem' }),
              })}
            >
              <legend
                mix={css({
                  marginBottom: '0.375rem',
                  fontWeight: 500,
                  fontSize: '.875rem',
                  lineHeight: 1.4285714285714286,
                })}
              >
                Consent
              </legend>
              <label
                htmlFor={`${formId}-consent-mode-agreed`}
                mix={css({
                  display: 'flex',
                  height: 'auto',
                  minHeight: '2.5rem',
                  width: '100%',
                  cursor: 'pointer',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: '0.75rem',
                  borderRadius: 'var(--radius)',
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  paddingLeft: '0.75rem',
                  paddingRight: '0.75rem',
                  paddingTop: '0.5rem',
                  paddingBottom: '0.5rem',
                  textAlign: 'left',
                  ...(consentAgreed
                    ? {
                        borderColor: 'color-mix(in oklab, var(--primary) 30%, transparent)',
                        backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                        color: 'var(--color-slate-800)',
                      }
                    : {
                        borderColor: 'var(--color-slate-200)',
                        backgroundColor: 'color-mix(in oklab, #fff 82%, transparent)',
                      }),
                })}
              >
                <input
                  id={`${formId}-consent-mode-agreed`}
                  type="checkbox"
                  name="consentMode"
                  value="agreed"
                  required
                  checked={consentAgreed}
                  aria-describedby={`${formId}-consent-description`}
                  data-testid="handover-consent"
                  data-analytics-id="handover-consent-agreed"
                  mix={[
                    css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: 0,
                      margin: '-1px',
                      overflow: 'hidden',
                      clip: 'rect(0, 0, 0, 0)',
                      whiteSpace: 'nowrap',
                      borderWidth: 0,
                    }),
                    on('change', (event) => {
                      consentAgreed = (event.currentTarget as HTMLInputElement).checked
                      handle.update()
                    }),
                  ]}
                />
                <span
                  aria-hidden="true"
                  mix={css({
                    display: 'flex',
                    width: '1rem',
                    height: '1rem',
                    flexShrink: 0,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: '4px',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    transitionProperty:
                      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    ...(consentAgreed
                      ? {
                          borderColor: 'var(--primary)',
                          backgroundColor: 'var(--primary)',
                          color: 'var(--primary-foreground)',
                        }
                      : { borderColor: 'var(--input)', backgroundColor: '#fff', color: 'transparent' }),
                  })}
                >
                  <CheckIcon />
                </span>
                <span
                  mix={css({
                    minWidth: '0rem',
                    cursor: 'pointer',
                    fontSize: '.875rem',
                    lineHeight: 1.4285714285714286,
                    fontWeight: 500,
                    color: 'var(--color-slate-800)',
                  })}
                >
                  Agreed
                </span>
                <span
                  aria-hidden="true"
                  mix={css({
                    marginLeft: 'auto',
                    borderRadius: '9999px',
                    paddingLeft: '0.5rem',
                    paddingRight: '0.5rem',
                    paddingTop: '0.125rem',
                    paddingBottom: '0.125rem',
                    fontSize: '.75rem',
                    lineHeight: 1.3333333333333333,
                    fontWeight: 500,
                    ...(consentAgreed
                      ? { backgroundColor: 'var(--color-emerald-100)', color: 'var(--color-emerald-700)' }
                      : { backgroundColor: 'var(--color-amber-100)', color: 'var(--color-amber-800)' }),
                  })}
                >
                  {consentAgreed ? 'Confirmed' : 'Not confirmed'}
                </span>
              </label>
              <p id={`${formId}-consent-description`} mix={css(fieldDescriptionStyles)}>
                {consentAgreed
                  ? 'Consent is confirmed for this handover.'
                  : 'Tick this box before recording or creating a handover.'}
              </p>
            </fieldset>
          </div>

          {!showManualTranscript ? (
            <div
              mix={css({
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                ...(handle.props.presentation === 'dialog'
                  ? {
                      '@media (min-width: 40rem)': {
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      },
                    }
                  : {
                      '@media (min-width: 40rem)': {
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                      },
                    }),
              })}
            >
              {handle.props.presentation === 'dialog' ? (
                <button
                  type="button"
                  data-analytics-id="handover-cancel-composer"
                  mix={[
                    css({
                      ...ghostButtonStyles,
                      justifyContent: 'flex-start',
                      color: 'var(--color-slate-600)',
                      '@media (hover: hover)': {
                        '&:hover': { backgroundColor: 'transparent', color: 'var(--color-slate-900)' },
                      },
                    }),
                    on('click', (event) => {
                      event.currentTarget.closest('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true }))
                    }),
                  ]}
                >
                  Cancel
                </button>
              ) : null}
              <button
                type="button"
                data-testid="recording-start"
                data-analytics-id="handover-start-recording"

                disabled={recorderState !== 'idle' && recorderState !== 'error'}
                aria-describedby={recorderMessage ? `${formId}-recorder-message` : undefined}
                mix={[
                  css(recordingButtonStyles),
                  on('click', (event) => {
                    let sourceForm = (event.currentTarget as HTMLElement).closest('form')
                    if (!(sourceForm instanceof HTMLFormElement) || !sourceForm.reportValidity()) return
                    let accepted = requestPersistentRecording({
                      formId,
                      submitAction: handle.props.action,
                      uploadAction: handle.props.uploadAction ?? handle.props.action,
                      csrfToken: handle.props.csrfToken,
                      contextLabel: handle.props.linkedPatient?.displayName ?? 'New handover',
                      formData: new FormData(sourceForm),
                    })
                    if (!accepted) {
                      recorderState = 'error'
                      recorderMessage =
                        'The persistent recorder is unavailable or another handover is already recording.'
                      handle.update()
                    }
                  }),
                ]}
              >
                <MicrophoneIcon />
                {recordingTriggerLabel(recorderState)}
              </button>
              {recorderMessage && recorderState === 'error' ? (
                <p
                  id={`${formId}-recorder-message`}
                  role="alert"
                  mix={css({ fontSize: '.875rem', lineHeight: '1.25rem', color: 'var(--color-rose-700)' })}
                >
                  {recorderMessage}
                </p>
              ) : null}
            </div>
          ) : null}

          {showManualTranscript ? (
            <div
              mix={css({
                borderRadius: '20px',
                borderWidth: '1px',
                borderStyle: 'dashed',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                backgroundColor: 'color-mix(in oklab, #fff 70%, transparent)',
                padding: '1rem',
              })}
            >
              <div
                mix={css({
                  marginBottom: '0.75rem',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.5rem',
                })}
              >
                <div
                  mix={css({
                    fontSize: '11px',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.16em',
                    color: 'var(--color-slate-500)',
                  })}
                >
                  Testing only
                </div>
                <button
                  type="button"
                  data-analytics-id="handover-hide-manual-entry"
                  mix={[
                    css(ghostButtonStyles),
                    on('click', () => {
                      showManualTranscript = false
                      handle.update()
                    }),
                  ]}
                >
                  Hide
                </button>
              </div>
              <div mix={css(fieldStyles)}>
                <label mix={css(fieldLabelStyles)} htmlFor={`${formId}-manual-transcript`}>
                  Manual transcript
                </label>
                <textarea
                  id={`${formId}-manual-transcript`}
                  name="manualTranscript"
                  rows={9}
                  required
                  placeholder="Paste a transcript here using speaker turns like [INCOMING_NURSE]: ..."
                  mix={css(textareaStyles)}
                  data-analytics-id="handover-manual-entry-input"
                ></textarea>
              </div>
              <div
                mix={css({
                  marginTop: '1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.5rem',
                  '@media (min-width: 40rem)': { flexDirection: 'row', justifyContent: 'flex-end' },
                })}
              >
                <button
                  type="submit"
                  mix={css(primaryButtonStyles)}
                  data-analytics-id="handover-create-from-manual-entry"
                >
                  <MicrophoneIcon />
                  Create handover
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-analytics-id="handover-show-manual-entry"
              mix={[
                css(manualEntryButtonStyles),
                on('click', () => {
                  showManualTranscript = true
                  handle.update()
                }),
              ]}
            >
              Manual transcript (testing)
            </button>
          )}
        </form>
      )

      if (handle.props.presentation === 'embedded' || handle.props.presentation === 'dialog') return form

      return (
        <section
          mix={css({
            borderRadius: '24px',
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: 'color-mix(in oklab, #fff 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, #fff 92%, transparent)',
            padding: '1rem',
            boxShadow: '0 16px 36px rgba(44,56,75,0.05)',
          })}
        >
          <div
            mix={css({
              marginBottom: '0.75rem',
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
              color: 'var(--color-slate-500)',
            })}
          >
            New handover
          </div>
          {form}
        </section>
      )
    }
  },
)

function CheckIcon() {
  return () => (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '0.75rem', height: '0.75rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

function MicrophoneIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      viewBox="0 0 24 24"
      aria-hidden="true"
      mix={css({ width: '1rem', height: '1rem' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect width="8" height="13" x="8" y="2" rx="4" />
      <path d="M18 10v2a6 6 0 0 1-12 0v-2M12 18v4M8 22h8" />
    </svg>
  )
}

const fieldStyles = {
  display: 'flex',
  width: '100%',
  flexDirection: 'column',
  gap: '0.5rem',
  '&[data-invalid=true]': { color: 'var(--destructive)' },
} satisfies Parameters<typeof css>[0]
const fieldLabelStyles = {
  display: 'flex',
  width: 'fit-content',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '.875rem',
  lineHeight: 1,
  fontWeight: 500,
  userSelect: 'none',
} satisfies Parameters<typeof css>[0]
const fieldDescriptionStyles = {
  fontSize: '.875rem',
  lineHeight: 1.5,
  fontWeight: 400,
  color: 'var(--muted-foreground)',
} satisfies Parameters<typeof css>[0]
const inputStyles = {
  display: 'block',
  height: '2rem',
  width: '100%',
  minWidth: '0rem',
  borderRadius: 'var(--radius)',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--input)',
  backgroundColor: 'transparent',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  paddingTop: '0.25rem',
  paddingBottom: '0.25rem',
  fontSize: '1rem',
  lineHeight: 1.5,
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&::placeholder': { color: 'var(--muted-foreground)' },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:disabled': {
    pointerEvents: 'none',
    cursor: 'not-allowed',
    backgroundColor: 'color-mix(in oklab, var(--input) 50%, transparent)',
    opacity: 0.5,
  },
  '&[aria-invalid="true"]': {
    borderColor: 'var(--destructive)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)',
  },
  '@media (min-width: 48rem)': { fontSize: '.875rem', lineHeight: 1.4285714285714286 },
} satisfies Parameters<typeof css>[0]
const textareaStyles = {
  display: 'flex',
  fieldSizing: 'content',
  minHeight: '4rem',
  width: '100%',
  borderRadius: 'var(--radius)',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'var(--input)',
  backgroundColor: 'transparent',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  fontSize: '1rem',
  lineHeight: 1.5,
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&::placeholder': { color: 'var(--muted-foreground)' },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:disabled': {
    cursor: 'not-allowed',
    backgroundColor: 'color-mix(in oklab, var(--input) 50%, transparent)',
    opacity: 0.5,
  },
  '&[aria-invalid="true"]': {
    borderColor: 'var(--destructive)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)',
  },
  '@media (min-width: 48rem)': { fontSize: '.875rem', lineHeight: 1.4285714285714286 },
} satisfies Parameters<typeof css>[0]

const ghostButtonStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: 'var(--radius)',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  backgroundClip: 'padding-box',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--foreground)',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  userSelect: 'none',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'var(--muted)', color: 'var(--foreground)' } },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:active': { translate: '0 1px' },
} satisfies Parameters<typeof css>[0]
const manualEntryButtonStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'flex-start',
  gap: '0.375rem',
  borderRadius: '18px',
  borderWidth: '1px',
  borderStyle: 'dashed',
  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
  backgroundClip: 'padding-box',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--color-slate-600)',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  userSelect: 'none',
  '@media (hover: hover)': { '&:hover': { backgroundColor: '#fff', color: 'var(--foreground)' } },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:active': { translate: '0 1px' },
} satisfies Parameters<typeof css>[0]
const primaryButtonStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: 'var(--radius)',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  backgroundColor: 'var(--primary)',
  backgroundClip: 'padding-box',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--primary-foreground)',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  userSelect: 'none',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:active': { translate: '0 1px' },
} satisfies Parameters<typeof css>[0]
const recordingButtonStyles = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: 0,
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: '18px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  backgroundColor: 'var(--primary)',
  backgroundClip: 'padding-box',
  paddingLeft: '1rem',
  paddingRight: '1rem',
  fontSize: '.875rem',
  lineHeight: 1.4285714285714286,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: 'var(--primary-foreground)',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  userSelect: 'none',
  '@media (hover: hover)': { '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' } },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
  },
  '&:disabled': { cursor: 'not-allowed', opacity: 0.6 },
  '@media (min-width: 40rem)': { minWidth: '11rem' },
} satisfies Parameters<typeof css>[0]

function recordingTriggerLabel(state: RecorderState) {
  if (state === 'requesting') return 'Starting recorder…'
  if (state === 'recording' || state === 'paused') return 'Recording active'
  if (state === 'stopping' || state === 'submitting') return 'Submitting handover…'
  if (state === 'ready') return 'Upload needs attention'
  return 'Start recording'
}

// FormSelect owns the shared geometry; this form supplies the theme and chevron.
const selectStyles = {
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  background: 'transparent',
  border: '1px solid var(--input)',
  boxShadow: 'none',
  color: 'inherit',
  font: 'inherit',
  fontSize: '14px',
  padding: '4px 10px',
  textShadow: 'none',
  '&::after': {
    content: '""',
    width: '7px',
    height: '7px',
    marginLeft: 'auto',
    marginRight: '2px',
    borderRight: '1.5px solid currentColor',
    borderBottom: '1.5px solid currentColor',
    transform: 'translateY(-2px) rotate(45deg)',
    flex: 'none',
  },
  '&:hover, &:focus-visible, &[aria-expanded="true"], &[aria-expanded="true"]:hover, &[aria-expanded="true"]:focus-visible':
    {
      background: 'transparent',
      color: 'inherit',
    },
  '&:focus-visible, &[aria-expanded="true"]': {
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--ring) 50%, transparent)',
    outline: 0,
  },
} satisfies Parameters<typeof css>[0]
