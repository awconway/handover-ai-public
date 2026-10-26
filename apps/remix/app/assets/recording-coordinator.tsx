import { clientEntry, css, navigate, on, ref, type Handle, type RemixNode, type SerializableProps } from 'remix/component'
import {
  frameMutationLocationHeader,
  frameMutationRequestHeader,
  frameMutationRequestValue,
} from '../utils/frame-mutation.ts'
import {
  RECORDING_CANCEL_EVENT,
  RECORDING_REQUEST_EVENT,
  RECORDING_STATUS_EVENT,
  type RecordingCancelDetail,
  type RecorderState,
  type RecordingRequest,
  type RecordingRequestDetail,
  type RecordingRestartCue,
  type RecordingStatusDetail,
} from './recording-events.ts'
import {
  appendPendingRecordingChunk,
  clearPendingRecordingUploadedMarker,
  createPendingRecordingUpload,
  deletePendingRecordingUpload,
  loadPendingRecordingUploads,
  markPendingRecordingUploaded,
  requestFromPendingRecordingUpload,
  savePendingRecordingUpload,
  wasPendingRecordingUploaded,
  type PendingRecordingUpload,
} from './pending-recording-upload.ts'

type LiveNoiseSnapshot = {
  level: 'monitoring' | 'quiet' | 'elevated' | 'high'
  label: string
  detail: string
  score: number
  speechMarginDb: number | null
  userIsSpeaking: boolean
}

interface RecordingProps extends SerializableProps {
  currentUserId: string
  signInHref: string
  signOutAction: string
  submitAction?: string
  uploadAction?: string
  csrfToken?: string
  contextLabel?: string
}

/**
 * Hands an already-validated form snapshot to the shell-owned recorder.
 *
 * The snapshot deliberately crosses the Frame boundary as a DOM event rather
 * than living in the page client entry. That lets Remix replace the workspace
 * Frame (or close a dialog) without destroying an active capture.
 */
/**
 * One recorder client entry is mounted by AppShell, outside the workspace
 * Frame. MediaRecorder, the form snapshot, and upload ownership therefore have
 * the same lifetime as the shell rather than the surface that started them.
 */
