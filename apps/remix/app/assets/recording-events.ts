export const RECORDING_REQUEST_EVENT = 'handover:recording-request'
export const RECORDING_CANCEL_EVENT = 'handover:recording-cancel'
export const RECORDING_STATUS_EVENT = 'handover:recording-status'

export type RecorderState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping' | 'ready' | 'submitting' | 'error'

export type RecordingStatusDetail = {
  formId: string
  status: RecorderState
  message?: string
}

export type RecordingRestartCue = {
  id: string
  title: string
  subtitle?: string | null
  lastConfirmedPoint: string
}

export type RecordingRequest = {
  formId: string
  submitAction: string
  uploadAction?: string
  csrfToken?: string
  contextLabel?: string
  mode?: 'create' | 'extend'
  restartCue?: string
  restartCueTitle?: string
  restartCueSubtitle?: string
  restartCues?: RecordingRestartCue[]
  formData: FormData
}

export type RecordingRequestDetail = RecordingRequest & { accepted: boolean }

export type RecordingCancelDetail = {
  formId: string
  canceled: boolean
}

export function requestPersistentRecording(request: RecordingRequest): boolean {
  let detail: RecordingRequestDetail = { ...request, formData: cloneFormData(request.formData), accepted: false }
  window.dispatchEvent(new CustomEvent<RecordingRequestDetail>(RECORDING_REQUEST_EVENT, { detail }))
  return detail.accepted
}

export function cancelPersistentRecording(formId: string): boolean {
  let detail: RecordingCancelDetail = { formId, canceled: false }
  window.dispatchEvent(new CustomEvent<RecordingCancelDetail>(RECORDING_CANCEL_EVENT, { detail }))
  return detail.canceled
}

function cloneFormData(source: FormData) {
  let clone = new FormData()
  for (let [name, value] of source.entries()) clone.append(name, value)
  return clone
}
