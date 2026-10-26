import {
  clientEntry,
  css,
  link,
  on,
  ref,
  type Handle,
  type SerializableProps,
} from 'remix/component'

import { enhanceFrameMutation } from './frame-mutation.ts'

type ShiftPatient = {
  key: string
  displayName: string
  bed?: string
  priority?: 'high' | 'medium' | 'routine'
  href: string
  editAction?: string
  editableHandoverId?: string
}

interface ShiftPatientListProps extends SerializableProps {
  patients: ShiftPatient[]
  orderAction?: string
  csrfToken?: string
}

type PatientEditor = {
  patientKey: string
  displayName: string
  location: string
}

type DragInteraction = {
  patientKey: string
  pointerOffsetX: number
  pointerOffsetY: number
  sourceElement: HTMLLIElement
  started: boolean
  startX: number
  startY: number
}

/** React-parity patient cards with native Remix forms as the mutation path. */
export const ShiftPatientList = clientEntry(import.meta.url + '#ShiftPatientList', function ShiftPatientList(handle: Handle<ShiftPatientListProps>) {
  let patientOrder = handle.props.patients.map((patient) => patient.key)
  let propsRevision = patientRevision(handle.props.patients)
  let draggedPatientKey = ''
  let dropTargetPatientKey = ''
  let reorderPending = false
  let editingPatient: PatientEditor | null = null
  let patientDetailsUpdatePending = false
  let dragInteraction: DragInteraction | null = null
  let dragPreview: HTMLLIElement | null = null
  let dragOrderForm: HTMLFormElement | null = null
  let dragOrderInput: HTMLInputElement | null = null
  let previousBodyUserSelect = ''
  let reorderPreviousOrder = [...patientOrder]
  let mutationError = ''

  handle.queueTask(() => {
    window.addEventListener('pointermove', handlePatientPointerMove, { signal: handle.signal })
    window.addEventListener('pointerup', handlePatientPointerUp, { signal: handle.signal })
    window.addEventListener('pointercancel', handlePatientPointerCancel, { signal: handle.signal })
    handle.signal.addEventListener('abort', clearPatientDragDom, { once: true })
  })

  function update() {
    void handle.update()
  }

  function startEditingPatient(patient: ShiftPatient) {
    if (!patient.editAction || editingPatient || patientDetailsUpdatePending) return
    editingPatient = {
      patientKey: patient.key,
      displayName: patient.displayName,
      location: patient.bed ?? '',
    }
    update()
  }

  function cancelEditingPatient() {
    if (patientDetailsUpdatePending) return
    editingPatient = null
    update()
  }

  function handleEditorKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEditingPatient()
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    ;(event.currentTarget as HTMLInputElement).form?.requestSubmit()
  }

  function handlePatientDetailsSubmit(event: Event) {
    let editor = editingPatient
    if (!editor) return
    if (!editor.displayName.trim() || !editor.location.trim()) {
      event.preventDefault()
      let form = event.currentTarget as HTMLFormElement
      let input = form.querySelector<HTMLInputElement>(
        !editor.displayName.trim() ? 'input[name="displayName"]' : 'input[name="location"]',
      )
      input?.focus()
      return
    }
    let patient = handle.props.patients.find((item) => item.key === editor.patientKey)
    if (patient && editor.displayName === patient.displayName && editor.location === (patient.bed ?? '')) {
      event.preventDefault()
      editingPatient = null
      mutationError = ''
      update()
    }
  }

  function patientDetailsMutation() {
    return enhanceFrameMutation(handle, {
      onPending(value) { patientDetailsUpdatePending = value; if (value) mutationError = '' },
      onError(message) { mutationError = message },
      onRefreshError() { mutationError = 'The patient was saved, but the board could not be refreshed.' },
      onSuccess() { editingPatient = null; mutationError = '' },
    })
  }

  function startOrderSubmission(event: Event) {
    if (reorderPending) {
      event.preventDefault()
      return
    }
    let form = event.currentTarget as HTMLFormElement
    let input = form.querySelector<HTMLInputElement>('input[name="patientKeys"]')
    let nextOrder = parsePatientOrder(input?.value, handle.props.patients)
    reorderPreviousOrder = [...patientOrder]
    if (nextOrder) patientOrder = nextOrder
    reorderPending = true
    update()
  }

  function reorderMutation() {
    return enhanceFrameMutation(handle, {
      onPending(value) { reorderPending = value; if (value) mutationError = '' },
      onError(message) { patientOrder = [...reorderPreviousOrder]; mutationError = message },
      onRefreshError() { mutationError = 'The order was saved, but the board could not be refreshed.' },
      onSuccess() { mutationError = '' },
    })
  }

  function handlePatientPointerDown(event: PointerEvent, patient: ShiftPatient) {
    if (reorderPending || editingPatient?.patientKey === patient.key || event.button !== 0) return
    let target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('button, input, label, a, textarea, select, [role="button"], [data-slot="checkbox"]')) return

    let sourceElement = event.currentTarget as HTMLLIElement
    let bounds = sourceElement.getBoundingClientRect()
    dragInteraction = {
      patientKey: patient.key,
      pointerOffsetX: event.clientX - bounds.left,
      pointerOffsetY: event.clientY - bounds.top,
      sourceElement,
      started: false,
      startX: event.clientX,
      startY: event.clientY,
    }
  }

  function handlePatientPointerMove(event: PointerEvent) {
    let interaction = dragInteraction
    if (!interaction || reorderPending) return
    let distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY)
    if (!interaction.started && distance < 6) return

    if (!interaction.started) {
      interaction.started = true
      draggedPatientKey = interaction.patientKey
      dropTargetPatientKey = interaction.patientKey
      previousBodyUserSelect = document.body.style.userSelect
      document.body.style.userSelect = 'none'
      setPatientDragPreview(interaction.sourceElement, event.clientX, event.clientY)
      update()
    }

    event.preventDefault()
    updatePatientDragPreviewPosition(event.clientX, event.clientY)
    let targetPatientKey = patientKeyAtPoint(event.clientX, event.clientY) || interaction.patientKey
    if (dropTargetPatientKey !== targetPatientKey) {
      dropTargetPatientKey = targetPatientKey
      update()
    }
  }

  function handlePatientPointerUp(event: PointerEvent) {
    let interaction = dragInteraction
    if (!interaction) return
    let targetPatientKey = interaction.started
      ? patientKeyAtPoint(event.clientX, event.clientY) || interaction.patientKey
      : interaction.patientKey
    let shouldCommit = interaction.started && targetPatientKey !== interaction.patientKey
    clearPatientDragDom()
    draggedPatientKey = ''
    dropTargetPatientKey = ''
    dragInteraction = null

    if (!shouldCommit) {
      update()
      return
    }

    let nextOrder = reorderPatients(patientOrder, interaction.patientKey, targetPatientKey)
    if (sameOrder(patientOrder, nextOrder) || !dragOrderForm || !dragOrderInput) {
      update()
      return
    }
    patientOrder = nextOrder
    dragOrderInput.value = JSON.stringify(nextOrder)
    update()
    dragOrderForm.requestSubmit()
  }

  function handlePatientPointerCancel() {
    if (!dragInteraction) return
    clearPatientDragDom()
    draggedPatientKey = ''
    dropTargetPatientKey = ''
    dragInteraction = null
    update()
  }

  function setPatientDragPreview(sourceElement: HTMLLIElement, clientX: number, clientY: number) {
    clearPreview()
    let preview = sourceElement.cloneNode(true) as HTMLLIElement
    let bounds = sourceElement.getBoundingClientRect()
    preview.dataset.dragPreview = 'shift-patient-card'
    preview.removeAttribute('data-dragging')
    preview.setAttribute('aria-hidden', 'true')
    preview.inert = true
    preview.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'))
    preview.style.position = 'fixed'
    preview.style.top = '0'
    preview.style.left = '0'
    preview.style.margin = '0'
    preview.style.width = `${bounds.width}px`
    preview.style.pointerEvents = 'none'
    preview.style.zIndex = '9999'
    preview.style.opacity = '1'
    preview.style.transition = 'none'
    preview.style.animation = 'none'
    preview.style.willChange = 'transform'
    preview.style.contain = 'layout paint style'
    preview.style.background = 'rgba(255, 255, 255, 0.98)'
    preview.style.boxShadow = '0 28px 60px rgba(44, 56, 75, 0.16)'
    document.body.append(preview)
    dragPreview = preview
    updatePatientDragPreviewPosition(clientX, clientY)
  }

  function updatePatientDragPreviewPosition(clientX: number, clientY: number) {
    if (!dragInteraction || !dragPreview) return
    dragPreview.style.transform = `translate3d(${clientX - dragInteraction.pointerOffsetX}px, ${clientY - dragInteraction.pointerOffsetY}px, 0)`
  }

  function patientKeyAtPoint(clientX: number, clientY: number) {
    return document.elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>('[data-patient-key]')
      ?.dataset.patientKey ?? ''
  }

  function clearPreview() {
    dragPreview?.remove()
    dragPreview = null
  }

  function clearPatientDragDom() {
    clearPreview()
    if (previousBodyUserSelect) document.body.style.userSelect = previousBodyUserSelect
    else document.body.style.removeProperty('user-select')
    previousBodyUserSelect = ''
  }

  return () => {
    let nextPropsRevision = patientRevision(handle.props.patients)
    if (nextPropsRevision !== propsRevision) {
      propsRevision = nextPropsRevision
      patientOrder = handle.props.patients.map((patient) => patient.key)
      reorderPending = false
      patientDetailsUpdatePending = false
      editingPatient = null
    }
    let patientsByKey = new Map(handle.props.patients.map((patient) => [patient.key, patient]))
    let patients = patientOrder.flatMap((key) => {
      let patient = patientsByKey.get(key)
      return patient ? [patient] : []
    })
    for (let patient of handle.props.patients) {
      if (!patientOrder.includes(patient.key)) patients.push(patient)
    }

    return <>
      {mutationError ? <div role="alert" mix={css({
        marginBottom: '1rem',
        borderRadius: '14px',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'var(--color-rose-200)',
        backgroundColor: 'var(--color-rose-50)',
        paddingInline: '0.75rem',
        paddingBlock: '0.5rem',
        fontSize: '0.875rem',
        lineHeight: '1.5rem',
        color: 'var(--color-rose-900)'
      })}>{mutationError}</div> : null}
      <ol mix={css({ display: "grid", listStyleType: "none", gap: "1rem", padding: "0rem" })} aria-label="Patients in priority order" aria-busy={reorderPending || undefined}>
        {patients.map((patient, index) => {
          let isEditingPatient = editingPatient?.patientKey === patient.key
          let editingAnotherPatient = editingPatient != null && !isEditingPatient
          let editDisabled = isEditingPatient || editingAnotherPatient || patientDetailsUpdatePending || !patient.editAction
          let cardStyles = draggedPatientKey === patient.key
            ? draggingPatientCardStyles
            : dropTargetPatientKey === patient.key && draggedPatientKey !== patient.key
              ? dropTargetPatientCardStyles
              : patientCardStyles
          let nextUpOrder = movePatientByOffset(patients, patient.key, -1).map((item) => item.key)
          let nextDownOrder = movePatientByOffset(patients, patient.key, 1).map((item) => item.key)

          return <li
            key={patient.key}
            data-priority={patient.priority ?? 'routine'}
            data-patient-key={patient.key}
            data-testid={`patient-card-${patient.key}`}
            data-dragging={draggedPatientKey === patient.key ? 'true' : undefined}
            mix={[css(cardStyles), on('pointerdown', (event) => handlePatientPointerDown(event, patient))]}
          >
            <div mix={css({
              display: 'flex',
              minWidth: '0rem',
              flexDirection: 'column',
              gap: '0.75rem',
              paddingInline: '1rem',
              paddingBlock: '0.75rem',
              '@media (width >= 40rem)': {
                paddingInline: '1.25rem',
                paddingBlock: '1rem'
              }
            })}>
              <div mix={css({
                display: 'flex',
                minWidth: '0rem',
                flexDirection: 'column',
                gap: '0.75rem',
                '@media (width >= 40rem)': {
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }
              })}>
                {isEditingPatient && editingPatient && patient.editAction ? <form
                  method="post"
                  action={patient.editAction}
                  data-workflow="edit-shift-patient-details"
                  data-patient-key={patient.key}
                  aria-busy={patientDetailsUpdatePending || undefined}
                  mix={[css({ minWidth: "0rem", flex: "1" }),
                    on('submit', (event) => handlePatientDetailsSubmit(event)),
                    patientDetailsMutation(),
                  ]}
                >
                  {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                  {patient.editableHandoverId ? <input type="hidden" name="handoverId" value={patient.editableHandoverId} /> : null}
                  <input
                    aria-label="Name"
                    name="displayName"
                    required
                    maxLength={240}
                    value={editingPatient.displayName}
                    disabled={patientDetailsUpdatePending}
                    mix={[css({
                      display: 'block',
                      height: '2.75rem',
                      width: '100%',
                      minWidth: '0rem',
                      borderRadius: '18px',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
                      paddingInline: '0.75rem',
                      paddingBlock: '0.25rem',
                      fontFamily: '\'Geist Variable\', sans-serif',
                      fontSize: '1rem',
                      lineHeight: '1.5',
                      fontWeight: '500',
                      letterSpacing: '-0.025em',
                      color: 'var(--color-slate-950)',
                      boxShadow: 'none',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      outlineStyle: 'none',
                      '&:focus-visible': {
                        borderColor: 'var(--ring)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                      },
                      '@media (width >= 40rem)': {
                        fontSize: '1.125rem',
                        lineHeight: '1.55555556'
                      }
                    }),
                      ref((element, signal) => {
                        if (document.activeElement === element || document.activeElement?.getAttribute('aria-label') === 'Location') return
                        let frame = window.requestAnimationFrame(() => {
                          if (!signal.aborted) element.focus({ preventScroll: true })
                        })
                        signal.addEventListener('abort', () => window.cancelAnimationFrame(frame), { once: true })
                      }),
                      on('input', (event) => {
                        if (!editingPatient) return
                        editingPatient.displayName = event.currentTarget.value
                        update()
                      }),
                      on('keydown', (event) => handleEditorKeyDown(event)),
                    ]}
                  />
                  <div mix={css({
                    marginTop: '0.5rem',
                    display: 'flex',
                    minHeight: '2.25rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '0.5rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    color: 'var(--color-slate-600)'
                  })}>
                    <input
                      aria-label="Location"
                      name="location"
                      required
                      maxLength={120}
                      value={editingPatient.location}
                      disabled={patientDetailsUpdatePending}
                      mix={[css({
                        display: 'block',
                        height: '2.75rem',
                        minWidth: '0rem',
                        flex: '1',
                        borderRadius: 'calc(infinity * 1px)',
                        borderStyle: 'solid',
                        borderWidth: '1px',
                        borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                        backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
                        paddingInline: '1rem',
                        paddingBlock: '0.25rem',
                        fontSize: '0.875rem',
                        lineHeight: '1.42857143',
                        fontWeight: '500',
                        color: 'var(--color-slate-700)',
                        boxShadow: 'none',
                        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                        transitionDuration: '150ms',
                        outlineStyle: 'none',
                        '&:focus-visible': {
                          borderColor: 'var(--ring)',
                          boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                        },
                        '@media (width >= 40rem)': {
                          maxWidth: '14rem'
                        }
                      }),
                        on('input', (event) => {
                          if (!editingPatient) return
                          editingPatient.location = event.currentTarget.value
                          update()
                        }),
                        on('keydown', (event) => handleEditorKeyDown(event)),
                      ]}
                    />
                    <div mix={css({ display: "flex", flexShrink: "0", alignItems: "center", gap: "0.5rem" })}>
                      <button type="submit" disabled={patientDetailsUpdatePending} mix={css({
                        display: 'inline-flex',
                        height: '2.75rem',
                        flexShrink: '0',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.375rem',
                        borderRadius: 'calc(infinity * 1px)',
                        borderStyle: 'solid',
                        borderWidth: '1px',
                        borderColor: 'transparent',
                        backgroundColor: 'var(--primary)',
                        paddingInline: '0.75rem',
                        fontSize: '0.875rem',
                        lineHeight: '1.42857143',
                        fontWeight: '500',
                        whiteSpace: 'nowrap',
                        color: 'var(--primary-foreground)',
                        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                        transitionDuration: '150ms',
                        '&:hover': {
                          '@media (hover: hover)': {
                            backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
                          }
                        },
                        '&:disabled': {
                          pointerEvents: 'none',
                          opacity: '50%'
                        },
                        '@media (width >= 40rem)': {
                          paddingInline: '1rem'
                        }
                      })}>
                        {patientDetailsUpdatePending ? <LoadingIcon /> : <CheckIcon />}
                        {patientDetailsUpdatePending ? 'Saving details' : 'Save details'}
                      </button>
                      <button type="button" disabled={patientDetailsUpdatePending} mix={[css({
                        display: 'inline-flex',
                        height: '2.75rem',
                        flexShrink: '0',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 'calc(infinity * 1px)',
                        borderStyle: 'solid',
                        borderWidth: '1px',
                        borderColor: 'var(--border)',
                        backgroundColor: 'var(--background)',
                        paddingInline: '0.75rem',
                        fontSize: '0.875rem',
                        lineHeight: '1.42857143',
                        fontWeight: '500',
                        whiteSpace: 'nowrap',
                        color: 'var(--foreground)',
                        transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                        transitionDuration: '150ms',
                        '&:hover': {
                          '@media (hover: hover)': {
                            backgroundColor: 'var(--muted)'
                          }
                        },
                        '&:disabled': {
                          pointerEvents: 'none',
                          opacity: '50%'
                        },
                        '@media (width >= 40rem)': {
                          paddingInline: '1rem'
                        }
                      }), on('click', cancelEditingPatient)]}>Cancel</button>
                    </div>
                  </div>
                </form> : <div mix={css({ minWidth: "0rem", flex: "1" })}>
                  <div mix={css({ display: "flex", minWidth: "0rem", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })} role="group" aria-label={`${patient.displayName} patient navigation`}>
                    <a href={patient.href} mix={[css({
                      marginLeft: '-0.5rem',
                      display: 'flex',
                      minHeight: '3rem',
                      maxWidth: '100%',
                      minWidth: '0rem',
                      alignItems: 'center',
                      gap: '0.5rem',
                      borderRadius: '18px',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'transparent',
                      paddingInline: '0.5rem',
                      textAlign: 'left',
                      fontFamily: '\'Geist Variable\', sans-serif',
                      fontSize: '1.25rem',
                      lineHeight: '1.4',
                      fontWeight: '500',
                      letterSpacing: '-0.025em',
                      color: 'var(--color-slate-950)',
                      textDecorationLine: 'none',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          borderColor: 'color-mix(in oklab, var(--primary) 15%, transparent)',
                          backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                          color: 'var(--primary)'
                        }
                      },
                      '&:focus-visible': {
                        borderColor: 'color-mix(in oklab, var(--primary) 20%, transparent)',
                        backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--primary) 20%, transparent)',
                        outlineStyle: 'none'
                      },
                      '@media (width >= 40rem)': {
                        fontSize: '1.5rem',
                        lineHeight: '1.33333333'
                      }
                    }), link(patient.href, { target: 'workspace' })]} aria-label={`Open ${patient.displayName} patient workspace`} data-patient-link><span mix={css({ minWidth: "0rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{patient.displayName}</span><ChevronRightIcon /></a>
                  </div>
                  <div mix={css({
                    marginTop: '0.5rem',
                    display: 'flex',
                    minHeight: '2.25rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '0.5rem',
                    fontSize: '0.875rem',
                    lineHeight: '1.42857143',
                    color: 'var(--color-slate-600)'
                  })}>
                    {patient.bed ? <span mix={css({
                      display: 'inline-flex',
                      minHeight: '1.5rem',
                      alignItems: 'center',
                      borderRadius: 'calc(infinity * 1px)',
                      backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
                      paddingInline: '0.625rem',
                      fontSize: '0.75rem',
                      lineHeight: '1.33333333',
                      fontWeight: '600',
                      color: 'var(--color-slate-700)',
                      boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
                    })}>{patient.bed}</span> : null}
                    <button type="button" title="Edit patient details" aria-label="Edit patient details" disabled={editDisabled} mix={[css({
                      display: 'inline-flex',
                      width: '2.75rem',
                      height: '2.75rem',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'calc(infinity * 1px)',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'var(--border)',
                      backgroundColor: 'var(--background)',
                      color: 'var(--foreground)',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'var(--muted)'
                        }
                      },
                      '&:disabled': {
                        pointerEvents: 'none',
                        opacity: '50%'
                      }
                    }), on('click', () => startEditingPatient(patient))]}><PencilIcon /></button>
                  </div>
                </div>}

                <div mix={css({ display: "flex", flexShrink: "0", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", "@media (width >= 40rem)": { justifyContent: "flex-end" } })}>
                  <div aria-label={`Priority ${index + 1}`} mix={css({
                    display: 'inline-flex',
                    height: '2rem',
                    alignItems: 'center',
                    gap: '0.375rem',
                    borderRadius: 'calc(infinity * 1px)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 90%, transparent)',
                    paddingInline: '0.625rem',
                    fontSize: '0.75rem',
                    lineHeight: '1.33333333',
                    fontWeight: '600',
                    color: 'var(--color-slate-700)'
                  })}><span mix={css({ color: "var(--color-slate-500)" })}>Priority</span><span mix={css({ color: "var(--color-slate-950)", fontVariantNumeric: "tabular-nums" })}>{index + 1}</span></div>
                  {handle.props.orderAction ? <form method="post" action={handle.props.orderAction} mix={[on('submit', (event) => startOrderSubmission(event)), reorderMutation()]}>
                    {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                    <input type="hidden" name="patientKeys" value={JSON.stringify(nextUpOrder)} />
                    <button type="submit" disabled={index === 0 || reorderPending} mix={css({
                      display: 'inline-flex',
                      width: '2.75rem',
                      height: '2.75rem',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'min(calc(var(--radius) * 0.8), 12px)',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'var(--border)',
                      backgroundColor: 'var(--background)',
                      color: 'var(--foreground)',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'var(--muted)'
                        }
                      },
                      '&:disabled': {
                        pointerEvents: 'none',
                        opacity: '50%'
                      }
                    })}><ArrowUpIcon /><span mix={css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: '0',
                      margin: '-1px',
                      overflow: 'hidden',
                      clipPath: 'inset(50%)',
                      whiteSpace: 'nowrap',
                      borderWidth: '0'
                    })} data-visually-hidden="">Move {patient.displayName} up</span></button>
                  </form> : null}
                  {handle.props.orderAction ? <form method="post" action={handle.props.orderAction} mix={[on('submit', (event) => startOrderSubmission(event)), reorderMutation()]}>
                    {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
                    <input type="hidden" name="patientKeys" value={JSON.stringify(nextDownOrder)} />
                    <button type="submit" disabled={index === patients.length - 1 || reorderPending} mix={css({
                      display: 'inline-flex',
                      width: '2.75rem',
                      height: '2.75rem',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 'min(calc(var(--radius) * 0.8), 12px)',
                      borderStyle: 'solid',
                      borderWidth: '1px',
                      borderColor: 'var(--border)',
                      backgroundColor: 'var(--background)',
                      color: 'var(--foreground)',
                      transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'var(--muted)'
                        }
                      },
                      '&:disabled': {
                        pointerEvents: 'none',
                        opacity: '50%'
                      }
                    })}><ArrowDownIcon /><span mix={css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: '0',
                      margin: '-1px',
                      overflow: 'hidden',
                      clipPath: 'inset(50%)',
                      whiteSpace: 'nowrap',
                      borderWidth: '0'
                    })} data-visually-hidden="">Move {patient.displayName} down</span></button>
                  </form> : null}
                  <div mix={css({
                    display: 'inline-flex',
                    width: '2.75rem',
                    height: '2.75rem',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'calc(infinity * 1px)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                    backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
                    color: 'var(--color-slate-400)',
                    ...(reorderPending ? {
                      cursor: 'not-allowed',
                      opacity: '60%'
                    } : {
                      cursor: 'grab'
                    })
                  })} aria-hidden="true" title="Drag to reprioritise"><GripIcon /></div>
                </div>
              </div>

            </div>
          </li>
        })}
      </ol>
      {handle.props.orderAction ? <form
        method="post"
        action={handle.props.orderAction}
        hidden
        aria-hidden="true"
        data-workflow="reorder-shift-patients"
        mix={[ref((element) => { dragOrderForm = element }), on('submit', (event) => startOrderSubmission(event)), reorderMutation()]}
      >
        {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
        <input type="hidden" name="patientKeys" value={JSON.stringify(patientOrder)} mix={ref((element) => { dragOrderInput = element })} />
      </form> : null}
    </>
  }
})