export const RecordingCoordinator = clientEntry(import.meta.url + '#RecordingCoordinator', function RecordingCoordinator(handle: Handle<RecordingProps>) {
  let state: RecorderState = 'idle'
  let elapsed = 0
  let message = ''
  let recorder: MediaRecorder | undefined
  let stream: MediaStream | undefined
  let chunks: Blob[] = []
  let capturedAudio: Blob | undefined
  let recordedMimeType = 'audio/webm'
  let request: RecordingRequest | undefined
  let requestGeneration = 0
  let stopRequested = false
  let submitOnStop = false
  let deferUploadForPageExit = false
  let pendingUpload: PendingRecordingUpload | undefined
  let pendingChunkSequence = 0
  let persistenceQueue: Promise<void> = Promise.resolve()
  let activeDiscardInProgress = false
  let recoveryStarted = false
  let signingOut = false
  let bypassBeforeUnload = false
  let signOutGuardMessage = ''
  let activityLockAcquisition: Promise<boolean> | undefined
  let activityLockTask: Promise<void> | undefined
  let releaseActivityLock: (() => void) | undefined
  let uploadAbortController: AbortController | undefined
  let disposed = false
  let timer: number | undefined
  let levelTimer: number | undefined
  let audioContext: AudioContext | undefined
  let audioSource: MediaStreamAudioSourceNode | undefined
  let analyser: AnalyserNode | undefined
  let wakeLock: WakeLockSentinel | undefined
  let recommenceCueVisible = false
  let expanded = false
  let recorderSurfaceOpen = false
  let recorderDialog: HTMLDialogElement | undefined
  let isMobile = false
  let liveNoise: LiveNoiseSnapshot | null = null
  let liveNoiseFloor = 0
  let liveSpeechLevel = 0
  let liveSpeechFrames = 0

  handle.signal.addEventListener('abort', () => {
    disposed = true
    if (state === 'recording' || state === 'paused' || state === 'stopping') {
      deferUploadForPageExit = true
      stopAndSubmit('Saving the recording captured so far before this page changes…')
    } else if (state === 'ready' && capturedAudio) {
      void persistCapturedAudio().finally(() => { void releaseUserRecordingActivityLock() })
    } else {
      requestGeneration++
      releaseCaptureDevices()
      void releaseUserRecordingActivityLock()
    }
    syncRecordingReserve('none')
  }, { once: true })

  // Remix's browser HMR transform retains setup declarations before the render return.
  function cueDockPanel(): RemixNode {
    let cue = request ? recordingRestartCues(request)[0] : undefined
    if (!cue) return null
    return <div data-testid="recommence-cue-panel" mix={css({
      borderBottomStyle: 'solid',
      borderBottomWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      paddingBottom: '0.75rem',
      color: 'var(--color-slate-800)'
    })}>
      <div mix={css({ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
        <div mix={css({ minWidth: "0rem", flex: "1" })}>
          <div mix={css({ fontSize: "11px", fontWeight: "600", letterSpacing: "0.14em", color: "var(--primary)", textTransform: "uppercase" })}>Restart cue</div>
          <p mix={css({ marginTop: "0.375rem", fontSize: "0.875rem", lineHeight: "1.25rem", color: "var(--color-slate-700)" })}>{cue.lastConfirmedPoint}</p>
        </div>
        <button
          type="button"
          aria-label="Hide restart cue"
          mix={[css({
            marginTop: '-0.25rem',
            marginRight: '-0.25rem',
            display: 'flex',
            width: '2.25rem',
            height: '2.25rem',
            flexShrink: '0',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'calc(infinity * 1px)',
            color: 'var(--color-slate-500)',
            transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
            transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            transitionDuration: '150ms',
            '&:hover': {
              '@media (hover: hover)': {
                backgroundColor: 'var(--color-slate-100)',
                color: 'var(--color-slate-900)'
              }
            }
          }), on('click', () => {
            recommenceCueVisible = false
            safeUpdate()
          })]}
        ><XIcon /></button>
      </div>
    </div>
  }

  function acceptRecordingRequest(event: Event) {
    let detail = (event as CustomEvent<RecordingRequestDetail>).detail
    if (!detail?.formId || !detail.submitAction || signingOut || activeDiscardInProgress || state !== 'idle' || request) return
    detail.accepted = true
    request = {
      formId: detail.formId,
      submitAction: detail.submitAction,
      uploadAction: detail.uploadAction,
      csrfToken: detail.csrfToken,
      contextLabel: detail.contextLabel,
      mode: detail.mode,
      restartCue: detail.restartCue,
      restartCueTitle: detail.restartCueTitle,
      restartCueSubtitle: detail.restartCueSubtitle,
      restartCues: detail.restartCues?.map((cue) => ({ ...cue })),
      formData: cloneFormData(detail.formData),
    }
    recommenceCueVisible = Boolean(detail.mode === 'extend' && (detail.restartCues?.length || detail.restartCue))
    signOutGuardMessage = ''
    expanded = false
    recorderSurfaceOpen = false
    liveNoise = createMonitoringNoiseSnapshot()
    state = 'requesting'
    message = ''
    announceStatus()
    safeUpdate()
    void startMicrophone()
  }

  function cancelRecordingRequest(event: Event) {
    let detail = (event as CustomEvent<RecordingCancelDetail>).detail
    if (!detail?.formId || request?.formId !== detail.formId || state !== 'requesting') return
    detail.canceled = true
    cancelEmptyRequest()
  }

  async function startMicrophone() {
    if (!request || state === 'recording' || state === 'paused' || state === 'stopping' || state === 'submitting') return
    let generation = ++requestGeneration
    state = 'requesting'
    message = ''
    signOutGuardMessage = ''
    capturedAudio = undefined
    chunks = []
    stopRequested = false
    submitOnStop = false
    liveNoise = createMonitoringNoiseSnapshot()
    resetLiveNoiseAnalysis()
    announceStatus()
    safeUpdate()

    try {
      let acquired = await acquireUserRecordingActivityLock()
      if (!acquired) {
        failRecordingStart('Another app tab is already recording or reviewing a saved recording. Finish or discard it there before starting a new recording.')
        return
      }
      if (disposed || generation !== requestGeneration || !request) {
        await releaseUserRecordingActivityLock()
        return
      }
      let nextStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      if (disposed || generation !== requestGeneration || !request) {
        nextStream.getTracks().forEach((track) => track.stop())
        return
      }

      stream = nextStream
      let mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type))
      let nextRecorder = new MediaRecorder(nextStream, mimeType ? { mimeType } : undefined)
      recorder = nextRecorder
      recordedMimeType = nextRecorder.mimeType || mimeType || 'audio/webm'
      nextRecorder.addEventListener('dataavailable', (dataEvent) => {
        if (!dataEvent.data.size) return
        chunks.push(dataEvent.data)
        // Timeslice chunks are durably snapshotted while capture is active.
        // A hard browser/process exit can still lose the final in-flight
        // transaction, but it no longer puts the entire recording at risk.
        void queueCapturedAudioChunkPersistence(dataEvent.data)
      })
      nextRecorder.addEventListener('stop', () => {
        if (recorder === nextRecorder) recorder = undefined
        releaseCaptureDevices()
        if (!submitOnStop) return
        submitOnStop = false
        capturedAudio = new Blob(chunks, { type: recordedMimeType })
        chunks = []
        if (!capturedAudio.size) {
          capturedAudio = undefined
          if (request?.mode !== 'extend') {
            failRecordingStart('The recording was empty. Please try again.')
            return
          }
          state = 'error'
          message = 'The recording was empty. Please try again.'
          recorderSurfaceOpen = request?.mode === 'extend'
          announceStatus()
          safeUpdate()
          return
        }
        if (deferUploadForPageExit) {
          deferUploadForPageExit = false
          void retainCapturedAudioForRecovery()
        } else {
          void uploadCapturedAudio()
        }
      }, { once: true })
      nextStream.getTracks().forEach((track) => track.addEventListener('ended', () => {
        if ((state === 'recording' || state === 'paused') && !stopRequested) {
          stopAndSubmit('The microphone disconnected. Uploading the audio captured so far…')
        }
      }, { once: true }))

      nextRecorder.start(1_000)
      state = 'recording'
      elapsed = 0
      recorderSurfaceOpen = false
      timer = window.setInterval(() => {
        elapsed++
        if (request?.mode === 'extend' && elapsed >= 15) recommenceCueVisible = false
        safeUpdate()
      }, 1_000)
      announceStatus()
      safeUpdate()
      void acquireWakeLock()
      monitorInput(nextStream)
    } catch (error) {
      if (generation !== requestGeneration || disposed) return
      let detail = error instanceof Error && error.message ? error.message : 'Unable to access the microphone.'
      let normalized = /[.!?]$/.test(detail) ? detail : `${detail}.`
      failRecordingStart(`Microphone access failed: ${normalized} Check browser permissions, then try Start recording again, or use a manual transcript.`)
    }
  }

  function stopAndSubmit(protectionMessage = '') {
    if ((state !== 'recording' && state !== 'paused' && state !== 'stopping') || !recorder) return
    if (stopRequested) return

    stopRequested = true
    submitOnStop = true
    signOutGuardMessage = ''
    clearTimers()
    state = 'stopping'
    if (protectionMessage) message = protectionMessage
    announceStatus()
    safeUpdate()
    try { recorder.requestData() } catch { /* stop() still flushes the recorder's final data. */ }
    try { recorder.stop() } catch {
      state = 'error'
      message = 'The recording could not be prepared. Please try again.'
      recorderSurfaceOpen = request?.mode === 'extend'
      announceStatus()
      safeUpdate()
    }
    stream?.getTracks().forEach((track) => track.stop())
  }

  async function uploadCapturedAudio() {
    if (!request || !capturedAudio || state === 'submitting') return
    let activeRequest = request
    let audio = capturedAudio
    state = 'submitting'
    message = ''
    signOutGuardMessage = ''
    announceStatus()
    safeUpdate()
    let savedForRecovery = await persistCapturedAudio()
    if (disposed || signingOut || !pendingUpload) return

    let lockAcquired = false
    let performUpload = async () => {
      lockAcquired = true
      let data = cloneFormData(activeRequest.formData)
      let extension = (audio.type || recordedMimeType).includes('mp4') ? 'm4a' : (audio.type || recordedMimeType).includes('ogg') ? 'ogg' : 'webm'
      data.set('audio', audio, `handover-${Date.now()}.${extension}`)
      data.set('consentMode', 'agreed')
      data.set('recordingUploadId', pendingUpload!.id)
      let csrfToken = handle.props.csrfToken ?? activeRequest.csrfToken
      if (csrfToken) data.set('_csrf', csrfToken)

      try {
        uploadAbortController = new AbortController()
        let action = activeRequest.uploadAction ?? handle.props.uploadAction ?? activeRequest.submitAction ?? handle.props.submitAction ?? ''
        let response = await fetch(action, {
          method: 'POST',
          body: data,
          credentials: 'same-origin',
          headers: {
            accept: 'text/html',
            [frameMutationRequestHeader]: frameMutationRequestValue,
          },
          signal: uploadAbortController.signal,
        })
        if (!response.ok) throw new Error(String(response.status))

        let redirect = response.redirected && response.url ? new URL(response.url) : undefined
        let mutationLocation = response.headers.get(frameMutationLocationHeader)
        let destination = mutationLocation
          ? new URL(mutationLocation, response.url || action || window.location.href)
          : redirect
        if (destination && destination.origin !== window.location.origin) {
          throw new Error('Recording upload returned an invalid destination.')
        }
        let signIn = new URL(handle.props.signInHref, window.location.href)
        if (destination?.origin === window.location.origin && destination.pathname === signIn.pathname) {
          throw new Error('Authentication expired during recording upload.')
        }
        if (pendingUpload) {
          let completedId = pendingUpload.id
          markPendingRecordingUploaded(completedId)
          try {
            await deletePendingRecordingUpload(completedId)
            clearPendingRecordingUploadedMarker(completedId)
          } catch (error) {
            // The opaque completion marker prevents a replay on the next mount;
            // a later recovery pass will retry this local-only cleanup.
            console.error('Could not clear the completed recording upload', error)
          }
        }
        await resetAfterSuccess()
        await recoverPendingUpload()
        if (!disposed && destination?.origin === window.location.origin) {
          await navigate(`${destination.pathname}${destination.search}${destination.hash}`, { target: 'workspace' })
          return
        }
        if (!disposed) handle.frames.get('workspace')?.reload()
      } catch (error) {
        if (disposed || signingOut || (error instanceof DOMException && error.name === 'AbortError')) return
        state = 'ready'
        message = savedForRecovery
          ? 'The upload did not complete. Your recording is saved in this browser; retry when the connection is available.'
          : 'The upload did not complete. Keep this page open and retry so the recording is not lost.'
        expanded = true
        recorderSurfaceOpen = false
        announceStatus()
        safeUpdate()
      } finally {
        uploadAbortController = undefined
      }
    }

    try {
      if (navigator.locks) {
        await navigator.locks.request(`handover-recording-upload:${pendingUpload.id}`, { ifAvailable: true }, async (lock) => {
          if (lock) await performUpload()
        })
      } else {
        await performUpload()
      }
    } catch (error) {
      if (disposed || signingOut) return
      console.error('Could not acquire the recording upload lock', error)
    }

    if (!lockAcquired && !disposed && !signingOut) {
      state = 'ready'
      message = 'This recording is already being uploaded in another app tab. Wait for it to finish before retrying.'
      expanded = true
      announceStatus()
      safeUpdate()
    }
  }

  async function persistCapturedAudio() {
    if (!request || !capturedAudio) return false
    let now = Date.now()
    let uploadSnapshot = pendingUpload
      ? { ...pendingUpload, audio: capturedAudio, recordedMimeType, updatedAt: now, captureComplete: true }
      : createPendingRecordingUpload(request, capturedAudio, recordedMimeType, handle.props.currentUserId, true)
    pendingUpload = uploadSnapshot
    let saved = false
    let saveOperation = persistenceQueue
      .catch(() => { /* The completed Blob can supersede a failed chunk write. */ })
      .then(async () => {
        try {
          await savePendingRecordingUpload(uploadSnapshot)
          saved = true
        } catch (error) {
          console.error('Could not save the completed recording in browser storage', error)
        }
      })
    // Sign-out and discard await this same chain, so neither can delete the
    // browser copy before a concurrent final save finishes and recreates it.
    persistenceQueue = saveOperation
    await saveOperation
    return saved
  }

  function queueCapturedAudioChunkPersistence(chunk: Blob) {
    if (!request || !chunk.size) return persistenceQueue
    let now = Date.now()
    pendingUpload = pendingUpload
      ? { ...pendingUpload, updatedAt: now, captureComplete: false }
      : createPendingRecordingUpload(request, new Blob([], { type: recordedMimeType }), recordedMimeType, handle.props.currentUserId, false)
    let uploadSnapshot = { ...pendingUpload }
    let sequence = pendingChunkSequence++
    persistenceQueue = persistenceQueue
      .catch(() => { /* A later chunk may still persist successfully. */ })
      .then(async () => {
        try {
          await appendPendingRecordingChunk(uploadSnapshot, chunk, sequence)
        } catch (error) {
          console.error('Could not save a pending recording chunk in browser storage', error)
        }
      })
    return persistenceQueue
  }

  async function retainCapturedAudioForRecovery() {
    let saved = await persistCapturedAudio()
    if (disposed) {
      await releaseUserRecordingActivityLock()
      return
    }
    state = 'ready'
    message = saved
      ? 'Your recording is saved in this browser. Retry the upload when you are ready.'
      : 'Keep this page open and retry the upload so the recording is not lost.'
    expanded = true
    announceStatus()
    safeUpdate()
  }

  async function nextPendingUploadForCurrentUser() {
    let uploads = await loadPendingRecordingUploads()
    for (let candidate of uploads) {
      // Shared browsers may contain a pending capture for another account.
      // Never expose, upload, or delete it from the current user's session.
      if (candidate.ownerUserId !== handle.props.currentUserId) continue
      if (!wasPendingRecordingUploaded(candidate.id)) return candidate
      try {
        await deletePendingRecordingUpload(candidate.id)
        clearPendingRecordingUploadedMarker(candidate.id)
      } catch (error) {
        console.error('Could not clear a completed recording upload', error)
      }
    }
    return undefined
  }

  function surfacePendingUpload(upload: PendingRecordingUpload, recoveryMessage = 'A recording from an earlier page is saved in this browser. Check the current handover, then retry the upload or discard it.') {
    if (disposed || signingOut || state !== 'idle' || request) return false
    pendingUpload = upload
    request = requestFromPendingRecordingUpload(upload)
    if (handle.props.csrfToken) request.csrfToken = handle.props.csrfToken
    capturedAudio = upload.audio
    recordedMimeType = upload.recordedMimeType
    state = 'ready'
    message = recoveryMessage
    expanded = true
    announceStatus()
    safeUpdate()
    return true
  }

  async function recoverPendingUpload() {
    try {
      if (disposed || signingOut || state !== 'idle' || request) return false
      let upload: PendingRecordingUpload | undefined
      let acquired = await acquireUserRecordingActivityLock(async () => {
        upload = await nextPendingUploadForCurrentUser()
      })
      // Selection happens while acquiring the durable activity lock, so two
      // idle tabs cannot select and surface the same IndexedDB record.
      if (!acquired) return false
      if (upload && surfacePendingUpload(upload)) return true
      if (state === 'idle' && !request) await releaseUserRecordingActivityLock()
    } catch (error) {
      // IndexedDB can be disabled by browser policy. New recordings still use
      // the in-memory retry flow and a beforeunload warning in that case.
      console.error('Could not recover pending recording uploads', error)
    }
    return false
  }

  function protectHiddenCapture() {
    if (document.visibilityState !== 'hidden') return
    if (state === 'recording' || state === 'paused') {
      stopAndSubmit('Recording stopped because this page was hidden. Uploading securely…')
    } else if (state === 'ready' && capturedAudio) {
      void persistCapturedAudio()
    }
  }

  function protectPageExit() {
    if (state === 'recording' || state === 'paused') {
      deferUploadForPageExit = true
      stopAndSubmit('Saving the recording captured so far before this page changes…')
    } else if (state === 'ready' && capturedAudio) {
      void persistCapturedAudio()
    }
  }

  function warnBeforeExit(event: BeforeUnloadEvent) {
    if (bypassBeforeUnload) return
    if (state !== 'recording' && state !== 'paused' && state !== 'stopping' && state !== 'ready' && state !== 'submitting') return
    event.preventDefault()
    event.returnValue = ''
    protectPageExit()
  }

  function openRecorderSurface() {
    if (!request || (state !== 'recording' && state !== 'paused')) return
    recorderSurfaceOpen = true
    safeUpdate()
  }

  function closeRecorderSurface() {
    if (state === 'error') {
      cancelEmptyRequest()
      return
    }
    if (recorderDialog?.open) recorderDialog.close()
    recorderSurfaceOpen = false
    safeUpdate()
  }

  function cancelEmptyRequest() {
    if (capturedAudio || state === 'recording' || state === 'paused' || state === 'stopping' || state === 'submitting') return
    let formId = request?.formId
    requestGeneration++
    releaseCaptureDevices()
    request = undefined
    state = 'idle'
    message = ''
    signOutGuardMessage = ''
    recorderSurfaceOpen = false
    expanded = false
    recommenceCueVisible = false
    liveNoise = null
    if (formId) dispatchRecordingStatus({ formId, status: 'idle' })
    safeUpdate()
    void releaseUserRecordingActivityLock()
  }

  async function discardSavedRecording() {
    if (state !== 'ready' || !capturedAudio) return
    state = 'submitting'
    message = 'Discarding the saved recording…'
    signOutGuardMessage = ''
    announceStatus()
    safeUpdate()
    try {
      await persistenceQueue.catch(() => {})
      let discarded = false
      let discardedId = pendingUpload?.id
      if (discardedId && navigator.locks) {
        await navigator.locks.request(`handover-recording-upload:${discardedId}`, { ifAvailable: true }, async (lock) => {
          if (!lock) return
          await deletePendingRecordingUpload(discardedId)
          clearPendingRecordingUploadedMarker(discardedId)
          discarded = true
        })
      } else if (discardedId) {
        await deletePendingRecordingUpload(discardedId)
        clearPendingRecordingUploadedMarker(discardedId)
        discarded = true
      }
      if (!discarded) {
        state = 'ready'
        message = 'This recording is being handled in another app tab. Finish there, then try again.'
        expanded = true
        announceStatus()
        safeUpdate()
        return
      }
      await resetAfterSuccess()
      await recoverPendingUpload()
    } catch (error) {
      console.error('Could not discard the saved recording', error)
      state = 'ready'
      message = 'The saved recording could not be discarded. Keep this page open and try again.'
      expanded = true
      announceStatus()
      safeUpdate()
    }
  }

  function discardActiveRecording() {
    if (state !== 'recording' && state !== 'paused') return
    let formId = request?.formId
    let pendingId = pendingUpload?.id
    let queuedPersistence = persistenceQueue
    activeDiscardInProgress = true
    requestGeneration++
    stopRequested = true
    submitOnStop = false
    deferUploadForPageExit = false
    clearTimers()
    state = 'idle'
    request = undefined
    try { recorder?.stop() } catch { /* The capture is being discarded either way. */ }
    releaseCaptureDevices()
    recorder = undefined
    chunks = []
    capturedAudio = undefined
    elapsed = 0
    message = ''
    signOutGuardMessage = ''
    expanded = false
    recorderSurfaceOpen = false
    recommenceCueVisible = false
    liveNoise = null
    pendingUpload = undefined
    pendingChunkSequence = 0
    let discardPersistence = queuedPersistence.catch(() => {}).then(async () => {
      if (!pendingId) return
      try {
        await deletePendingRecordingUpload(pendingId)
        clearPendingRecordingUploadedMarker(pendingId)
      } catch (error) {
        console.error('Could not discard the partial recording snapshot', error)
      }
    }).finally(async () => {
      await releaseUserRecordingActivityLock()
      activeDiscardInProgress = false
    })
    // A sign-out immediately after an explicit discard must wait until the
    // queued partial chunks and their deletion have both settled.
    persistenceQueue = discardPersistence
    if (formId) dispatchRecordingStatus({ formId, status: 'idle' })
    safeUpdate()
  }

  function failRecordingStart(errorMessage: string) {
    let formId = request?.formId
    requestGeneration++
    releaseCaptureDevices()
    recorder = undefined
    chunks = []
    capturedAudio = undefined
    request = undefined
    state = 'idle'
    message = ''
    signOutGuardMessage = ''
    expanded = false
    recorderSurfaceOpen = false
    recommenceCueVisible = false
    liveNoise = null
    deferUploadForPageExit = false
    if (formId) dispatchRecordingStatus({ formId, status: 'error', message: errorMessage })
    safeUpdate()
    void releaseUserRecordingActivityLock()
  }

  async function resetAfterSuccess() {
    let formId = request?.formId
    releaseCaptureDevices()
    chunks = []
    capturedAudio = undefined
    request = undefined
    elapsed = 0
    state = 'idle'
    message = ''
    signOutGuardMessage = ''
    stopRequested = false
    submitOnStop = false
    deferUploadForPageExit = false
    pendingUpload = undefined
    pendingChunkSequence = 0
    persistenceQueue = Promise.resolve()
    recommenceCueVisible = false
    expanded = false
    recorderSurfaceOpen = false
    liveNoise = null
    if (formId) dispatchRecordingStatus({ formId, status: 'idle' })
    safeUpdate()
    await releaseUserRecordingActivityLock()
  }

  function userRecordingActivityLockName() {
    return `handover-recording-user:${handle.props.currentUserId}`
  }

  async function acquireUserRecordingActivityLock(whileAcquiring?: () => void | Promise<void>) {
    if (!navigator.locks) {
      await whileAcquiring?.()
      return true
    }
    if (releaseActivityLock) {
      await whileAcquiring?.()
      return true
    }
    if (activityLockAcquisition) {
      let acquired = await activityLockAcquisition
      if (acquired) await whileAcquiring?.()
      return acquired
    }

    let resolveAcquisition!: (acquired: boolean) => void
    let rejectAcquisition!: (error: unknown) => void
    let acquisitionSettled = false
    let acquisition = new Promise<boolean>((resolve, reject) => {
      resolveAcquisition = resolve
      rejectAcquisition = reject
    })
    let settleAcquisition = (acquired: boolean, error?: unknown) => {
      if (acquisitionSettled) return
      acquisitionSettled = true
      if (error) rejectAcquisition(error)
      else resolveAcquisition(acquired)
    }
    activityLockAcquisition = acquisition
    let localRelease: (() => void) | undefined
    let baseTask = navigator.locks.request(userRecordingActivityLockName(), { ifAvailable: true }, async (lock) => {
      if (!lock) {
        settleAcquisition(false)
        return
      }
      let releaseHold!: () => void
      let hold = new Promise<void>((resolve) => { releaseHold = resolve })
      localRelease = () => {
        if (releaseActivityLock === localRelease) releaseActivityLock = undefined
        if (activityLockAcquisition === acquisition) activityLockAcquisition = undefined
        releaseHold()
      }
      releaseActivityLock = localRelease
      try {
        // Queue selection runs before acquisition is exposed to the caller;
        // the exclusive lock then remains held until upload/discard/navigation.
        await whileAcquiring?.()
        settleAcquisition(true)
      } catch (error) {
        settleAcquisition(false, error)
        localRelease()
      }
      await hold
    }).catch((error) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Could not coordinate this recording with other app tabs', error)
      }
      settleAcquisition(false, error)
    })
    let finalTask = baseTask.finally(() => {
      if (releaseActivityLock === localRelease) releaseActivityLock = undefined
      if (activityLockAcquisition === acquisition) activityLockAcquisition = undefined
      if (activityLockTask === finalTask) activityLockTask = undefined
    })
    activityLockTask = finalTask
    return await acquisition
  }

  async function releaseUserRecordingActivityLock() {
    let task = activityLockTask
    if (releaseActivityLock) releaseActivityLock()
    await task?.catch(() => {})
  }

  async function keepSignOutLockUntilNavigationSettles() {
    await new Promise<void>((resolve) => {
      let timeout = window.setTimeout(resolve, 1_000)
      handle.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        resolve()
      }, { once: true })
    })
  }

  function interceptSignOut(event: SubmitEvent) {
    let form = event.target
    if (!(form instanceof HTMLFormElement) || !isSignOutForm(form)) return
    event.preventDefault()
    if (signingOut) return

    let hasProtectedRecording = state === 'recording'
      || state === 'paused'
      || state === 'stopping'
      || state === 'submitting'
      || state === 'ready'
      || Boolean(capturedAudio)
    if (hasProtectedRecording) {
      signOutGuardMessage = state === 'ready'
        ? 'Retry the saved recording or explicitly discard it before signing out.'
        : state === 'stopping' || state === 'submitting'
          ? 'Wait for the recording upload to finish before signing out. If it fails, retry it or explicitly discard the saved recording.'
          : 'Stop and upload the current recording, or explicitly discard it, before signing out.'
      expanded = true
      announceStatus()
      safeUpdate()
      return
    }

    // A pending microphone permission request or empty/error recorder has no
    // clinical audio to protect. Cancel it so a late getUserMedia resolution
    // cannot start a new capture after sign-out cleanup has begun.
    if (state !== 'idle' || request) cancelEmptyRequest()

    signingOut = true
    signOutGuardMessage = ''

    void (async () => {
      try {
        await persistenceQueue.catch(() => {})
        await releaseUserRecordingActivityLock()
        let pending: PendingRecordingUpload | undefined
        let acquired = await acquireUserRecordingActivityLock(async () => {
          pending = await nextPendingUploadForCurrentUser()
        })
        if (!acquired) {
          signingOut = false
          signOutGuardMessage = 'A recording is active or awaiting review in another app tab. Finish, retry, or explicitly discard it there before signing out.'
          safeUpdate()
          return
        }
        if (pending) {
          signingOut = false
          let surfaced = surfacePendingUpload(pending, 'A saved recording must be resolved before sign out. Retry its upload or explicitly discard it.')
          if (!surfaced) await releaseUserRecordingActivityLock()
          signOutGuardMessage = 'Retry this saved recording or explicitly discard it before signing out.'
          expanded = true
          safeUpdate()
          return
        }

        bypassBeforeUnload = true
        HTMLFormElement.prototype.submit.call(form)
        // Keep exclusive user-wide ownership through the navigation attempt.
        // If another handler cancels it, release and allow a later attempt.
        await keepSignOutLockUntilNavigationSettles()
        await releaseUserRecordingActivityLock()
        if (!disposed) {
          signingOut = false
          bypassBeforeUnload = false
        }
      } catch (error) {
        await releaseUserRecordingActivityLock()
        console.error('Could not inspect saved recordings during sign out', error)
        signingOut = false
        bypassBeforeUnload = false
        signOutGuardMessage = 'Saved recordings could not be checked in this browser, so sign out was cancelled. Try again.'
        safeUpdate()
      }
    })()
  }

  function isSignOutForm(form: HTMLFormElement) {
    try {
      let expected = new URL(handle.props.signOutAction, window.location.href)
      let actual = new URL(form.action, window.location.href)
      return actual.origin === expected.origin && actual.pathname === expected.pathname
    } catch {
      return false
    }
  }

  function announceStatus(status = state) {
    if (!request) return
    dispatchRecordingStatus({ formId: request.formId, status, message: message || undefined })
  }

  function safeUpdate() {
    if (disposed) return
    handle.update()
    handle.queueTask(() => syncRecordingReserve())
  }

  function clearTimers() {
    if (timer !== undefined) clearInterval(timer)
    if (levelTimer !== undefined) clearInterval(levelTimer)
    timer = undefined
    levelTimer = undefined
  }

  function releaseCaptureDevices() {
    clearTimers()
    stream?.getTracks().forEach((track) => track.stop())
    try { analyser?.disconnect() } catch { /* The analyser may already be disconnected. */ }
    try { audioSource?.disconnect() } catch { /* The source may already be disconnected. */ }
    void audioContext?.close()
    void wakeLock?.release()
    stream = undefined
    analyser = undefined
    audioSource = undefined
    audioContext = undefined
    wakeLock = undefined
    resetLiveNoiseAnalysis()
  }

  function resetLiveNoiseAnalysis() {
    liveNoiseFloor = 0
    liveSpeechLevel = 0
    liveSpeechFrames = 0
  }

  function monitorInput(activeStream: MediaStream) {
    try {
      let AudioContextConstructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AudioContextConstructor) return
      audioContext = new AudioContextConstructor()
      audioSource = audioContext.createMediaStreamSource(activeStream)
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.82
      audioSource.connect(analyser)
      let samples = new Uint8Array(analyser.fftSize)
      levelTimer = window.setInterval(() => {
        if (state !== 'recording' || !analyser) return
        analyser.getByteTimeDomainData(samples)
        let rms = computeByteTimeDomainRms(samples)
        if (!Number.isFinite(rms) || rms <= 0) {
          liveNoise = createMonitoringNoiseSnapshot()
          safeUpdate()
          return
        }

        if (liveNoiseFloor <= 0) {
          liveNoiseFloor = rms
          liveNoise = createMonitoringNoiseSnapshot()
          safeUpdate()
          return
        }

        let speechThreshold = Math.max(liveNoiseFloor * 2.6, 0.018)
        let isSpeechFrame = rms >= speechThreshold
        if (isSpeechFrame) {
          liveSpeechFrames++
          liveSpeechLevel = liveSpeechLevel <= 0 ? rms : liveSpeechLevel * 0.72 + rms * 0.28
        } else {
          liveNoiseFloor = liveNoiseFloor * 0.92 + rms * 0.08
          if (liveSpeechLevel > 0) liveSpeechLevel *= 0.985
        }

        liveNoise = createLiveNoiseSnapshot({
          noiseFloor: liveNoiseFloor,
          speechLevel: liveSpeechLevel,
          observedSpeechFrames: liveSpeechFrames,
          userIsSpeaking: isSpeechFrame,
        })
        safeUpdate()
      }, 250)
    } catch { /* Live-noise analysis is optional; recording remains available. */ }
  }

  async function acquireWakeLock() {
    try { wakeLock = await navigator.wakeLock?.request('screen') } catch { /* Screen lock is optional. */ }
  }

  function dockStatusLabel() {
    if (state === 'recording' || state === 'paused') return 'Recording live'
    if (state === 'stopping' || state === 'submitting') return request?.mode === 'extend' ? 'Updating handover' : 'Submitting handover'
    if (state === 'ready') return 'Upload needs attention'
    return 'Recording live'
  }

  function stopLabel() {
    return request?.mode === 'extend' ? 'Stop and update' : 'Stop and submit'
  }

  function syncRecordingReserve(forced?: 'none' | 'recording' | 'recommence-cue') {
    if (typeof document === 'undefined') return
    let captureActive = state === 'recording' || state === 'paused'
    let hasRecording = captureActive || state === 'stopping' || state === 'submitting' || state === 'ready'
    let reserve = forced ?? (hasRecording
      ? isMobile && request?.mode === 'extend' && captureActive && recommenceCueVisible && recordingRestartCues(request).length
        ? 'recommence-cue'
        : 'recording'
      : 'none')

    for (let node of document.querySelectorAll<HTMLElement>('[data-recording-reserve]')) {
      node.dataset.recordingReserve = reserve
    }
  }

  return () => {
    let captureActive = state === 'recording' || state === 'paused'
    let updating = state === 'stopping' || state === 'submitting'
    let dockVisible = !recorderSurfaceOpen && (captureActive || updating || state === 'ready')
    // Failed/recovered uploads use the standard dock so Retry upload and its
    // explanation remain available on small screens too.
    let compactMobileExtend = isMobile && request?.mode === 'extend' && state !== 'ready'
    let restartCues = request ? recordingRestartCues(request) : []
    let showCue = captureActive && request?.mode === 'extend' && restartCues.length > 0 && recommenceCueVisible

    return <>
      <span
        hidden
        aria-hidden="true"
        data-recording-coordinator="persistent"
        mix={ref((_node, signal) => {
          if (!recoveryStarted) {
            recoveryStarted = true
            void recoverPendingUpload()
          }
          window.addEventListener(RECORDING_CANCEL_EVENT, cancelRecordingRequest as EventListener, { signal })
          window.addEventListener(RECORDING_REQUEST_EVENT, acceptRecordingRequest as EventListener, { signal })
          document.addEventListener('visibilitychange', protectHiddenCapture, { signal })
          document.addEventListener('submit', interceptSignOut, { capture: true, signal })
          window.addEventListener('pagehide', protectPageExit, { signal })
          window.addEventListener('beforeunload', warnBeforeExit, { signal })

          let updateViewport = () => {
            let nextMobile = window.innerWidth < 768
            if (nextMobile === isMobile) return
            isMobile = nextMobile
            safeUpdate()
          }
          isMobile = window.innerWidth < 768
          window.addEventListener('resize', updateViewport, { signal })

          let observer = new MutationObserver(() => syncRecordingReserve())
          observer.observe(document.body, { childList: true, subtree: true })
          signal.addEventListener('abort', () => observer.disconnect(), { once: true })
          syncRecordingReserve()
        })}
      />

      {signOutGuardMessage && !dockVisible && !recorderSurfaceOpen ? <div
        role="alert"
        data-testid="recording-sign-out-message"
        mix={css({
          position: 'fixed',
          insetInline: '0.75rem',
          bottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)',
          zIndex: '40',
          borderRadius: 'calc(var(--radius) * 1.8)',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'var(--color-amber-200)',
          backgroundColor: 'var(--color-amber-50)',
          paddingInline: '1rem',
          paddingBlock: '0.75rem',
          fontSize: '0.875rem',
          lineHeight: '1.5rem',
          color: 'var(--color-amber-950)',
          boxShadow: '0 6px 12px rgba(44,56,75,0.10)',
          '@media (width >= 40rem)': {
            right: '1rem',
            left: 'auto',
            width: '440px'
          }
        })}
      >{signOutGuardMessage}</div> : null}

      {dockVisible ? compactMobileExtend
        ? <aside
          aria-label="Recording controls"
          mix={css({
            pointerEvents: 'none',
            position: 'fixed',
            insetInline: '0.75rem',
            bottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)',
            zIndex: '40',
            width: 'auto',
            maxWidth: 'calc(100vw - 1.5rem)'
          })}
        >
          <div
            data-testid="recording-dock"
            data-state={state}
            data-mode="extend"
            data-layout={showCue ? 'mobile-extend-cue' : expanded ? 'mobile-extend-expanded' : 'mobile-extend-compact'}
            mix={css({
              pointerEvents: 'auto',
              width: '100%',
              maxWidth: '100%',
              minWidth: '0rem',
              borderRadius: 'calc(var(--radius) * 1.8)',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-white) 96%, transparent)',
              boxShadow: '0 4px 8px rgba(44,56,75,0.10)'
            })}
          >
            <div mix={css({ display: "grid", minWidth: "0rem", gap: "0.75rem", padding: "0.75rem" })}>
              {showCue ? cueDockPanel() : null}
              <div mix={css({ display: "flex", minHeight: "68px", minWidth: "0rem", alignItems: "center", gap: "0.75rem", overflow: "hidden" })}>
                <div mix={css({ display: "flex", minWidth: "0rem", flex: "1", alignItems: "center", gap: "0.75rem" })}>
                  <div mix={css(updating ? { display: "flex", width: "2.5rem", height: "2.5rem", flexShrink: "0", alignItems: "center", justifyContent: "center", borderRadius: "14px", backgroundColor: "var(--color-slate-100)", color: "var(--color-slate-600)" } : { display: "flex", width: "2.5rem", height: "2.5rem", flexShrink: "0", alignItems: "center", justifyContent: "center", borderRadius: "14px", backgroundColor: "var(--color-rose-100)", color: "var(--color-rose-600)" })}>
                    {updating ? <SpinnerIcon /> : <MicIcon />}
                  </div>
                  <div mix={css({ minWidth: "0rem" })}>
                    <div mix={css({
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      fontSize: '11px',
                      fontWeight: '600',
                      letterSpacing: '0.14em',
                      color: 'var(--color-rose-700)',
                      textTransform: 'uppercase'
                    })}>
                      {captureActive ? <span mix={css({ width: "0.5rem", height: "0.5rem", borderRadius: "calc(infinity * 1px)", backgroundColor: "var(--color-rose-500)" })} aria-hidden="true" /> : null}
                      <span>{captureActive ? 'Recording live' : 'Updating handover'}</span>
                    </div>
                    <div mix={css({
                      marginTop: '0.25rem',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: '0.875rem',
                      lineHeight: '1.42857143',
                      fontWeight: '500',
                      color: 'var(--color-slate-950)'
                    })}>
                      {captureActive ? `${formatDuration(elapsed)} · Recommence handover` : 'Merging continuation'}
                    </div>
                  </div>
                </div>
                {captureActive ? <div mix={css({ display: "flex", flexShrink: "0", alignItems: "center", gap: "0.25rem" })}>
                  <button
                    type="button"
                    data-testid="recording-stop"
                    aria-label="Stop and update"
                    mix={[css(mobileStopButtonStyles), on('click', () => stopAndSubmit())]}
                  >Stop</button>
                  <button
                    type="button"

                    aria-label={expanded ? 'Collapse recorder' : 'Expand recorder'}
                    aria-expanded={expanded}
                    mix={[css(dockIconButtonStyles), on('click', () => {
                      expanded = !expanded
                      safeUpdate()
                    })]}
                  >{expanded ? <ChevronDownIcon /> : <MaximizeIcon />}</button>
                </div> : null}
              </div>

              {expanded && captureActive ? <div mix={css({
                display: 'grid',
                gap: '0.75rem',
                borderTopStyle: 'solid',
                borderTopWidth: '1px',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                paddingTop: '0.75rem'
              })}>
                {noiseIndicator(liveNoise, true)}
                <div mix={css({ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "0.5rem" })}>
                  <button type="button" mix={[css(outlineButtonStyles), on('click', openRecorderSurface)]}><MaximizeIcon dataIcon />Open recorder</button>
                  <button type="button" mix={[css(ghostButtonStyles), on('click', discardActiveRecording)]}><XIcon dataIcon />Discard</button>
                </div>
              </div> : null}
            </div>
          </div>
        </aside>
        : <aside
          aria-label="Recording controls"
          mix={css({
            pointerEvents: 'none',
            position: 'fixed',
            insetInline: '0.75rem',
            bottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)',
            zIndex: '40',
            '@media (width >= 40rem)': {
              insetInline: 'auto',
              right: '1rem',
              width: '440px'
            }
          })}
        >
          <div
            data-testid="recording-dock"
            data-state={state}
            data-mode={request?.mode ?? 'create'}
            data-layout={expanded ? 'expanded' : 'compact'}
            mix={css({
              pointerEvents: 'auto',
              borderRadius: 'calc(var(--radius) * 1.8)',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-white) 96%, transparent)',
              boxShadow: '0 6px 12px rgba(44,56,75,0.10)'
            })}
          >
            <div mix={css({ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0.75rem" })}>
              <div mix={css({ display: "flex", minHeight: "3rem", alignItems: "center", gap: "0.75rem" })}>
                <div mix={css(updating ? { display: "flex", width: "2.5rem", height: "2.5rem", flexShrink: "0", alignItems: "center", justifyContent: "center", borderRadius: "14px", backgroundColor: "var(--color-slate-100)", color: "var(--color-slate-600)" } : { display: "flex", width: "2.5rem", height: "2.5rem", flexShrink: "0", alignItems: "center", justifyContent: "center", borderRadius: "14px", backgroundColor: "var(--color-rose-100)", color: "var(--color-rose-600)" })}>
                  {updating ? <SpinnerIcon /> : <MicIcon />}
                </div>

                <div mix={css({ minWidth: "0rem", flex: "1" })}>
                  <div mix={css({
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    fontSize: '11px',
                    fontWeight: '600',
                    letterSpacing: '0.14em',
                    color: 'var(--color-rose-700)',
                    textTransform: 'uppercase'
                  })}>
                    {captureActive ? <span mix={css({ width: "0.5rem", height: "0.5rem", borderRadius: "calc(infinity * 1px)", backgroundColor: "var(--color-rose-500)" })} aria-hidden="true" /> : null}
                    <span>{dockStatusLabel()}</span>
                  </div>
                  <div mix={css({ marginTop: "0.25rem", display: "flex", minWidth: "0rem", flexWrap: "wrap", alignItems: "center", columnGap: "0.5rem", rowGap: "0.25rem" })}>
                    <span mix={css({
                      minWidth: '0rem',
                      flex: '1',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: '0.875rem',
                      lineHeight: '1.42857143',
                      fontWeight: '500',
                      color: 'var(--color-slate-950)'
                    })}>{request?.contextLabel ?? handle.props.contextLabel ?? 'Handover recording'}</span>
                    <span mix={css({ flexShrink: "0", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-500)" })}>{formatDuration(elapsed)}</span>
                    {captureActive && liveNoise ? <span mix={css({ ...badgeStyles, ...noiseBadgeStyles(liveNoise) })}>
                      <AudioLinesIcon />
                      {noiseBadgeLabel(liveNoise)}
                    </span> : null}
                  </div>
                </div>

                <div mix={css({ display: "flex", flexShrink: "0", alignItems: "center", gap: "0.25rem" })}>
                  {captureActive ? <button
                    type="button"
                    data-testid="recording-stop"
                    aria-label={stopLabel()}
                    mix={[css(dockStopButtonStyles), on('click', () => stopAndSubmit())]}
                  >
                    <span mix={css({ "@media (width >= 40rem)": { display: "none" } })}>Stop</span>
                    <span mix={css({ display: "none", "@media (width >= 40rem)": { display: "inline" } })}>{stopLabel()}</span>
                    <span mix={css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: '0',
                      margin: '-1px',
                      overflow: 'hidden',
                      clipPath: 'inset(50%)',
                      whiteSpace: 'nowrap',
                      borderWidth: '0',
                      '@media (width >= 40rem)': {
                        display: 'none'
                      }
                    })} data-visually-hidden="">{request?.mode === 'extend' ? ' and update' : ' and submit'}</span>
                  </button> : null}
                  {state === 'ready' ? <button
                    type="button"
                    data-testid="recording-retry-upload"
                    mix={[css(dockStopButtonStyles), on('click', () => { void uploadCapturedAudio() })]}
                  >Retry upload</button> : null}
                  <button
                    type="button"

                    aria-label={expanded ? 'Collapse recorder' : 'Expand recorder'}
                    aria-expanded={expanded}
                    mix={[css(dockIconButtonStyles), on('click', () => {
                      expanded = !expanded
                      safeUpdate()
                    })]}
                  >{expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}</button>
                </div>
              </div>

              {showCue ? cueDockPanel() : null}

              {expanded ? <div mix={css({
                display: 'grid',
                gap: '0.75rem',
                borderTopStyle: 'solid',
                borderTopWidth: '1px',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                paddingTop: '0.75rem'
              })}>
                {signOutGuardMessage ? <div role="alert" data-testid="recording-sign-out-message" mix={css({
                  borderRadius: '14px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'var(--color-amber-200)',
                  backgroundColor: 'var(--color-amber-50)',
                  paddingInline: '0.75rem',
                  paddingBlock: '0.5rem',
                  fontSize: '0.875rem',
                  lineHeight: '1.5rem',
                  color: 'var(--color-amber-900)'
                })}>{signOutGuardMessage}</div> : null}
                {updating ? <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>{request?.mode === 'extend'
                  ? 'The recorded continuation is being merged into the current handover state automatically.'
                  : 'The recorded audio is being uploaded automatically so the workflow can continue without reopening the editor.'}</p> : null}
                {state === 'ready' && message ? <div role="alert" mix={css({
                  borderRadius: '14px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'var(--color-amber-200)',
                  backgroundColor: 'var(--color-amber-50)',
                  paddingInline: '0.75rem',
                  paddingBlock: '0.5rem',
                  fontSize: '0.875rem',
                  lineHeight: '1.5rem',
                  color: 'var(--color-amber-900)'
                })}>{message}</div> : null}
                {captureActive ? noiseIndicator(liveNoise, true) : null}
                {captureActive ? <div mix={css({ display: "flex", flexWrap: "wrap", gap: "0.5rem" })}>
                  <button type="button" mix={[css(outlineButtonStyles), on('click', openRecorderSurface)]}><MaximizeIcon dataIcon />Open recorder</button>
                  <button type="button" mix={[css(ghostButtonStyles), on('click', discardActiveRecording)]}><XIcon dataIcon />Discard</button>
                </div> : null}
                {state === 'ready' ? <div mix={css({ display: "flex", flexWrap: "wrap", gap: "0.5rem" })}>
                  <button type="button" data-testid="recording-retry-upload-expanded" mix={[css(primaryButtonStyles), on('click', () => { void uploadCapturedAudio() })]}>Retry upload</button>
                  <button type="button" data-testid="recording-discard-saved" mix={[css(ghostButtonStyles), on('click', () => { void discardSavedRecording() })]}><XIcon dataIcon />Discard saved recording</button>
                </div> : null}
              </div> : null}
            </div>
          </div>
        </aside>
      : null}

      {recorderSurfaceOpen && request?.mode === 'extend' ? <dialog
          aria-labelledby={`${handle.id}-recorder-title`}
          aria-describedby={`${handle.id}-recorder-description`}
          data-testid="extend-handover-surface"
          data-layout="centered-modal"
          mix={[css({
            margin: 'auto',
            maxHeight: 'calc(100dvh - 2rem)',
            width: 'calc(100% - 2rem)',
            maxWidth: '42rem',
            overflowY: 'auto',
            borderRadius: '24px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
            backgroundColor: 'var(--color-white)',
            padding: '0rem',
            color: 'var(--color-slate-950)',
            boxShadow: '0 18px 48px rgba(44,56,75,0.14)',
            outlineStyle: 'none',
            '&::backdrop': {
              backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 35%, transparent)'
            }
          }),
            ref((node) => {
              recorderDialog = node as HTMLDialogElement
              if (!recorderDialog.open) recorderDialog.showModal()
            }),
            on('cancel', (event) => { event.preventDefault(); closeRecorderSurface() }),
            on('click', (event) => { if (event.target === event.currentTarget) closeRecorderSurface() }),
          ]}
        >
          <div mix={css({
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1rem',
            paddingInline: '1.25rem',
            paddingTop: '1.25rem',
            '@media (width >= 40rem)': {
              paddingInline: '1.5rem',
              paddingTop: '1.5rem'
            }
          })}>
            <div>
              <h2 id={`${handle.id}-recorder-title`} mix={css({
                fontFamily: '\'Geist Variable\', sans-serif',
                fontSize: '1.25rem',
                lineHeight: '1.75rem',
                fontWeight: '500',
                letterSpacing: '-0.025em',
                color: 'var(--color-slate-950)'
              })}>Recommence handover</h2>
              <p id={`${handle.id}-recorder-description`} mix={css({
                position: 'absolute',
                width: '1px',
                height: '1px',
                padding: '0',
                margin: '-1px',
                overflow: 'hidden',
                clipPath: 'inset(50%)',
                whiteSpace: 'nowrap',
                borderWidth: '0'
              })} data-visually-hidden="">Saved restart cue and recording controls for continuing this handover.</p>
            </div>
            <button type="button" aria-label="Close" mix={[css({
              display: 'flex',
              width: '2rem',
              height: '2rem',
              flexShrink: '0',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'calc(infinity * 1px)',
              color: 'var(--color-slate-500)',
              transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
              transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
              transitionDuration: '150ms',
              '&:hover': {
                '@media (hover: hover)': {
                  backgroundColor: 'var(--color-slate-100)',
                  color: 'var(--color-slate-900)'
                }
              }
            }), on('click', closeRecorderSurface)]}><XIcon /></button>
          </div>

          <div mix={css({
            display: 'grid',
            gap: '1.25rem',
            paddingInline: '1.25rem',
            paddingTop: '1.25rem',
            paddingBottom: '1.25rem',
            '@media (width >= 40rem)': {
              paddingInline: '1.5rem',
              paddingBottom: '1.5rem'
            }
          })}>
            {signOutGuardMessage ? <div role="alert" data-testid="recording-sign-out-message" mix={css({
              borderRadius: '16px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'var(--color-amber-200)',
              backgroundColor: 'var(--color-amber-50)',
              paddingInline: '0.75rem',
              paddingBlock: '0.5rem',
              fontSize: '0.875rem',
              lineHeight: '1.5rem',
              color: 'var(--color-amber-900)'
            })}>{signOutGuardMessage}</div> : null}
            {state === 'error' && message ? <div role="alert" mix={css({
              borderRadius: '16px',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'var(--color-rose-200)',
              backgroundColor: 'var(--color-rose-50)',
              paddingInline: '0.75rem',
              paddingBlock: '0.5rem',
              fontSize: '0.875rem',
              lineHeight: '1.5rem',
              color: 'var(--color-rose-800)'
            })}><strong mix={css({ display: "block", fontWeight: "500" })}>Recording needs attention</strong>{message}</div> : null}
            {restartCues.length ? <fieldset mix={css({ display: "grid", gap: "0.75rem" })}>
              <legend mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-950)" })}>Where the handover last left off</legend>
              <div mix={css({ display: "grid", gap: "0.75rem" })}>
                {restartCues.map((cue) => <div key={cue.id} mix={css({
                  borderRadius: '20px',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 78%, transparent)',
                  padding: '1rem'
                })}>
                  <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
                    <div>
                      <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{restartCues.length > 1 ? 'Patient restart cue' : 'Restart cue'}</div>
                      <div mix={css({ marginTop: "0.5rem", fontWeight: "500", color: "var(--color-slate-950)" })}>{cue.title}</div>
                      {cue.subtitle ? <div mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-500)" })}>{cue.subtitle}</div> : null}
                    </div>
                    <span mix={css({
                      ...badgeStyles,
                      backgroundColor: 'color-mix(in oklab, var(--color-white) 90%, transparent)',
                      color: 'var(--color-slate-700)',
                      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
                    })}>Last point saved</span>
                  </div>
                  <div mix={css({
                    marginTop: '1rem',
                    borderRadius: '20px',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
                    backgroundColor: 'var(--color-white)',
                    paddingInline: '1rem',
                    paddingBlock: '0.75rem'
                  })}>
                    <div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Last confirmed point</div>
                    <p mix={css({ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-700)" })}>{cue.lastConfirmedPoint}</p>
                  </div>
                </div>)}
              </div>
            </fieldset> : null}

            <div mix={css({ display: "flex", flexDirection: "column", gap: "0.75rem", "@media (width >= 40rem)": { alignItems: "flex-end" } })}>
              {captureActive ? noiseIndicator(liveNoise, false) : null}
              <div mix={css({ display: "flex", flexDirection: "column", gap: "0.5rem", "@media (width >= 40rem)": { flexDirection: "row", justifyContent: "flex-end" } })}>
                {state === 'error' ? <button type="button" mix={[css(primaryButtonStyles), on('click', () => startMicrophone())]}><MicIcon dataIcon />Start recording</button> : null}
                {state === 'requesting' ? <button type="button" mix={css(primaryButtonStyles)} disabled><SpinnerIcon />Starting recorder</button> : null}
                {captureActive ? <button type="button" mix={[css(outlineButtonStyles), on('click', () => {
                  recorderSurfaceOpen = false
                  safeUpdate()
                })]}>Minimize recorder</button> : null}
                {updating ? <button type="button" mix={css(primaryButtonStyles)} disabled><SpinnerIcon />Updating handover</button> : null}
              </div>
              {captureActive ? <div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "500", color: "var(--color-slate-500)" })}>Recording {formatDuration(elapsed)}</div> : null}
            </div>
          </div>
      </dialog> : null}

    </>
  }
})

