import * as assert from 'remix/assert'
import { afterEach, beforeEach, describe, it } from 'remix/test'
import { render, type RenderResult } from 'remix/component/test'

import { PatientHandoverDialog } from '../../app/assets/patient-handover-dialog.tsx'
import { NewHandoverForm } from '../../app/assets/new-handover-form.tsx'
import {
  RECORDING_STATUS_EVENT,
  requestPersistentRecording,
  type RecordingStatusDetail,
} from '../../app/assets/recording-events.ts'
import {
  appendPendingRecordingChunk,
  createPendingRecordingUpload,
  createRecordingUploadId,
  deletePendingRecordingUpload,
  loadPendingRecordingUploads,
  pendingRecordingRecoveryTtlMs,
  savePendingRecordingUpload,
} from '../../app/assets/pending-recording-upload.ts'
import { AppShell, WorkspaceSurface } from '../../app/ui/index.ts'
import {
  frameMutationLocationHeader,
  frameMutationRequestHeader,
  frameMutationRequestValue,
} from '../../app/utils/frame-mutation.ts'
import { routes } from '../../app/routes.ts'
import { computedStyle } from './styles.ts'

const createHandoverAction = routes.actions.createHandover.href()
const extendHandoverAction = routes.actions.extendHandover.href({ handoverId: 'h1' })
const shiftSelectionHref = routes.workspace.shiftSelection.href()
const individualHref = routes.workspace.individual.href()
const inboxHref = routes.workspace.inbox.href()
const signInHref = routes.auth.signIn.index.href()
const signOutAction = routes.auth.signOut.href()