function patientRevision(patients: ShiftPatient[]) {
  return JSON.stringify(patients.map((patient) => [
    patient.key,
    patient.displayName,
    patient.bed ?? '',
    patient.editAction ?? '',
    patient.editableHandoverId ?? '',
  ]))
}

function parsePatientOrder(value: string | undefined, patients: ShiftPatient[]) {
  if (!value) return null
  try {
    let parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || !parsed.every((key) => typeof key === 'string')) return null
    let validKeys = new Set(patients.map((patient) => patient.key))
    if (parsed.length !== validKeys.size || new Set(parsed).size !== validKeys.size) return null
    return parsed.every((key) => validKeys.has(key)) ? parsed : null
  } catch {
    return null
  }
}

function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

function reorderPatients(order: string[], sourceKey: string, targetKey: string) {
  let from = order.indexOf(sourceKey)
  let to = order.indexOf(targetKey)
  if (from < 0 || to < 0 || from === to) return order
  let next = [...order]
  let [moved] = next.splice(from, 1)
  if (!moved) return order
  next.splice(to, 0, moved)
  return next
}

function movePatientByOffset(patients: ShiftPatient[], patientKey: string, offset: -1 | 1) {
  let from = patients.findIndex((patient) => patient.key === patientKey)
  let to = Math.min(Math.max(from + offset, 0), patients.length - 1)
  if (from < 0 || from === to) return patients
  let next = [...patients]
  let [moved] = next.splice(from, 1)
  if (!moved) return patients
  next.splice(to, 0, moved)
  return next
}