function recordingRestartCues(request: RecordingRequest): RecordingRestartCue[] {
  if (request.restartCues?.length) return request.restartCues
  if (!request.restartCue) return []
  return [{
    id: `${request.formId}-restart-cue`,
    title: request.restartCueTitle ?? request.contextLabel ?? 'Handover',
    subtitle: request.restartCueSubtitle,
    lastConfirmedPoint: request.restartCue,
  }]
}

function noiseIndicator(snapshot: LiveNoiseSnapshot | null, compact: boolean): RemixNode {
  if (!snapshot) return null
  let toneStyles: Parameters<typeof css>[0] = snapshot.level === 'high' ? {
    borderColor: 'var(--color-rose-200)',
    backgroundColor: 'color-mix(in oklab, var(--color-rose-50) 90%, transparent)',
    color: 'var(--color-rose-700)'
  } : snapshot.level === 'elevated' ? {
    borderColor: 'var(--color-amber-200)',
    backgroundColor: 'color-mix(in oklab, var(--color-amber-50) 90%, transparent)',
    color: 'var(--color-amber-700)'
  } : snapshot.level === 'quiet' ? {
    borderColor: 'var(--color-emerald-200)',
    backgroundColor: 'color-mix(in oklab, var(--color-emerald-50) 90%, transparent)',
    color: 'var(--color-emerald-700)'
  } : {
    borderColor: 'var(--color-slate-200)',
    backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
    color: 'var(--color-slate-700)'
  }
  let level = snapshot.level === 'monitoring' ? 'Monitoring' : snapshot.level === 'high' ? 'High' : snapshot.level === 'elevated' ? 'Elevated' : 'Controlled'

  return <div mix={css({
    borderRadius: '18px',
    borderStyle: 'solid',
    borderWidth: '1px',
    paddingInline: '0.75rem',
    paddingBlock: '0.75rem',
    ...toneStyles
  })}>
    <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" })}>
      <div>
        <div mix={css({ fontSize: "11px", fontWeight: "600", letterSpacing: "0.16em", textTransform: "uppercase" })}>Live noise check</div>
        <div mix={css({
          marginTop: '0.25rem',
          fontWeight: '500',
          ...(compact ? {
            fontSize: '0.875rem',
            lineHeight: '1.42857143'
          } : {
            fontSize: '15px'
          })
        })}>{snapshot.label}</div>
      </div>
      <span mix={css({
        ...badgeStyles,
        backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
        color: 'currentcolor',
        boxShadow: '0 0 0 1px color-mix(in oklab, currentcolor 10%, transparent)'
      })}>{level}</span>
    </div>
    <p mix={css({ marginTop: "0.5rem", lineHeight: "1.5rem", fontSize: compact ? "0.75rem" : "0.875rem" })}>{snapshot.detail}</p>
  </div>
}