describe('persistent recorder lifecycle', () => {
  beforeEach(async () => {
    await clearPendingUploads()
    localStorage.clear()
  })

  afterEach(async () => {
    await waitForRecordingLockRelease('user-1')
    await clearPendingUploads()
    localStorage.clear()
  })

  it('reconstructs an interrupted capture from append-only browser chunks', async () => {
    let upload = createPendingRecordingUpload({
      formId: 'chunked-handover',
      submitAction: createHandoverAction,
      formData: new FormData(),
    }, new Blob([], { type: 'audio/webm' }), 'audio/webm', 'user-1', false)
    await appendPendingRecordingChunk(upload, new Blob(['first-']), 0)
    await appendPendingRecordingChunk(upload, new Blob(['second']), 1)

    let [recovered] = await loadPendingRecordingUploads()
    assert.equal(recovered?.ownerUserId, 'user-1')
    assert.equal(await recovered?.audio.text(), 'first-second')
  })

  it('purges expired clinical recording recovery blobs and their chunks', async () => {
    let upload = createPendingRecordingUpload({
      formId: 'expired-handover',
      submitAction: createHandoverAction,
      formData: new FormData(),
    }, new Blob([], { type: 'audio/webm' }), 'audio/webm', 'user-1', false)
    await appendPendingRecordingChunk(upload, new Blob(['clinical audio']), 0)

    assert.deepEqual(await loadPendingRecordingUploads(upload.updatedAt + pendingRecordingRecoveryTtlMs + 1), [])
    assert.equal(await pendingUploadRecordCount(), 0)
  })

  it('creates a standards-compliant UUID when crypto.randomUUID is unavailable', () => {
    let descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined })
    try {
      let id = createRecordingUploadId()
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    } finally {
      if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor)
      else Reflect.deleteProperty(crypto, 'randomUUID')
    }
  })

  it('purges ownerless version-one recordings during storage upgrade', async () => {
    await seedLegacyVersionOneRecording()

    assert.deepEqual(await loadPendingRecordingUploads(), [])
    assert.equal(await pendingUploadRecordCount(), 0)
  })

  it('keeps a patient recording after the dialog closes and stops by submitting it', async () => {
    let harness = installRecorderHarness()
    let result = render(<AppShell
      currentUserId="user-1"
      mode="shift"
      homeHref={shiftSelectionHref}
      switchHref={individualHref}
      inboxHref={inboxHref}
      inboxCount={0}
      signInHref={signInHref}
      signOutAction={signOutAction}
      csrfToken="csrf"
    >
      <PatientHandoverDialog
        action={createHandoverAction}
        uploadAction="/actions/handovers/upload"
        csrfToken="csrf"
        direction="incoming"
        patient={{ key: 'arthur-dent', displayName: 'Arthur Dent', location: 'Bed 4' }}
        shift={{ id: 'shift-1', title: 'Morning', department: 'Medicine' }}
      />
    </AppShell>)

    try {
      await result.act(() => result.$('button[aria-haspopup="dialog"]')?.click())
      assert.equal(result.$('[data-testid="patient-handover-dialog"]')?.tagName, 'DIALOG')
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="patient-handover-dialog"]') === null
        && result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')

      assert.equal(result.$('[data-testid="patient-handover-dialog"]'), null)
      assert.equal(result.$('[data-testid="recording-dock"]')?.getAttribute('data-state'), 'recording')
      assert.equal(result.$('[data-testid="recording-stop"]')?.getAttribute('aria-label'), 'Stop and submit')

      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await settle(result)
      await waitFor(() => harness.uploads.length === 1)
      await waitFor(() => result.$('[data-testid="recording-dock"]') === null)

      assert.equal(harness.uploads.length, 1)
      let body = harness.uploads[0]?.body
      assert.ok(body instanceof FormData)
      assert.equal(body.get('linkedPatientKey'), 'arthur-dent')
      assert.equal(body.get('consentMode'), 'agreed')
      assert.equal(body.get('_csrf'), 'csrf')
      assert.ok(body.get('audio') instanceof Blob)
      assert.equal(typeof body.get('recordingUploadId'), 'string')
      assert.equal(harness.uploads[0]?.headers.get(frameMutationRequestHeader), frameMutationRequestValue)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('cancels a pending microphone request when patient setup is closed', async () => {
    let harness = installRecorderHarness({ deferMicrophone: true })
    let result = render(<AppShell
      currentUserId="user-1"
      mode="shift"
      homeHref={shiftSelectionHref}
      switchHref={individualHref}
      inboxHref={inboxHref}
      inboxCount={0}
      signInHref={signInHref}
      signOutAction={signOutAction}
    >
      <PatientHandoverDialog
        action={createHandoverAction}
        direction="incoming"
        patient={{ key: 'trillian', displayName: 'Trillian', location: 'Bed 7' }}
        shift={{ id: 'shift-1', title: 'Morning', department: 'Medicine' }}
      />
    </AppShell>)

    try {
      await result.act(() => result.$('button[aria-haspopup="dialog"]')?.click())
      await agreeToConsent(result)
      await result.act(() => result.$('[data-testid="recording-start"]')?.click())
      await waitFor(() => harness.microphoneRequests() === 1)

      let dialog = result.$('[data-testid="patient-handover-dialog"]')
      await result.act(() => dialog?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click())
      assert.equal(result.$('[data-testid="patient-handover-dialog"]'), null)

      harness.resolveMicrophone()
      await waitFor(() => harness.trackStopped())
      await settle(result)

      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.equal(harness.uploads.length, 0)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('stops and submits an active recording when the page is hidden', async () => {
    let harness = installRecorderHarness()
    let visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      assert.equal(result.$('[data-testid="recording-dock"]')?.getAttribute('data-state'), 'recording')

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      await result.act(() => document.dispatchEvent(new Event('visibilitychange')))
      await settle(result)
      await waitFor(() => harness.uploads.length === 1)
      await waitFor(() => result.$('[data-testid="recording-dock"]') === null)

      assert.equal(harness.uploads.length, 1)
      assert.equal(harness.uploads[0]?.keepalive, undefined)
    } finally {
      if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor)
      else Reflect.deleteProperty(document, 'visibilityState')
      result.cleanup()
      harness.restore()
    }
  })

  it('persists page-exit audio and retries it on the next shell mount without keepalive', async () => {
    let harness = installRecorderHarness()
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')

      await result.act(() => window.dispatchEvent(new Event('pagehide')))
      await settle(result)

      await waitFor(async () => (await loadPendingRecordingUploads()).length === 1)
      assert.equal(harness.uploads.length, 0)

      result.cleanup()
      await waitForRecordingLockRelease('user-1')
      result = renderShellComposer()
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)
      assert.equal(harness.uploads.length, 0)
      await result.act(() => result.$('[data-testid="recording-retry-upload"]')?.click())
      await waitFor(() => harness.uploads.length === 1)

      assert.equal(harness.uploads[0]?.keepalive, undefined)
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 0)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('protects captured audio when the shell client entry is removed', async () => {
    let harness = installRecorderHarness()
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      assert.equal(result.$('[data-testid="recording-dock"]')?.getAttribute('data-state'), 'recording')

      result.cleanup()

      await waitFor(async () => (await loadPendingRecordingUploads()).length === 1)
      assert.equal(harness.uploads.length, 0)

      result = renderShellComposer()
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)
      assert.equal(harness.uploads.length, 0)
      await result.act(() => result.$('[data-testid="recording-retry-upload"]')?.click())
      await waitFor(() => harness.uploads.length === 1)
      assert.equal(harness.uploads.length, 1)
      assert.equal(harness.uploads[0]?.keepalive, undefined)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('matches the expandable recommence dock and reopens the full recorder surface', async () => {
    let harness = installRecorderHarness()
    let result = render(<AppShell
      currentUserId="user-1"
      mode="individual"
      homeHref={individualHref}
      switchHref={shiftSelectionHref}
      inboxHref={inboxHref}
      inboxCount={0}
      signInHref={signInHref}
      signOutAction={signOutAction}
      csrfToken="csrf"
    >
      <WorkspaceSurface><div>Review workspace</div></WorkspaceSurface>
    </AppShell>)

    try {
      let accepted = false
      await result.act(() => {
        accepted = requestPersistentRecording({
          formId: 'recommence-h1',
          submitAction: extendHandoverAction,
          contextLabel: 'Arthur Dent handover',
          mode: 'extend',
          restartCue: 'Repeat observations are due at 16:00.',
          restartCueTitle: 'Arthur Dent',
          restartCueSubtitle: 'Bed 12',
          restartCues: [
            { id: 'arthur', title: 'Arthur Dent', subtitle: 'Bed 12', lastConfirmedPoint: 'Repeat observations are due at 16:00.' },
            { id: 'mary', title: 'Mary Jones', subtitle: 'Bed 14', lastConfirmedPoint: 'Transfer planning resumed after interruption.' },
          ],
          formData: new FormData(),
        })
      })
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')

      assert.equal(accepted, true)
      let dock = result.$('[data-testid="recording-dock"]')
      assert.equal(dock?.getAttribute('data-layout'), 'compact')
      assert.match(dock?.textContent ?? '', /Recording live/)
      assert.match(dock?.textContent ?? '', /Arthur Dent handover/)
      assert.match(dock?.textContent ?? '', /00:00/)
      assert.equal((dock?.textContent ?? '').includes('Transfer planning resumed after interruption.'), false)
      assert.ok(dock?.querySelector('button[aria-label="Expand recorder"]'))
      assert.equal(dock?.querySelector('button')?.textContent?.includes('Open recorder'), false)

      await result.act(() => dock?.querySelector<HTMLButtonElement>('button[aria-label="Expand recorder"]')?.click())
      dock = result.$('[data-testid="recording-dock"]')
      assert.equal(dock?.getAttribute('data-layout'), 'expanded')
      assert.match(dock?.textContent ?? '', /Live noise check/)
      assert.ok(Array.from(dock?.querySelectorAll('button') ?? []).some((button) => button.textContent?.includes('Open recorder')))
      assert.ok(Array.from(dock?.querySelectorAll('button') ?? []).some((button) => button.textContent?.includes('Discard')))

      let openRecorder = Array.from(dock?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Open recorder'))
      await result.act(() => openRecorder?.click())
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      let surface = result.$('[data-testid="extend-handover-surface"]')
      assert.ok(surface)
      assert.equal(surface.tagName, 'DIALOG')
      assert.match(surface.textContent ?? '', /Where the handover last left off/)
      assert.match(surface.textContent ?? '', /Arthur Dent/)
      assert.match(surface.textContent ?? '', /Bed 12/)
      assert.match(surface.textContent ?? '', /Mary Jones/)
      assert.match(surface.textContent ?? '', /Transfer planning resumed after interruption\./)
      assert.match(surface.textContent ?? '', /Repeat observations are due at 16:00\./)
      assert.match(surface.textContent ?? '', /Live noise check/)

      let minimize = Array.from(surface.querySelectorAll('button')).find((button) => button.textContent?.includes('Minimize recorder'))
      await result.act(() => minimize?.click())
      dock = result.$('[data-testid="recording-dock"]')
      assert.equal(dock?.getAttribute('data-layout'), 'expanded')

      let discard = Array.from(dock?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('Discard'))
      await result.act(() => discard?.click())
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.equal(harness.uploads.length, 0)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('does not transfer a releasing discard lock to a new recording', async () => {
    let harness = installRecorderHarness()
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      let dock = result.$('[data-testid="recording-dock"]')
      await result.act(() => dock?.querySelector<HTMLButtonElement>('button[aria-label="Expand recorder"]')?.click())
      let discard = Array.from(result.$('[data-testid="recording-dock"]')?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.trim() === 'Discard')
      let acceptedDuringDiscard = true
      await result.act(() => {
        discard?.click()
        acceptedDuringDiscard = requestPersistentRecording({
          formId: 'too-early-recording',
          submitAction: createHandoverAction,
          contextLabel: 'Too early recording',
          formData: new FormData(),
        })
      })
      assert.equal(acceptedDuringDiscard, false)

      await waitFor(() => result.$('[data-testid="recording-dock"]') === null)
      await waitForRecordingLockRelease('user-1')
      let acceptedAfterRelease = false
      await result.act(() => {
        acceptedAfterRelease = requestPersistentRecording({
          formId: 'after-discard-recording',
          submitAction: createHandoverAction,
          contextLabel: 'After discard recording',
          formData: new FormData(),
        })
      })
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      assert.equal(acceptedAfterRelease, true)
      assert.match(result.$('[data-testid="recording-dock"]')?.textContent ?? '', /After discard recording/)
      await result.act(() => result.$('[data-testid="recording-dock"] button[aria-label="Expand recorder"]')?.click())
      let finalDiscard = Array.from(result.$('[data-testid="recording-dock"]')?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.trim() === 'Discard')
      await result.act(() => finalDiscard?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]') === null)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('uses the cue-first compact recommence dock on mobile and reserves the workspace', async () => {
    let harness = installRecorderHarness()
    let innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    let result = render(<AppShell
      currentUserId="user-1"
      mode="individual"
      homeHref={individualHref}
      switchHref={shiftSelectionHref}
      inboxHref={inboxHref}
      inboxCount={0}
      signInHref={signInHref}
      signOutAction={signOutAction}
    >
      <WorkspaceSurface><div>Review workspace</div></WorkspaceSurface>
    </AppShell>)

    try {
      await result.act(() => {
        requestPersistentRecording({
          formId: 'mobile-recommence-h1',
          submitAction: extendHandoverAction,
          contextLabel: 'Arthur Dent handover',
          mode: 'extend',
          restartCue: 'Repeat observations are due at 16:00.',
          formData: new FormData(),
        })
      })
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')

      let dock = result.$('[data-testid="recording-dock"]')
      let workspace = result.$('[data-recording-reserve]')
      let wideLayout = window.matchMedia('(min-width: 40rem)').matches
      assert.equal(dock?.getAttribute('data-layout'), 'mobile-extend-cue')
      assert.ok(dock && dock.parentElement)
      assert.ok(dock.getBoundingClientRect().width > 0)
      assert.equal(dock.getBoundingClientRect().width, dock.parentElement.getBoundingClientRect().width)
      assert.equal(workspace?.getAttribute('data-recording-reserve'), 'recommence-cue')
      assert.equal(computedStyle(workspace).paddingBottom, wideLayout ? '224px' : '256px')
      assert.equal(Array.from(dock?.querySelectorAll('button') ?? []).some((button) => button.textContent?.includes('Discard')), false)

      await result.act(() => dock?.querySelector<HTMLButtonElement>('button[aria-label="Hide restart cue"]')?.click())
      dock = result.$('[data-testid="recording-dock"]')
      workspace = result.$('[data-recording-reserve]')
      assert.equal(dock?.getAttribute('data-layout'), 'mobile-extend-compact')
      assert.equal(workspace?.getAttribute('data-recording-reserve'), 'recording')
      assert.equal(computedStyle(workspace).paddingBottom, wideLayout ? '176px' : '160px')

      await result.act(() => dock?.querySelector<HTMLButtonElement>('button[aria-label="Expand recorder"]')?.click())
      dock = result.$('[data-testid="recording-dock"]')
      assert.equal(dock?.getAttribute('data-layout'), 'mobile-extend-expanded')
      assert.ok(Array.from(dock?.querySelectorAll('button') ?? []).some((button) => button.textContent?.includes('Open recorder')))
      assert.ok(Array.from(dock?.querySelectorAll('button') ?? []).some((button) => button.textContent?.includes('Discard')))
    } finally {
      result.cleanup()
      harness.restore()
      if (innerWidthDescriptor) Object.defineProperty(window, 'innerWidth', innerWidthDescriptor)
      else Reflect.deleteProperty(window, 'innerWidth')
    }
  })

  it('hides a failed microphone start, reports the error, and accepts a retry', async () => {
    let harness = installRecorderHarness({ microphoneFailures: 1 })
    let statuses: RecordingStatusDetail[] = []
    let onStatus = (event: Event) => statuses.push((event as CustomEvent<RecordingStatusDetail>).detail)
    window.addEventListener(RECORDING_STATUS_EVENT, onStatus)
    let result = renderShellComposer()

    try {
      let request = () => requestPersistentRecording({
        formId: 'retry-recommence-h1',
        submitAction: extendHandoverAction,
        contextLabel: 'Arthur Dent handover',
        mode: 'extend',
        restartCue: 'Repeat observations are due at 16:00.',
        formData: new FormData(),
      })
      let firstAccepted = false
      await result.act(() => { firstAccepted = request() })
      await waitFor(() => statuses.at(-1)?.status === 'error')
      assert.equal(firstAccepted, true)
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.equal(statuses.at(-1)?.status, 'error')
      assert.match(statuses.at(-1)?.message ?? '', /Microphone access failed/)
      assert.equal(result.$('[data-sonner-toast="true"]'), null)

      let retryAccepted = false
      await result.act(() => { retryAccepted = request() })
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      assert.equal(retryAccepted, true)
      assert.equal(result.$('[data-testid="recording-dock"]')?.getAttribute('data-state'), 'recording')
    } finally {
      window.removeEventListener(RECORDING_STATUS_EVENT, onStatus)
      result.cleanup()
      harness.restore()
    }
  })

  it('keeps the create-form recording button available after microphone failure', async () => {
    let harness = installRecorderHarness({ microphoneFailures: 1 })
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-testid="recording-start"]')?.click())
      await waitFor(() => (result.$('[role="alert"]')?.textContent ?? '').includes('Microphone access failed'))

      let retry = result.$('[data-testid="recording-start"]') as HTMLButtonElement
      assert.equal(retry.disabled, false)
      assert.equal(retry.textContent?.includes('Start recording'), true)

      await result.act(() => retry.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('reopens the recommence surface when the stopped recording is empty', async () => {
    let harness = installRecorderHarness({ emptyAudio: true })
    let result = renderShellComposer()

    try {
      await result.act(() => {
        requestPersistentRecording({
          formId: 'empty-recommence-h1',
          submitAction: extendHandoverAction,
          contextLabel: 'Arthur Dent handover',
          mode: 'extend',
          restartCue: 'Repeat observations are due at 16:00.',
          formData: new FormData(),
        })
      })
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await waitFor(() => result.$('[data-testid="extend-handover-surface"]') !== null)

      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      let surface = result.$('[data-testid="extend-handover-surface"]')
      assert.ok(surface)
      assert.match(result.container.textContent ?? '', /The recording was empty\. Please try again\./)
      assert.equal(result.$('[data-sonner-toast="true"]'), null)
      assert.ok(Array.from(surface.querySelectorAll('button')).some((button) => button.textContent?.includes('Start recording')))
      assert.equal(harness.uploads.length, 0)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('releases an empty create recording so the clinician can retry', async () => {
    let harness = installRecorderHarness({ emptyAudio: true })
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-testid="recording-start"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await waitFor(() => (result.$('[role="alert"]')?.textContent ?? '').includes('The recording was empty'))

      let retry = result.$('[data-testid="recording-start"]') as HTMLButtonElement
      assert.equal(retry.disabled, false)
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.equal(harness.uploads.length, 0)

      await result.act(() => retry.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('retains a failed continuation upload and exposes an explicit retry', async () => {
    let harness = installRecorderHarness({ uploadStatus: 503 })
    let result = renderShellComposer()

    try {
      await result.act(() => {
        requestPersistentRecording({
          formId: 'failed-upload-recommence-h1',
          submitAction: extendHandoverAction,
          contextLabel: 'Arthur Dent handover',
          mode: 'extend',
          restartCue: 'Repeat observations are due at 16:00.',
          formData: new FormData(),
        })
      })
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await settle(result)
      await waitFor(() => harness.uploads.length === 1)

      assert.equal(harness.uploads.length, 1)
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'ready')
      let dock = result.$('[data-testid="recording-dock"]')
      assert.ok(dock)
      assert.match(dock.textContent ?? '', /recording is saved in this browser/i)
      assert.equal(result.$('[data-sonner-toast="true"]'), null)
      assert.ok(dock.querySelector('[data-testid="recording-retry-upload"]'))
      assert.equal((await loadPendingRecordingUploads()).length, 1)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('retries the preserved audio without asking the clinician to record again', async () => {
    let harness = installRecorderHarness({ uploadStatuses: [503, 204] })
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await waitFor(() => harness.uploads.length === 1)
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)

      await result.act(() => result.$('[data-testid="recording-retry-upload"]')?.click())
      await waitFor(() => harness.uploads.length === 2)
      await waitFor(() => result.$('[data-testid="recording-dock"]') === null)

      assert.ok(harness.uploads.every((upload) => upload.keepalive === undefined))
      assert.ok(harness.uploads.every((upload) => upload.body instanceof FormData && upload.body.get('audio') instanceof Blob))
      assert.equal((await loadPendingRecordingUploads()).length, 0)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('retains audio when an expired session redirects the upload to sign in', async () => {
    let harness = installRecorderHarness({ redirectToSignIn: true })
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await waitFor(() => harness.uploads.length === 1)
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)

      assert.equal((await loadPendingRecordingUploads()).length, 1)
      assert.match(result.$('[data-testid="recording-dock"]')?.textContent ?? '', /upload did not complete/i)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('retains audio when the Frame mutation location redirects to sign in', async () => {
    let harness = installRecorderHarness({
      mutationLocation: `${signInHref}?returnTo=${encodeURIComponent(individualHref)}`,
    })
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-testid="recording-start"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      await result.act(() => result.$('[data-testid="recording-stop"]')?.click())
      await waitFor(() => harness.uploads.length === 1)
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)

      assert.equal((await loadPendingRecordingUploads()).length, 1)
      assert.match(result.$('[data-testid="recording-dock"]')?.textContent ?? '', /upload did not complete/i)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('discards a recovered recording and removes its browser copy', async () => {
    let harness = installRecorderHarness()
    let request = new FormData()
    request.set('title', 'Night handover')
    await savePendingRecordingUpload(createPendingRecordingUpload({
      formId: 'saved-handover',
      submitAction: createHandoverAction,
      uploadAction: '/actions/handovers/upload',
      contextLabel: 'Saved handover',
      formData: request,
    }, new Blob(['saved-audio'], { type: 'audio/webm' }), 'audio/webm', 'user-1'))
    let result = renderShellComposer()

    try {
      await waitFor(() => result.$('[data-testid="recording-discard-saved"]') !== null)
      await result.act(() => result.$('[data-testid="recording-discard-saved"]')?.click())
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 0)

      assert.equal(harness.uploads.length, 0)
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('surfaces pending recordings sequentially after each successful retry', async () => {
    let harness = installRecorderHarness()
    let first = createPendingRecordingUpload({
      formId: 'first-queued-handover',
      submitAction: createHandoverAction,
      uploadAction: '/actions/handovers/upload',
      contextLabel: 'First queued handover',
      formData: new FormData(),
    }, new Blob(['first-audio'], { type: 'audio/webm' }), 'audio/webm', 'user-1')
    let second = createPendingRecordingUpload({
      formId: 'second-queued-handover',
      submitAction: createHandoverAction,
      uploadAction: '/actions/handovers/upload',
      contextLabel: 'Second queued handover',
      formData: new FormData(),
    }, new Blob(['second-audio'], { type: 'audio/webm' }), 'audio/webm', 'user-1')
    first.createdAt = 1
    second.createdAt = 2
    await savePendingRecordingUpload(first)
    await savePendingRecordingUpload(second)
    let result = renderShellComposer()

    try {
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)
      assert.match(result.$('[data-testid="recording-dock"]')?.textContent ?? '', /First queued handover/)
      await result.act(() => result.$('[data-testid="recording-retry-upload"]')?.click())
      await waitFor(() => harness.uploads.length === 1)
      await waitFor(() => (result.$('[data-testid="recording-dock"]')?.textContent ?? '').includes('Second queued handover'))
      assert.equal((await loadPendingRecordingUploads()).length, 1)

      await result.act(() => result.$('[data-testid="recording-retry-upload"]')?.click())
      await waitFor(() => harness.uploads.length === 2)
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 0)
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.deepEqual(harness.uploads.map((upload) => (upload.body as FormData).get('recordingUploadId')), [first.id, second.id])
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('surfaces the next pending recording after an explicit discard', async () => {
    let harness = installRecorderHarness()
    for (let [index, label] of ['First saved handover', 'Second saved handover'].entries()) {
      let upload = createPendingRecordingUpload({
        formId: `discard-queue-${index}`,
        submitAction: createHandoverAction,
        uploadAction: '/actions/handovers/upload',
        contextLabel: label,
        formData: new FormData(),
      }, new Blob([`saved-audio-${index}`], { type: 'audio/webm' }), 'audio/webm', 'user-1')
      upload.createdAt = index + 1
      await savePendingRecordingUpload(upload)
    }
    let result = renderShellComposer()

    try {
      await waitFor(() => (result.$('[data-testid="recording-dock"]')?.textContent ?? '').includes('First saved handover'))
      await result.act(() => result.$('[data-testid="recording-discard-saved"]')?.click())
      await waitFor(() => (result.$('[data-testid="recording-dock"]')?.textContent ?? '').includes('Second saved handover'))
      assert.equal((await loadPendingRecordingUploads()).length, 1)
      await result.act(() => result.$('[data-testid="recording-discard-saved"]')?.click())
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 0)
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.equal(harness.uploads.length, 0)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('does not expose or upload another signed-in user’s pending recording', async () => {
    let harness = installRecorderHarness()
    await savePendingRecordingUpload(createPendingRecordingUpload({
      formId: 'user-one-handover',
      submitAction: createHandoverAction,
      uploadAction: '/actions/handovers/upload',
      contextLabel: 'User one handover',
      formData: new FormData(),
    }, new Blob(['private-audio'], { type: 'audio/webm' }), 'audio/webm', 'user-1'))
    let result = renderShellComposer('user-2')

    try {
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(harness.uploads.length, 0)
      assert.equal(result.$('[data-testid="recording-dock"]'), null)
      assert.equal((await loadPendingRecordingUploads()).length, 1)
    } finally {
      result.cleanup()
      harness.restore()
    }
  })

  it('blocks sign out while another tab owns the current user recording lock', async () => {
    let harness = installRecorderHarness()
    let originalSubmit = HTMLFormElement.prototype.submit
    let submitted = false
    HTMLFormElement.prototype.submit = function () { submitted = true }
    let releaseOtherTab!: () => void
    let otherTabReady!: () => void
    let ready = new Promise<void>((resolve) => { otherTabReady = resolve })
    let hold = new Promise<void>((resolve) => { releaseOtherTab = resolve })
    let otherTab = navigator.locks.request('handover-recording-user:user-1', async () => {
      otherTabReady()
      await hold
    })
    await ready
    let result = renderShellComposer()

    try {
      let signOutForm = result.$(`form[action="${signOutAction}"]`) as HTMLFormElement
      await result.act(() => signOutForm.requestSubmit())
      await waitFor(() => result.$('[data-testid="recording-sign-out-message"]') !== null)

      assert.equal(submitted, false)
      assert.match(result.$('[data-testid="recording-sign-out-message"]')?.textContent ?? '', /another app tab/i)
    } finally {
      releaseOtherTab()
      await otherTab
      HTMLFormElement.prototype.submit = originalSubmit
      result.cleanup()
      harness.restore()
    }
  })

  it('blocks sign out until an active recording is explicitly discarded', async () => {
    let harness = installRecorderHarness()
    let originalSubmit = HTMLFormElement.prototype.submit
    let submitted = false
    HTMLFormElement.prototype.submit = function () { submitted = true }
    let result = renderShellComposer()

    try {
      await agreeToConsent(result)
      await result.act(() => result.$('[data-analytics-id="handover-start-recording"]')?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]')?.getAttribute('data-state') === 'recording')
      assert.equal(result.$('[data-testid="recording-dock"]')?.getAttribute('data-state'), 'recording')
      await savePendingRecordingUpload(createPendingRecordingUpload({
        formId: 'earlier-sign-out-handover',
        submitAction: createHandoverAction,
        uploadAction: '/actions/handovers/upload',
        formData: new FormData(),
      }, new Blob(['private-audio'], { type: 'audio/webm' }), 'audio/webm', 'user-1'))

      let signOutForm = result.$(`form[action="${signOutAction}"]`) as HTMLFormElement
      assert.equal(new FormData(signOutForm).get('_csrf'), 'csrf')
      await result.act(() => signOutForm.requestSubmit())
      await settle(result)

      assert.equal(submitted, false)
      assert.equal(harness.trackStopped(), false)
      assert.equal(result.$('[data-testid="recording-dock"]')?.getAttribute('data-state'), 'recording')
      assert.match(result.$('[data-testid="recording-sign-out-message"]')?.textContent ?? '', /explicitly discard/i)

      let discard = Array.from(result.$('[data-testid="recording-dock"]')?.querySelectorAll('button') ?? [])
        .find((button) => button.textContent?.trim() === 'Discard')
      await result.act(() => discard?.click())
      await waitFor(() => result.$('[data-testid="recording-dock"]') === null)
      await result.act(() => signOutForm.requestSubmit())
      await waitFor(() => result.$('[data-testid="recording-discard-saved"]') !== null)

      assert.equal(submitted, false)
      assert.equal((await loadPendingRecordingUploads()).length, 1)
      await result.act(() => result.$('[data-testid="recording-discard-saved"]')?.click())
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 0)
      await result.act(() => signOutForm.requestSubmit())
      await waitFor(() => submitted)
      assert.equal(harness.uploads.length, 0)
      assert.equal(harness.trackStopped(), true)
    } finally {
      HTMLFormElement.prototype.submit = originalSubmit
      result.cleanup()
      harness.restore()
    }
  })

  it('blocks sign out until a recovered recording is retried or discarded', async () => {
    let harness = installRecorderHarness()
    let originalSubmit = HTMLFormElement.prototype.submit
    let submitted = false
    HTMLFormElement.prototype.submit = function () { submitted = true }
    await savePendingRecordingUpload(createPendingRecordingUpload({
      formId: 'recovered-sign-out-handover',
      submitAction: createHandoverAction,
      uploadAction: '/actions/handovers/upload',
      formData: new FormData(),
    }, new Blob(['private-audio'], { type: 'audio/webm' }), 'audio/webm', 'user-1'))
    let result = renderShellComposer()

    try {
      await waitFor(() => result.$('[data-testid="recording-retry-upload"]') !== null)
      let signOutForm = result.$(`form[action="${signOutAction}"]`) as HTMLFormElement
      await result.act(() => signOutForm.requestSubmit())
      await settle(result)

      assert.equal(submitted, false)
      assert.match(result.$('[data-testid="recording-sign-out-message"]')?.textContent ?? '', /retry the saved recording/i)
      await result.act(() => result.$('[data-testid="recording-discard-saved"]')?.click())
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 0)
      await result.act(() => signOutForm.requestSubmit())
      await waitFor(() => submitted)
    } finally {
      HTMLFormElement.prototype.submit = originalSubmit
      result.cleanup()
      harness.restore()
    }
  })

  it('surfaces idle pending audio instead of deleting it during sign out', async () => {
    let harness = installRecorderHarness()
    let originalSubmit = HTMLFormElement.prototype.submit
    let submitted = false
    HTMLFormElement.prototype.submit = function () { submitted = true }
    let result = renderShellComposer()

    try {
      await settle(result)
      await new Promise((resolve) => setTimeout(resolve, 25))
      for (let ownerUserId of ['user-1', 'user-2']) {
        await savePendingRecordingUpload(createPendingRecordingUpload({
          formId: `${ownerUserId}-stale-handover`,
          submitAction: createHandoverAction,
          uploadAction: '/actions/handovers/upload',
          formData: new FormData(),
        }, new Blob([`${ownerUserId}-audio`], { type: 'audio/webm' }), 'audio/webm', ownerUserId))
      }

      let signOutForm = result.$(`form[action="${signOutAction}"]`) as HTMLFormElement
      await result.act(() => signOutForm.requestSubmit())
      await waitFor(() => result.$('[data-testid="recording-discard-saved"]') !== null)

      let uploads = await loadPendingRecordingUploads()
      assert.equal(submitted, false)
      assert.deepEqual(uploads.map((upload) => upload.ownerUserId).sort(), ['user-1', 'user-2'])
      assert.match(result.$('[data-testid="recording-sign-out-message"]')?.textContent ?? '', /retry this saved recording/i)

      await result.act(() => result.$('[data-testid="recording-discard-saved"]')?.click())
      await waitFor(async () => (await loadPendingRecordingUploads()).length === 1)
      await result.act(() => signOutForm.requestSubmit())
      await waitFor(() => submitted)
      uploads = await loadPendingRecordingUploads()
      assert.deepEqual(uploads.map((upload) => upload.ownerUserId), ['user-2'])
      assert.equal(harness.uploads.length, 0)
    } finally {
      HTMLFormElement.prototype.submit = originalSubmit
      result.cleanup()
      harness.restore()
    }
  })

})

function renderShellComposer(currentUserId = 'user-1') {
  return render(<AppShell
    currentUserId={currentUserId}
    mode="individual"
    homeHref={individualHref}
    switchHref={shiftSelectionHref}
    inboxHref={inboxHref}
    inboxCount={0}
    signInHref={signInHref}
    signOutAction={signOutAction}
    csrfToken="csrf"
  >
    <NewHandoverForm
      action={createHandoverAction}
      uploadAction="/actions/handovers/upload"
      csrfToken="csrf"
      mode="individual"
      defaultDepartment="Medicine"
      presentation="inline"
    />
  </AppShell>)
}

async function clearPendingUploads() {
  for (let upload of await loadPendingRecordingUploads()) {
    await deletePendingRecordingUpload(upload.id)
  }
}

async function agreeToConsent(result: RenderResult) {
  let consent = result.$('[data-testid="handover-consent"]') as HTMLInputElement
  consent.checked = true
  await result.act(() => consent.dispatchEvent(new Event('change', { bubbles: true })))
}

async function settle(result: RenderResult) {
  await Promise.resolve()
  await result.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  let deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for recorder state.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitForRecordingLockRelease(userId: string) {
  if (!navigator.locks) return
  await waitFor(async () => {
    let available = false
    await navigator.locks.request(`handover-recording-user:${userId}`, { ifAvailable: true }, (lock) => {
      available = Boolean(lock)
    })
    return available
  })
}

function installRecorderHarness(options: {
  microphoneFailures?: number
  deferMicrophone?: boolean
  emptyAudio?: boolean
  uploadStatus?: number
  uploadStatuses?: number[]
  redirectToSignIn?: boolean
  mutationLocation?: string
} = {}) {
  let mediaRecorderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder')
  let mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  let originalFetch = globalThis.fetch
  let uploads: Array<{ url: string; body: BodyInit | null | undefined; headers: Headers; keepalive: boolean | undefined }> = []
  let microphoneFailures = options.microphoneFailures ?? 0
  let uploadStatuses = [...(options.uploadStatuses ?? [])]
  let microphoneRequests = 0

  class FakeTrack extends EventTarget {
    stopped = false
    stop() {
      if (this.stopped) return
      this.stopped = true
      this.dispatchEvent(new Event('ended'))
    }
  }

  let track = new FakeTrack()
  let fakeStream = { getTracks: () => [track] } as unknown as MediaStream
  let resolveDeferredMicrophone: ((stream: MediaStream) => void) | undefined
  let deferredMicrophone = options.deferMicrophone
    ? new Promise<MediaStream>((resolve) => { resolveDeferredMicrophone = resolve })
    : undefined

  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() { return true }
    state: RecordingState = 'inactive'
    mimeType: string

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super()
      this.mimeType = options?.mimeType ?? 'audio/webm'
    }

    start() { this.state = 'recording' }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    requestData() {}
    stop() {
      if (this.state === 'inactive') return
      this.state = 'inactive'
      let dataEvent = new Event('dataavailable') as Event & { data: Blob }
      Object.defineProperty(dataEvent, 'data', { value: new Blob([options.emptyAudio ? '' : 'captured-audio'], { type: this.mimeType }) })
      this.dispatchEvent(dataEvent)
      this.dispatchEvent(new Event('stop'))
    }
  }

  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => {
      microphoneRequests++
      if (microphoneFailures > 0) {
        microphoneFailures--
        throw new Error('Permission denied.')
      }
      if (deferredMicrophone) return deferredMicrophone
      return fakeStream
    } },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    uploads.push({ url: String(input), body: init?.body, headers: new Headers(init?.headers), keepalive: init?.keepalive })
    let response = new Response(options.redirectToSignIn ? '<html><body>Sign in</body></html>' : null, {
      status: options.redirectToSignIn ? 200 : uploadStatuses.shift() ?? options.uploadStatus ?? 204,
      headers: options.mutationLocation ? { [frameMutationLocationHeader]: options.mutationLocation } : undefined,
    })
    if (options.redirectToSignIn) {
      Object.defineProperties(response, {
        redirected: { configurable: true, value: true },
        url: { configurable: true, value: `${window.location.origin}/auth/sign-in?returnTo=%2Findividual` },
      })
    }
    return response
  }) as typeof fetch

  return {
    uploads,
    microphoneRequests: () => microphoneRequests,
    resolveMicrophone() { resolveDeferredMicrophone?.(fakeStream) },
    trackStopped: () => track.stopped,
    restore() {
      if (mediaRecorderDescriptor) Object.defineProperty(globalThis, 'MediaRecorder', mediaRecorderDescriptor)
      else Reflect.deleteProperty(globalThis, 'MediaRecorder')
      if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
      globalThis.fetch = originalFetch
    },
  }
}

async function seedLegacyVersionOneRecording() {
  await deleteRecordingDatabase()
  let database = await new Promise<IDBDatabase>((resolve, reject) => {
    let request = indexedDB.open('handover-ai-recordings', 1)
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore('pending-uploads', { keyPath: 'id' })
    }, { once: true })
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
  try {
    let transaction = database.transaction('pending-uploads', 'readwrite')
    transaction.objectStore('pending-uploads').put({
      id: '00000000-0000-4000-8000-000000000001',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      formId: 'legacy-handover',
      submitAction: createHandoverAction,
      formEntries: [],
      audio: new Blob(['legacy-clinical-audio'], { type: 'audio/webm' }),
      recordedMimeType: 'audio/webm',
    })
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

async function pendingUploadRecordCount() {
  let database = await new Promise<IDBDatabase>((resolve, reject) => {
    let request = indexedDB.open('handover-ai-recordings')
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
  })
  try {
    let transaction = database.transaction('pending-uploads', 'readonly')
    let request = transaction.objectStore('pending-uploads').count()
    let count = await new Promise<number>((resolve, reject) => {
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener('error', () => reject(request.error), { once: true })
    })
    await transactionDone(transaction)
    return count
  } finally {
    database.close()
  }
}

async function deleteRecordingDatabase() {
  await new Promise<void>((resolve, reject) => {
    let request = indexedDB.deleteDatabase('handover-ai-recordings')
    request.addEventListener('success', () => resolve(), { once: true })
    request.addEventListener('error', () => reject(request.error), { once: true })
    request.addEventListener('blocked', () => reject(new Error('Recording database deletion was blocked.')), { once: true })
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error), { once: true })
  })
}