function ChevronRightIcon() { return () => <svg mix={[css({
  width: '1.75rem',
  height: '1.75rem',
  flexShrink: '0',
  borderRadius: 'calc(infinity * 1px)',
  backgroundColor: 'color-mix(in oklab, var(--primary) 10%, transparent)',
  padding: '0.375rem',
  color: 'var(--primary)',
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms'
}), css({
  '@media (hover: hover)': {
    '[data-patient-link]:hover &': {
      translate: '0.125rem 0',
      backgroundColor: 'var(--color-primary)',
      color: 'var(--color-primary-foreground)'
    }
  }
})]} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg> }
function PencilIcon() { return () => <svg mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg> }
function ArrowUpIcon() { return () => <svg mix={css({ width: "0.75rem", height: "0.75rem" })} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6" /></svg> }
function ArrowDownIcon() { return () => <svg mix={css({ width: "0.75rem", height: "0.75rem" })} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg> }
function GripIcon() { return () => <svg mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></svg> }
function CheckIcon() { return () => <svg data-icon="inline-start" mix={css({ width: "1rem", height: "1rem" })} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5" /></svg> }
function LoadingIcon() { return () => <svg data-icon="inline-start" mix={css({ width: "1rem", height: "1rem", animation: "spin 1s linear infinite" })} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.6" /></svg> }

const patientCardStyles: Parameters<typeof css>[0] = {
  scrollMarginTop: '18rem',
  overflow: 'hidden',
  borderRadius: '22px',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'color-mix(in oklab, var(--color-white) 70%, transparent)',
  backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
  boxShadow: '0 8px 22px rgba(44,56,75,0.05)',
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  WebkitUserSelect: 'none',
  userSelect: 'none'
}
const draggingPatientCardStyles: Parameters<typeof css>[0] = {
  position: 'relative',
  zIndex: '10',
  scrollMarginTop: '18rem',
  overflow: 'hidden',
  borderRadius: '22px',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'color-mix(in oklab, var(--primary) 28%, transparent)',
  backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
  opacity: '60%',
  boxShadow: '0 0 0 2px color-mix(in oklab, var(--primary) 14%, transparent), 0 18px 40px rgba(44,56,75,0.14)',
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  WebkitUserSelect: 'none',
  userSelect: 'none'
}
const dropTargetPatientCardStyles: Parameters<typeof css>[0] = {
  scrollMarginTop: '18rem',
  overflow: 'hidden',
  borderRadius: '22px',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'color-mix(in oklab, var(--primary) 20%, transparent)',
  backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
  boxShadow: '0 14px 32px rgba(74,110,224,0.12)',
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  WebkitUserSelect: 'none',
  userSelect: 'none'
}