function createMonitoringNoiseSnapshot(): LiveNoiseSnapshot {
  return {
    level: 'monitoring',
    label: 'Checking background noise',
    detail: 'Listening for speech and surrounding noise.',
    score: 0,
    speechMarginDb: null,
    userIsSpeaking: false,
  }
}

function createLiveNoiseSnapshot(options: {
  noiseFloor: number
  speechLevel: number
  observedSpeechFrames: number
  userIsSpeaking: boolean
}): LiveNoiseSnapshot {
  if (options.observedSpeechFrames < 3 || options.speechLevel <= 0 || options.noiseFloor <= 0) return createMonitoringNoiseSnapshot()

  let speechMarginDb = 20 * Math.log10(options.speechLevel / options.noiseFloor)
  let score = Math.min(100, Math.max(0, Math.round(((18 - speechMarginDb) / 18) * 100)))
  if (speechMarginDb < 10) return {
    level: 'high',
    label: 'High background noise',
    detail: 'Background noise is high. Try moving closer to the microphone.',
    score,
    speechMarginDb,
    userIsSpeaking: options.userIsSpeaking,
  }
  if (speechMarginDb < 16) return {
    level: 'elevated',
    label: 'Background noise rising',
    detail: 'Background noise may make speech harder to hear clearly.',
    score,
    speechMarginDb,
    userIsSpeaking: options.userIsSpeaking,
  }
  return {
    level: 'quiet',
    label: 'Background noise looks controlled',
    detail: 'Speech sounds clear above background noise.',
    score,
    speechMarginDb,
    userIsSpeaking: options.userIsSpeaking,
  }
}

function computeByteTimeDomainRms(data: ArrayLike<number>) {
  if (!data.length) return 0
  let sumSquares = 0
  for (let index = 0; index < data.length; index++) {
    let normalized = ((data[index] ?? 0) - 128) / 128
    sumSquares += normalized * normalized
  }
  return Math.sqrt(sumSquares / data.length)
}

function noiseBadgeStyles(snapshot: LiveNoiseSnapshot): Parameters<typeof css>[0] {
  if (snapshot.level === 'high') return { backgroundColor: 'var(--color-rose-50)', color: 'var(--color-rose-700)', boxShadow: '0 0 0 1px var(--color-rose-200)' }
  if (snapshot.level === 'elevated') return { backgroundColor: 'var(--color-amber-50)', color: 'var(--color-amber-700)', boxShadow: '0 0 0 1px var(--color-amber-200)' }
  if (snapshot.level === 'quiet') return { backgroundColor: 'var(--color-emerald-50)', color: 'var(--color-emerald-700)', boxShadow: '0 0 0 1px var(--color-emerald-200)' }
  return { backgroundColor: 'var(--color-slate-100)', color: 'var(--color-slate-700)', boxShadow: '0 0 0 1px var(--color-slate-200)' }
}

function noiseBadgeLabel(snapshot: LiveNoiseSnapshot) {
  if (snapshot.level === 'high') return 'High noise'
  if (snapshot.level === 'elevated') return 'Noise rising'
  if (snapshot.level === 'quiet') return 'Noise controlled'
  return 'Checking noise'
}

function dispatchRecordingStatus(detail: RecordingStatusDetail) {
  window.dispatchEvent(new CustomEvent<RecordingStatusDetail>(RECORDING_STATUS_EVENT, { detail }))
}

function cloneFormData(source: FormData) {
  let clone = new FormData()
  for (let [name, value] of source.entries()) clone.append(name, value)
  return clone
}

function formatDuration(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function icon(path: RemixNode) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: '1rem', height: '1rem' })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{path}</svg>
}

function MicIcon(handle: Handle<{ dataIcon?: boolean }>) {
  return () => <svg data-icon={handle.props.dataIcon ? 'inline-start' : undefined} viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="13" x="8" y="2" rx="4" /><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3" /></svg>
}

function AudioLinesIcon() { return () => icon(<><path d="M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3" /></>) }
function ChevronDownIcon() { return () => icon(<path d="m6 9 6 6 6-6" />) }
function ChevronUpIcon() { return () => icon(<path d="m18 15-6-6-6 6" />) }
function MaximizeIcon(handle: Handle<{ dataIcon?: boolean }>) { return () => <svg data-icon={handle.props.dataIcon ? 'inline-start' : undefined} viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg> }
function XIcon(handle: Handle<{ dataIcon?: boolean }>) { return () => <svg data-icon={handle.props.dataIcon ? 'inline-start' : undefined} viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg> }
function SpinnerIcon() { return () => <svg mix={css({ width: "1rem", height: "1rem", animation: "spin 1s linear infinite" })} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg> }

const buttonBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: '0',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: 'var(--radius)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  backgroundClip: 'padding-box',
  paddingInline: '0.625rem',
  fontSize: '0.875rem',
  lineHeight: '1.42857143',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  WebkitUserSelect: 'none',
  userSelect: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  },
  '&:active': {
    '&:not(*[aria-haspopup])': {
      translate: '0 1px'
    }
  },
  '&:disabled': {
    pointerEvents: 'none',
    cursor: 'not-allowed',
    opacity: '50%'
  }
}
const primaryButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
    }
  }
}
const outlineButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  borderColor: 'transparent',
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'var(--muted)',
      color: 'var(--foreground)'
    }
  }
}
const ghostButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  color: 'var(--foreground)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'var(--muted)',
      color: 'var(--foreground)'
    }
  }
}
const dockStopButtonStyles: Parameters<typeof css>[0] = {
  ...primaryButtonStyles,
  height: '2.75rem',
  borderRadius: 'var(--radius)',
  paddingInline: '0.75rem',
  fontSize: '0.875rem',
  lineHeight: '1.42857143'
}
const mobileStopButtonStyles: Parameters<typeof css>[0] = {
  ...primaryButtonStyles,
  height: '2.75rem',
  borderRadius: 'var(--radius)',
  paddingInline: '1rem'
}
const dockIconButtonStyles: Parameters<typeof css>[0] = {
  ...ghostButtonStyles,
  width: '2.75rem',
  height: '2rem',
  borderRadius: 'var(--radius)',
  paddingInline: '0.625rem',
  color: 'var(--color-slate-500)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'var(--color-slate-100)',
      color: 'var(--color-slate-900)'
    }
  }
}
const badgeStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '1.25rem',
  width: 'fit-content',
  flexShrink: '0',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  overflow: 'hidden',
  borderRadius: 'calc(var(--radius) * 2.6)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  paddingInline: '0.5rem',
  paddingBlock: '0.125rem',
  fontSize: '0.75rem',
  lineHeight: '1.33333333',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  boxShadow: '0 0 0 1px currentcolor',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms'
}
