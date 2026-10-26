import { css, clientEntry, link, on, ref, type Handle, type RemixNode, type SerializableProps } from 'remix/component'
import * as popover from '@remix-run/ui/popover'
import * as select from '@remix-run/ui/select'
import { onSelectChange } from '@remix-run/ui/select'

import type { TaskSummary } from '../ui/models.ts'
import {
  DEFAULT_TASK_DUE_LABEL,
  formatTaskDueDateTime,
  getTaskDueDisplay,
  taskDueIsoValue,
  taskDueLocalValue,
} from './task-dates.ts'
import { enhanceFrameMutation } from './frame-mutation.ts'

type TaskScopeFilter = 'all' | `patient:${string}` | `handover:${string}`
type TaskReminderFilter = 'all' | 'on' | 'off'
type TaskStatusFilter = 'all' | 'open' | 'done'
type TaskSort = 'current' | 'title-asc' | 'title-desc' | 'open-first' | 'done-first' | 'reminder-on-first'

interface PatientActionsPanelProps extends SerializableProps {
  patient?: {
    key: string
    displayName: string
    bed?: string
  }
  patientOptions?: Array<{ key: string; label: string }>
  tasks: TaskSummary[]
  createAction?: string
  inlineCreate?: boolean
  actionRoute?: 'add'
  actionsHref?: string
  addActionHref?: string
  disabled?: boolean
  csrfToken?: string
}

/**
 * The patient TaskPanel as a native Remix island. View controls stay local while
 * create, update, status, reminder, and delete mutations are ordinary forms.
 */
export const PatientActionsPanel = clientEntry(import.meta.url + '#PatientActionsPanel', function PatientActionsPanel(handle: Handle<PatientActionsPanelProps>) {
  let scopeFilter: TaskScopeFilter = 'all'
  let reminderFilter: TaskReminderFilter = 'all'
  let statusFilter: TaskStatusFilter = 'all'
  let taskSort: TaskSort = 'current'
  let editingTaskId = ''
  let editingLabel = ''
  let editingDueLabel = ''
  let editingDueAt = ''
  let editingDueLocal = ''
  let editingDuePopoverOpen = false
  let editingSubmitPending = false
  let deleteTaskId = ''
  let deleteDialog: HTMLDialogElement | undefined
  let showLocalDueTimes = false
  let mutationPending = new Set<string>()
  let mutationError = ''
  let reminderOverrides = new Map<string, boolean>()

  handle.queueTask((signal) => {
    let timer = setTimeout(() => {
      if (signal.aborted) return
      showLocalDueTimes = true
      void handle.update()
    }, 0)
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })

  function updateView() {
    handle.update()
  }

  async function openDeleteDialog(taskId: string) {
    deleteTaskId = taskId
    let signal = await handle.update()
    if (!signal.aborted && deleteDialog && !deleteDialog.open) deleteDialog.showModal()
  }

  async function closeDeleteDialog() {
    if (deleteDialog?.open) deleteDialog.close()
    deleteTaskId = ''
    await handle.update()
  }

  function startEditing(task: TaskSummary) {
    if (handle.props.disabled || !task.updateAction) return
    if (editingTaskId && editingTaskId !== task.id) {
      document.getElementById(`task-${editingTaskId}-label`)?.focus()
      return
    }
    editingTaskId = task.id
    editingLabel = task.label
    editingDueLabel = task.due ?? DEFAULT_TASK_DUE_LABEL
    editingDueAt = task.dueAt ?? ''
    editingDueLocal = taskDueLocalValue(task.dueAt)
    editingDuePopoverOpen = false
    editingSubmitPending = false
    updateView()
  }

  function cancelEditing() {
    editingTaskId = ''
    editingLabel = ''
    editingDueLabel = ''
    editingDueAt = ''
    editingDueLocal = ''
    editingDuePopoverOpen = false
    editingSubmitPending = false
    updateView()
  }

  function submitTaskEditor(form: HTMLFormElement) {
    if (editingSubmitPending) return
    if (!editingLabel.trim()) return
    editingSubmitPending = true
    form.requestSubmit()
  }

  function handleTaskEditorKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (editingDuePopoverOpen) return
      event.preventDefault()
      cancelEditing()
      return
    }
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || event.target.name !== 'label') return
    event.preventDefault()
    submitTaskEditor(event.currentTarget as HTMLFormElement)
  }

  function updateEditingDue(localValue: string) {
    editingDueLocal = localValue
    editingDueAt = taskDueIsoValue(localValue)
    editingDueLabel = editingDueAt ? formatTaskDueDateTime(editingDueAt) : DEFAULT_TASK_DUE_LABEL
    updateView()
  }

  function resetView() {
    scopeFilter = 'all'
    reminderFilter = 'all'
    statusFilter = 'all'
    taskSort = 'current'
    updateView()
  }

  function taskMutation(key: string, options: { onSuccess?: () => void; onError?: () => void } = {}) {
    return enhanceFrameMutation(handle, {
      onPending(pending) {
        if (pending) mutationPending.add(key)
        else mutationPending.delete(key)
        if (pending) mutationError = ''
        if (key.startsWith('details:')) editingSubmitPending = pending
      },
      onError(message) {
        mutationError = message
        options.onError?.()
      },
      onRefreshError() {
        mutationError = 'The task was saved, but the page could not be refreshed.'
      },
      onSuccess() {
        mutationError = ''
        options.onSuccess?.()
      },
    })
  }

  return () => {
    let dedicatedCreate = handle.props.actionRoute === 'add' && Boolean(handle.props.createAction)
    let inlineCreate = !dedicatedCreate && Boolean(handle.props.inlineCreate && handle.props.createAction)
    let patientOptions = handle.props.patientOptions?.length
      ? handle.props.patientOptions
      : handle.props.patient
        ? [{ key: handle.props.patient.key, label: [handle.props.patient.displayName, handle.props.patient.bed].filter(Boolean).join(' · ') }]
        : []
    let patientLabelByKey = new Map(patientOptions.map((patient) => [patient.key, patient.label]))
    let showsPatientField = patientOptions.length > 1
    let scopeOptions = taskScopeOptions(handle.props.tasks, patientOptions, showLocalDueTimes ? undefined : 'UTC')
    let visibleTasks = handle.props.tasks
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => {
        if (scopeFilter.startsWith('patient:') && task.patientKey !== scopeFilter.slice('patient:'.length)) return false
        if (scopeFilter.startsWith('handover:') && task.handoverId !== scopeFilter.slice('handover:'.length)) return false
        if (reminderFilter === 'on' && !task.reminderEnabled) return false
        if (reminderFilter === 'off' && task.reminderEnabled) return false
        if (statusFilter === 'open' && task.completed) return false
        if (statusFilter === 'done' && !task.completed) return false
        return true
      })

    if (taskSort !== 'current') {
      visibleTasks.sort((left, right) => {
        let result = 0
        if (taskSort === 'title-asc') result = compareText(left.task.label, right.task.label)
        if (taskSort === 'title-desc') result = compareText(right.task.label, left.task.label)
        if (taskSort === 'open-first') result = Number(left.task.completed) - Number(right.task.completed)
        if (taskSort === 'done-first') result = Number(right.task.completed) - Number(left.task.completed)
        if (taskSort === 'reminder-on-first') result = Number(Boolean(right.task.reminderEnabled)) - Number(Boolean(left.task.reminderEnabled))
        return result || left.index - right.index
      })
    }

    let tasks = visibleTasks.map(({ task }) => task)
    let filtersActive = scopeFilter !== 'all' || reminderFilter !== 'all' || statusFilter !== 'all'
    let customView = filtersActive || taskSort !== 'current'
    let draftActive = Boolean(editingTaskId)
    let taskSummary = filtersActive
      ? `${tasks.length} of ${handle.props.tasks.length} action${handle.props.tasks.length === 1 ? '' : 's'}`
      : `${handle.props.tasks.length} action${handle.props.tasks.length === 1 ? '' : 's'}`
    let deleteTarget = handle.props.tasks.find((task) => task.id === deleteTaskId)

    return <section mix={css({
      display: 'flex',
      minWidth: '0rem',
      flexDirection: 'column',
      gap: '1rem',
      overflow: 'hidden',
      borderRadius: '24px',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
      paddingBlock: '1rem',
      fontSize: '0.875rem',
      lineHeight: '1.42857143',
      color: 'var(--card-foreground)',
      boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent)'
    })} data-testid="shift-patient-actions">
      <header mix={css({
        display: 'grid',
        gridAutoRows: 'min-content',
        alignItems: 'flex-start',
        gap: '0.75rem',
        borderTopLeftRadius: 'calc(var(--radius) * 1.4)',
        borderTopRightRadius: 'calc(var(--radius) * 1.4)',
        paddingInline: '1rem',
        '@media (width >= 40rem)': {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between'
        }
      })}>
        <h2 mix={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          fontFamily: '\'Geist Variable\', sans-serif',
          fontSize: '1.125rem',
          lineHeight: '1.375',
          fontWeight: '500',
          color: 'var(--color-slate-950)'
        })}><ClipboardIcon styles={{ width: "1.25rem", height: "1.25rem", color: "var(--primary)" }} />{dedicatedCreate ? 'Add action' : 'Action list'}</h2>
        {!dedicatedCreate && !inlineCreate && handle.props.createAction && handle.props.addActionHref
          ? <a href={handle.props.addActionHref} mix={[css(smallPrimaryButtonStyles), link(handle.props.addActionHref, { target: 'workspace', resetScroll: false })]} ><ClipboardIcon />Add action</a>
          : inlineCreate && handle.props.actionsHref
            ? <a href={handle.props.actionsHref} mix={[css(smallOutlineButtonStyles), link(handle.props.actionsHref, { target: 'workspace', resetScroll: false })]} aria-label={patientOptions[0] ? `Go to ${patientOptions[0].label} actions` : 'Go to patient actions'} ><ClipboardIcon />Go to actions</a>
            : null}
      </header>

      <div mix={css({ paddingInline: "1rem" })}>
        {dedicatedCreate && handle.props.createAction ? <TaskCreateForm
          action={handle.props.createAction}
          actionsHref={handle.props.actionsHref}
          patientOptions={patientOptions}
          disabled={handle.props.disabled}
          csrfToken={handle.props.csrfToken}
          enhance={false}
        /> : <>
          {inlineCreate && handle.props.createAction ? <div mix={css({ marginBottom: "1.25rem" })}><TaskCreateForm
            action={handle.props.createAction}
            patientOptions={patientOptions}
            disabled={handle.props.disabled}
            csrfToken={handle.props.csrfToken}
            enhance
          /></div> : null}
          {mutationError ? <div role="alert" mix={css({
            marginBottom: '0.75rem',
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
          {handle.props.tasks.length ? <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.75rem" } })}>
          <div mix={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            borderRadius: 'calc(var(--radius) * 1.8)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 80%, transparent)',
            paddingInline: '0.75rem',
            paddingBlock: '0.75rem',
            '@media (width >= 40rem)': {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between'
            }
          })}>
            <div mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-700)" })} aria-live="polite">{taskSummary}</div>
            <div mix={css({ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" })}>
              <ViewSelect
                label="Sort"
                value={taskSort}
                options={sortOptions}
                testId="task-sort"
                styles={{ width: "100%", "@media (width >= 40rem)": { width: "190px" } }}
                onChange={(value) => {
                  taskSort = value as TaskSort
                  updateView()
                }}
              />
              {customView ? <button type="button"  data-testid="task-reset-view" mix={[css(smallOutlineButtonStyles), on('click', resetView)]}>Reset view</button> : null}
            </div>
          </div>

          <div mix={css({
            display: 'grid',
            gap: '0.5rem',
            '@media (width >= 40rem)': {
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'
            },
            '@media (width >= 48rem)': {
              display: 'none'
            }
          })} data-testid="task-mobile-filters">
            <ViewSelect label="Action" value={scopeFilter} options={scopeOptions} testId="task-scope-filter-mobile" onChange={(value) => { scopeFilter = value as TaskScopeFilter; updateView() }} />
            <ViewSelect label="Reminder" value={reminderFilter} options={reminderOptions} testId="task-reminder-filter-mobile" onChange={(value) => { reminderFilter = value as TaskReminderFilter; updateView() }} />
            <ViewSelect label="Status" value={statusFilter} options={statusOptions} testId="task-status-filter-mobile" onChange={(value) => { statusFilter = value as TaskStatusFilter; updateView() }} />
          </div>

          {tasks.length ? <div mix={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            '@media (width >= 48rem)': {
              display: 'block',
              overflowX: 'auto',
              borderRadius: 'calc(var(--radius) * 1.8)',
              borderStyle: 'solid',
              borderWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'var(--color-white)'
            }
          })}>
            <div mix={css({
              display: 'none',
              minWidth: '760px',
              gridTemplateColumns: '320px minmax(170px,1fr) minmax(150px,0.9fr) 120px',
              borderBottomStyle: 'solid',
              borderBottomWidth: '1px',
              borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
              backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 50%, transparent)',
              '@media (width >= 48rem)': {
                display: 'grid'
              }
            })} data-testid="task-desktop-header">
              <div mix={css({ paddingInline: "0.5rem", paddingBlock: "0.5rem" })}><ViewSelect label="Action" value={scopeFilter} options={scopeOptions} testId="task-scope-filter" styles={{ width: "270px", maxWidth: "100%" }} onChange={(value) => { scopeFilter = value as TaskScopeFilter; updateView() }} /></div>
              <div mix={css({ paddingInline: "0.5rem", paddingBlock: "0.5rem" })}><ViewSelect label="Reminder" value={reminderFilter} options={reminderOptions} testId="task-reminder-filter" styles={{ width: "100%" }} onChange={(value) => { reminderFilter = value as TaskReminderFilter; updateView() }} /></div>
              <div mix={css({ paddingInline: "0.5rem", paddingBlock: "0.5rem" })}><ViewSelect label="Status" value={statusFilter} options={statusOptions} testId="task-status-filter" styles={{ width: "100%" }} onChange={(value) => { statusFilter = value as TaskStatusFilter; updateView() }} /></div>
              <div mix={css({ paddingInline: "0.5rem", paddingBlock: "0.75rem", fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-600)" })}>Manage</div>
            </div>

            <div mix={css({
              display: 'contents',
              '@media (width >= 48rem)': {
                display: 'block',
                ':where(& > :not(:last-child))': {
                  borderBottomStyle: 'solid',
                  borderTopStyle: 'solid',
                  borderTopWidth: '0px',
                  borderBottomWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)'
                }
              }
            })}>{tasks.map((task) => {
              let editable = Boolean(task.updateAction)
              let editing = editingTaskId === task.id && editable
              let anotherTaskEditing = editable && Boolean(editingTaskId) && !editing
              return <div key={task.id} data-testid={`patient-task-row-${task.id}`} mix={css({
                display: 'grid',
                gap: '1rem',
                borderRadius: 'calc(var(--radius) * 1.8)',
                borderStyle: 'solid',
                borderWidth: '1px',
                borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                backgroundColor: 'var(--color-white)',
                paddingInline: '1rem',
                paddingBlock: '1rem',
                '@media (width >= 48rem)': {
                  minWidth: '760px',
                  gridTemplateColumns: '320px minmax(170px,1fr) minmax(150px,0.9fr) 120px',
                  alignItems: 'flex-start',
                  gap: '0rem',
                  borderRadius: '0',
                  borderStyle: 'solid',
                  borderWidth: '0px',
                  backgroundColor: 'transparent',
                  paddingInline: '0rem',
                  paddingBlock: '0rem',
                  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transitionDuration: '150ms',
                  '&:hover': {
                    '@media (hover: hover)': {
                      backgroundColor: 'color-mix(in oklab, var(--muted) 50%, transparent)'
                    }
                  }
                }
              })}>
                <div mix={css({ minWidth: "0rem", "@media (width >= 48rem)": { padding: "0.5rem" } })}>
                  {editing && task.updateAction ? <form
                    method="post"
                    action={task.updateAction}
                    data-workflow="edit-patient-task"
                    data-task-editor={task.id}
                    data-testid={`task-edit-form-${task.id}`}
                    mix={[css({ display: "grid", gap: "0.5rem" }),
                      on<HTMLFormElement, 'keydown'>('keydown', handleTaskEditorKeyDown),
                      taskMutation(`details:${task.id}`, {
                        onSuccess() {
                          editingTaskId = ''
                          editingSubmitPending = false
                        },
                      }),
                    ]}
                  >
                    {csrf(handle.props.csrfToken)}
                    <input type="hidden" name="_intent" value="details" />
                    <label mix={css({
                      position: 'absolute',
                      width: '1px',
                      height: '1px',
                      padding: '0',
                      margin: '-1px',
                      overflow: 'hidden',
                      clipPath: 'inset(50%)',
                      whiteSpace: 'nowrap',
                      borderWidth: '0'
                    })} data-visually-hidden="" htmlFor={`task-${task.id}-label`}>Action title</label>
                    <input
                      id={`task-${task.id}-label`}
                      name="label"
                      required
                      value={editingLabel}
                      placeholder="Action title"
                      mix={[css(inputStyles), on('input', (event) => {
                        editingLabel = (event.currentTarget as HTMLInputElement).value
                        updateView()
                      })]}
                    />
                    <input type="hidden" name="dueAt" value={editingDueAt} />
                    <input type="hidden" name="dueLabel" value={editingDueLabel} />
                    <TaskDueDateTimePicker
                      id={`task-${task.id}-due-at`}
                      value={editingDueLocal}
                      testId={`task-due-picker-${task.id}`}
                      disabled={handle.props.disabled}
                      onChange={updateEditingDue}
                      onOpenChange={(open) => {
                        editingDuePopoverOpen = open
                      }}
                    />
                    <p id={`task-${task.id}-editing-hint`} mix={css({ fontSize: "0.75rem", lineHeight: "1.25rem", color: "var(--color-slate-600)" })}>Save or cancel before editing another action.</p>
                    <div mix={css({ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: "0.5rem" })}>
                      <button type="button" disabled={editingSubmitPending} mix={[css({
                        ...smallOutlineButtonStyles,
                        height: '2.75rem',
                        '@media (width >= 48rem)': {
                          height: '2rem'
                        }
                      }), on('click', cancelEditing)]}>Cancel</button>
                      <button
                        type="button"
                        disabled={editingSubmitPending || !editingLabel.trim()}
                        mix={[css({
                          ...smallPrimaryButtonStyles,
                          height: '2.75rem',
                          '&:disabled': {
                            pointerEvents: 'none',
                            cursor: 'not-allowed',
                            opacity: '50%'
                          },
                          '@media (width >= 48rem)': {
                            height: '2rem'
                          }
                        }), on('click', (event) => submitTaskEditor(event.currentTarget.closest('form') as HTMLFormElement))]}
                      >{editingSubmitPending ? 'Saving…' : 'Save action'}</button>
                    </div>
                    <noscript><label mix={css({ display: "grid", gap: "0.375rem", fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "500", color: "var(--color-slate-700)" })} htmlFor={`task-${task.id}-due-local`}>
                      Due date and time
                      <input id={`task-${task.id}-due-local`} name="dueLocal" type="datetime-local" step="60" value={editingDueLocal} mix={css(inputStyles)} />
                    </label></noscript>
                  </form> : <button
                    type="button"
                    disabled={handle.props.disabled}
                    aria-disabled={anotherTaskEditing || undefined}
                    aria-describedby={anotherTaskEditing ? `task-${editingTaskId}-editing-hint` : undefined}

                    aria-label={editable && !handle.props.disabled ? `Edit ${task.label}` : undefined}
                    data-testid={`task-edit-${task.id}`}
                    mix={[css({
                      width: '100%',
                      minWidth: '0rem',
                      textAlign: 'left',
                      whiteSpace: 'normal',
                      '&:disabled': {
                        cursor: 'not-allowed',
                        opacity: '50%'
                      },
                      '&[aria-disabled="true"]': {
                        cursor: 'not-allowed',
                        opacity: '50%'
                      },
                      ...(editable && !handle.props.disabled ? {
                        cursor: 'pointer'
                      } : {})
                    }), editable ? on('click', () => startEditing(task)) : undefined]}
                  >
                    <span mix={css({ display: "block", maxWidth: "100%", fontWeight: "500", overflowWrap: "break-word", whiteSpace: "normal", color: "var(--color-slate-900)" })}>{task.label}</span>
                    <span mix={css({
                      marginTop: '0.25rem',
                      display: 'block',
                      maxWidth: '100%',
                      fontSize: '0.875rem',
                      lineHeight: '1.42857143',
                      overflowWrap: 'break-word',
                      whiteSpace: 'normal',
                      color: 'var(--color-slate-500)'
                    })}>{taskMetaLabel(task, showsPatientField ? patientLabelByKey.get(task.patientKey ?? '') : undefined, showLocalDueTimes ? undefined : 'UTC')}</span>
                  </button>}
                </div>

                <div mix={css({
                  display: 'flex',
                  minWidth: '0rem',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  borderRadius: 'calc(var(--radius) * 1.4)',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
                  backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
                  paddingInline: '0.75rem',
                  paddingBlock: '0.75rem',
                  '@media (width >= 48rem)': {
                    display: 'block',
                    borderRadius: '0',
                    borderStyle: 'solid',
                    borderWidth: '0px',
                    backgroundColor: 'transparent',
                    padding: '0.5rem'
                  }
                })}>
                  <div mix={css({ minWidth: "0rem", "@media (width >= 48rem)": { display: "none" } })}><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Reminder</div><div mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-600)" })}>Keep this task visible for the next review.</div></div>
                  {editable && task.updateAction ? <form method="post" action={task.updateAction}  data-workflow="update-task-reminder" data-testid={`task-reminder-form-${task.id}`} aria-busy={mutationPending.has(`reminder:${task.id}`) || undefined} mix={[css({ display: "flex", flexShrink: "0", alignItems: "center", gap: "0.5rem" }), taskMutation(`reminder:${task.id}`, { onError() { reminderOverrides.delete(task.id) } })]}>
                    {csrf(handle.props.csrfToken)}
                    <input type="hidden" name="_intent" value="reminder" />
                    <button
                      type="submit"
                      name="reminderEnabled"
                      value={String(!Boolean(task.reminderEnabled))}
                      role="switch"
                      aria-checked={reminderOverrides.get(task.id) ?? Boolean(task.reminderEnabled)}
                      aria-label={`Reminder for ${task.label}`}
                      disabled={handle.props.disabled || draftActive || mutationPending.has(`reminder:${task.id}`)}
                      mix={[css({
                        display: 'inline-flex',
                        width: '2.75rem',
                        height: '2.75rem',
                        flexShrink: '0',
                        cursor: 'pointer',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: 'calc(infinity * 1px)',
                        borderStyle: 'solid',
                        borderWidth: '1px',
                        borderColor: 'transparent',
                        transitionProperty: 'all',
                        transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                        transitionDuration: '150ms',
                        outlineStyle: 'none',
                        '&:focus-visible': {
                          borderColor: 'var(--ring)',
                          boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                        },
                        '&:disabled': {
                          cursor: 'not-allowed',
                          opacity: '50%'
                        },
                        '@media (width >= 48rem)': {
                          width: '2rem',
                          height: '2rem'
                        }
                      }), on('click', () => {
                        reminderOverrides.set(task.id, !task.reminderEnabled)
                        void handle.update()
                      })]}
                    ><span mix={css({
                      pointerEvents: 'none',
                      display: 'inline-flex',
                      height: '18.4px',
                      width: '2rem',
                      alignItems: 'center',
                      borderRadius: 'calc(infinity * 1px)',
                      ...(reminderOverrides.get(task.id) ?? Boolean(task.reminderEnabled) ? {
                        backgroundColor: 'var(--primary)'
                      } : {
                        backgroundColor: 'var(--input)'
                      })
                    })}><span mix={css({
                      display: 'block',
                      width: '1rem',
                      height: '1rem',
                      borderRadius: 'calc(infinity * 1px)',
                      backgroundColor: 'var(--background)',
                      transitionProperty: 'transform, translate, scale, rotate',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      ...(reminderOverrides.get(task.id) ?? Boolean(task.reminderEnabled) ? {
                        translate: 'calc(100% - 2px) 0'
                      } : {
                        translate: '0rem 0'
                      })
                    })} /></span></button>
                    <BellIcon />
                  </form> : <span mix={css({
                    display: 'inline-flex',
                    borderRadius: 'calc(infinity * 1px)',
                    paddingInline: '0.5rem',
                    paddingBlock: '0.125rem',
                    fontSize: '0.75rem',
                    lineHeight: '1.33333333',
                    fontWeight: '500',
                    ...(task.reminderEnabled ? {
                      backgroundColor: 'color-mix(in oklab, var(--primary) 8%, transparent)',
                      color: 'var(--primary)',
                      boxShadow: '0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent)'
                    } : {
                      backgroundColor: 'var(--color-slate-100)',
                      color: 'var(--color-slate-600)',
                      boxShadow: '0 0 0 1px var(--color-slate-200)'
                    })
                  })}>{task.reminderEnabled ? 'On' : 'Off'}</span>}
                </div>

                <div mix={css({ minWidth: "0rem", "@media (width >= 48rem)": { padding: "0.5rem" } })}>
                  <div mix={css({
                    marginBottom: '0.5rem',
                    fontSize: '11px',
                    fontWeight: '500',
                    letterSpacing: '0.16em',
                    color: 'var(--color-slate-500)',
                    textTransform: 'uppercase',
                    '@media (width >= 48rem)': {
                      display: 'none'
                    }
                  })}>Status</div>
                  {task.updateAction ? <form method="post" action={task.updateAction} data-workflow="update-task-status" aria-busy={mutationPending.has(`status:${task.id}`) || undefined} mix={taskMutation(`status:${task.id}`)}>
                    {csrf(handle.props.csrfToken)}
                    <input type="hidden" name="status" value={task.completed ? 'open' : 'done'} />
                    <button type="submit" disabled={handle.props.disabled || draftActive || mutationPending.has(`status:${task.id}`)} mix={css({
                      ...(task.completed ? smallPrimaryButtonStyles : smallOutlineButtonStyles),
                      height: '2.75rem',
                      width: '100%',
                      '&:disabled': {
                        pointerEvents: 'none',
                        cursor: 'not-allowed',
                        opacity: '50%'
                      },
                      '@media (width >= 48rem)': {
                        height: '2rem',
                        width: 'auto'
                      }
                    })} data-testid={`task-toggle-${task.id}`}><CheckCheckIcon />{task.completed ? 'Done' : 'Mark done'}</button>
                  </form> : <span mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-700)" })}>{task.completed ? 'Done' : 'Open'}</span>}
                </div>

                <div mix={css({ minWidth: "0rem", "@media (width >= 48rem)": { padding: "0.5rem" } })}>
                  <div mix={css({ display: "flex", flexWrap: "wrap", gap: "0.5rem" })}>
                    {task.deleteAction ? <button type="button" disabled={handle.props.disabled || draftActive}  data-testid={`task-delete-${task.id}`} mix={[css({
                      ...smallDangerButtonStyles,
                      height: '2.75rem',
                      '&:disabled': {
                        pointerEvents: 'none',
                        cursor: 'not-allowed',
                        opacity: '50%'
                      },
                      '@media (width >= 48rem)': {
                        height: '2rem'
                      }
                    }), on('click', () => { void openDeleteDialog(task.id) })]}>Delete</button> : null}
                  </div>
                </div>
              </div>
            })}</div>
          </div> : <div mix={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            borderRadius: 'calc(var(--radius) * 1.8)',
            borderStyle: 'dashed',
            borderWidth: '1px',
            borderColor: 'var(--color-slate-300)',
            backgroundColor: 'var(--color-white)',
            paddingInline: '1rem',
            paddingBlock: '1.25rem',
            fontSize: '0.875rem',
            lineHeight: '1.42857143',
            color: 'var(--color-slate-500)',
            '@media (width >= 40rem)': {
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between'
            }
          })}>
            <span>No actions match these filters.</span>
            <button type="button" mix={[css(outlineButtonStyles), on('click', resetView)]}>Reset view</button>
          </div>}
        </div> : <div mix={css({
          display: 'grid',
          gap: '0.75rem',
          borderRadius: 'calc(var(--radius) * 1.8)',
          borderStyle: 'dashed',
          borderWidth: '1px',
          borderColor: 'var(--color-slate-300)',
          backgroundColor: 'var(--color-white)',
          paddingInline: '1rem',
          paddingBlock: '1.25rem',
          fontSize: '0.875rem',
          lineHeight: '1.42857143',
          color: 'var(--color-slate-500)'
        })}>
          <span>No actions have been added yet.</span>
          {!handle.props.createAction && handle.props.patient ? <div mix={css({
            borderRadius: '18px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'var(--color-slate-200)',
            backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
            paddingInline: '0.75rem',
            paddingBlock: '0.75rem',
            color: 'var(--color-slate-700)'
          })}>
            <div mix={css({ fontWeight: "500", color: "var(--color-slate-950)" })}>Start a patient handover before adding actions</div>
            <p mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Actions stay linked to handover context. Start this patient's receiving handover first, then add follow-up work from the same workspace.</p>
          </div> : null}
        </div>}
        </>}
      </div>

      {deleteTarget?.deleteAction ? <dialog aria-labelledby={`delete-task-${deleteTarget.id}-title`} aria-describedby={`delete-task-${deleteTarget.id}-description`}  data-testid="task-delete-dialog" mix={[css({
        margin: 'auto',
        width: 'calc(100% - 2rem)',
        maxWidth: '24rem',
        borderRadius: 'calc(var(--radius) * 1.4)',
        borderStyle: 'solid',
        borderWidth: '0px',
        backgroundColor: 'var(--popover)',
        padding: '1rem',
        fontSize: '0.875rem',
        lineHeight: '1.42857143',
        color: 'var(--popover-foreground)',
        boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent)',
        outlineStyle: 'none',
        '&::backdrop': {
          backgroundColor: 'color-mix(in oklab, var(--color-black) 10%, transparent)',
          WebkitBackdropFilter: 'blur(4px)',
          backdropFilter: 'blur(4px)'
        }
      }),
        ref((node) => { deleteDialog = node as HTMLDialogElement }),
        on('cancel', (event) => { event.preventDefault(); closeDeleteDialog() }),
        on('click', (event) => { if (event.target === event.currentTarget) closeDeleteDialog() }),
      ]}>
          <div mix={css({ display: "flex", flexDirection: "column", gap: "0.5rem" })}>
            <h2 id={`delete-task-${deleteTarget.id}-title`} mix={css({ fontFamily: "'Geist Variable', sans-serif", fontSize: "1rem", lineHeight: "1", fontWeight: "500" })}>Delete action?</h2>
            <p id={`delete-task-${deleteTarget.id}-description`} mix={css({ fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--muted-foreground)" })}>Delete "{deleteTarget.label}" permanently. This cannot be undone.</p>
          </div>
          <button type="button" aria-label="Close" mix={[css({
            position: 'absolute',
            top: '0.5rem',
            right: '0.5rem',
            display: 'inline-flex',
            width: '1.75rem',
            height: '1.75rem',
            cursor: 'pointer',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'min(calc(var(--radius) * 0.8), 12px)',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'transparent',
            color: 'var(--foreground)',
            transitionProperty: 'all',
            transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            transitionDuration: '150ms',
            outlineStyle: 'none',
            '&:hover': {
              '@media (hover: hover)': {
                backgroundColor: 'var(--muted)'
              }
            },
            '&:focus-visible': {
              borderColor: 'var(--ring)',
              boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
            }
          }), on('click', closeDeleteDialog)]}><XIcon /></button>
          <form method="post" action={deleteTarget.deleteAction}  data-workflow="delete-patient-task" aria-busy={mutationPending.has(`delete:${deleteTarget.id}`) || undefined} mix={[css({
            marginInline: '-1rem',
            marginBottom: '-1rem',
            display: 'flex',
            flexDirection: 'column-reverse',
            gap: '0.5rem',
            borderBottomRightRadius: 'calc(var(--radius) * 1.4)',
            borderBottomLeftRadius: 'calc(var(--radius) * 1.4)',
            borderTopStyle: 'solid',
            borderTopWidth: '1px',
            backgroundColor: 'color-mix(in oklab, var(--muted) 50%, transparent)',
            padding: '1rem',
            '@media (width >= 40rem)': {
              flexDirection: 'row',
              justifyContent: 'flex-end'
            }
          }), taskMutation(`delete:${deleteTarget.id}`, { onSuccess() { if (deleteDialog?.open) deleteDialog.close(); deleteTaskId = '' } })]}>
            {csrf(handle.props.csrfToken)}
            <button type="button" mix={[css(outlineButtonStyles), on('click', closeDeleteDialog)]}>Cancel</button>
            <button type="submit" disabled={mutationPending.has(`delete:${deleteTarget.id}`)} mix={css(dangerButtonStyles)}>Confirm delete action</button>
          </form>
      </dialog> : null}
    </section>
  }
})

function TaskCreateForm(handle: Handle<{
  action: string
  actionsHref?: string
  patientOptions: Array<{ key: string; label: string }>
  disabled?: boolean
  csrfToken?: string
  enhance?: boolean
}>) {
  let label = ''
  let dueAt = ''
  let dueLabel = DEFAULT_TASK_DUE_LABEL
  let dueLocal = ''
  let reminderEnabled = false
  let patientKey = handle.props.patientOptions[0]?.key ?? ''
  let pending = false
  let error = ''

  function updateDue(localValue: string) {
    dueLocal = localValue
    dueAt = taskDueIsoValue(localValue)
    dueLabel = dueAt ? formatTaskDueDateTime(dueAt) : DEFAULT_TASK_DUE_LABEL
    handle.update()
  }

  return () => {
    let singlePatient = handle.props.patientOptions.length === 1 ? handle.props.patientOptions[0] : null
    return <form method="post" action={handle.props.action}  data-workflow="create-task" aria-busy={pending || undefined} mix={[css({
      borderRadius: 'calc(var(--radius) * 1.8)',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'var(--color-white)',
      paddingInline: '1rem',
      paddingBlock: '1rem'
    }), handle.props.enhance ? enhanceFrameMutation(handle, {
      onPending(value) { pending = value; if (value) error = '' },
      onError(message) { error = message },
      onRefreshError() { error = 'The action was saved, but the page could not be refreshed.' },
      onSuccess() {
        label = ''
        dueAt = ''
        dueLabel = DEFAULT_TASK_DUE_LABEL
        dueLocal = ''
        reminderEnabled = false
        error = ''
      },
    }) : undefined]}>
    {csrf(handle.props.csrfToken)}
    {singlePatient ? <input type="hidden" name="patientKey" value={singlePatient.key} /> : null}
    <input type="hidden" name="priority" value="routine" />
    <input type="hidden" name="source" value="manual" />
    <input type="hidden" name="dueAt" value={dueAt} />
    <input type="hidden" name="dueLabel" value={dueLabel} />
    <input type="hidden" name="reminderEnabled" value={String(reminderEnabled)} />
    {error ? <div role="alert" mix={css({
      marginBottom: '0.75rem',
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
    })}>{error}</div> : null}
    <div mix={css({
      display: 'flex',
      flexDirection: 'column',
      gap: '0.5rem',
      '@media (width >= 40rem)': {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between'
      }
    })}>
      <div mix={css({ minWidth: "0rem" })}><div mix={css({ fontWeight: "500", color: "var(--color-slate-950)" })}>Add action</div><p mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--color-slate-600)" })}>Capture follow-up work that needs tracking even if it was not extracted from the transcript.</p></div>
      {singlePatient ? <span mix={css({
        display: 'inline-flex',
        height: '1.25rem',
        width: 'fit-content',
        flexShrink: '0',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'calc(var(--radius) * 2.6)',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'transparent',
        backgroundColor: 'color-mix(in oklab, var(--color-slate-950) 6%, transparent)',
        paddingInline: '0.5rem',
        paddingBlock: '0.125rem',
        fontSize: '0.75rem',
        lineHeight: '1.33333333',
        fontWeight: '500',
        whiteSpace: 'nowrap',
        color: 'var(--color-slate-700)',
        boxShadow: '0 0 0 1px color-mix(in oklab, var(--color-slate-950) 10%, transparent)'
      })}>{singlePatient.label}</span> : null}
    </div>
    <div mix={css({ marginTop: "1rem", display: "grid", gap: "0.75rem", "@media (width >= 64rem)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } })}>
      <label mix={css({ display: "grid", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-900)" })} htmlFor="new-task-label">Action title<input id="new-task-label" name="label" required value={label} disabled={handle.props.disabled} placeholder="Add a manual follow-up action" mix={[css({
        ...inputStyles,
        '&:disabled': {
          cursor: 'not-allowed',
          opacity: '50%'
        }
      }), on('input', (event) => { label = (event.currentTarget as HTMLInputElement).value; handle.update() })]} /></label>
      {handle.props.patientOptions.length > 1 ? <div mix={css({ display: "grid", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-900)" })}><label htmlFor="new-task-patient">Patient</label><TaskSelect
        key={`new-task-patient:${patientKey}`}
        id="new-task-patient"
        name="patientKey"
        value={patientKey}
        options={handle.props.patientOptions.map((patient) => ({ value: patient.key, label: patient.label }))}
        disabled={handle.props.disabled}
        ariaLabel="Patient"
        testId="new-task-patient-select"
        onChange={(value) => { patientKey = value; handle.update() }}
      /></div> : null}
      <TaskDueDateTimePicker id="new-task-due-at" value={dueLocal} testId="new-task-due-picker" disabled={handle.props.disabled} onChange={updateDue} />
      <noscript><label mix={css({ display: "grid", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--color-slate-900)" })} htmlFor="new-task-due-local">Due date and time<input id="new-task-due-local" name="dueLocal" type="datetime-local" step="60" value={dueLocal} mix={css(inputStyles)} /></label></noscript>
    </div>
    <div mix={css({
      marginTop: '1rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '0.75rem',
      borderRadius: 'calc(var(--radius) * 1.4)',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 70%, transparent)',
      paddingInline: '0.75rem',
      paddingBlock: '0.75rem',
      '@media (width >= 40rem)': {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between'
      }
    })}>
      <div><div mix={css({ fontSize: "11px", fontWeight: "500", letterSpacing: "0.16em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>Reminder</div><div mix={css({ marginTop: "0.25rem", fontSize: "0.875rem", lineHeight: "1.42857143", color: "var(--color-slate-600)" })}>Keep this action visible for the next review.</div></div>
      <div mix={css({ display: "flex", flexDirection: "column", gap: "0.75rem", "@media (width >= 40rem)": { flexDirection: "row", alignItems: "center" } })}>
        <div mix={css({ display: "flex", alignItems: "center", gap: "0.5rem" })}><BellIcon /><button type="button" role="switch" aria-checked={reminderEnabled} aria-label="Reminder for new action" disabled={handle.props.disabled} mix={[css({
          display: 'inline-flex',
          width: '2.75rem',
          height: '2.75rem',
          flexShrink: '0',
          cursor: 'pointer',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'calc(infinity * 1px)',
          borderStyle: 'solid',
          borderWidth: '1px',
          borderColor: 'transparent',
          transitionProperty: 'all',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          outlineStyle: 'none',
          '&:focus-visible': {
            borderColor: 'var(--ring)',
            boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
          },
          '&:disabled': {
            cursor: 'not-allowed',
            opacity: '50%'
          }
        }), on('click', () => { reminderEnabled = !reminderEnabled; handle.update() })]}><span mix={css({
          pointerEvents: 'none',
          display: 'inline-flex',
          height: '18.4px',
          width: '2rem',
          alignItems: 'center',
          borderRadius: 'calc(infinity * 1px)',
          ...(reminderEnabled ? {
            backgroundColor: 'var(--primary)'
          } : {
            backgroundColor: 'var(--input)'
          })
        })}><span mix={css({
          display: 'block',
          width: '1rem',
          height: '1rem',
          borderRadius: 'calc(infinity * 1px)',
          backgroundColor: 'var(--background)',
          transitionProperty: 'transform, translate, scale, rotate',
          transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
          transitionDuration: '150ms',
          ...(reminderEnabled ? {
            translate: 'calc(100% - 2px) 0'
          } : {
            translate: '0rem 0'
          })
        })} /></span></button></div>
        <button type="submit" disabled={handle.props.disabled || pending || !handle.props.patientOptions.length || !label.trim()} mix={css({
          ...primaryButtonStyles,
          minHeight: '2.75rem',
          '&:disabled': {
            pointerEvents: 'none',
            cursor: 'not-allowed',
            opacity: '50%'
          }
        })}><ClipboardIcon />{pending ? 'Adding action' : 'Add action'}</button>
        {handle.props.actionsHref ? <a href={handle.props.actionsHref} mix={[css({
          ...outlineButtonStyles,
          minHeight: '2.75rem'
        }), link(handle.props.actionsHref, { target: 'workspace', resetScroll: false })]} >Cancel</a> : null}
      </div>
    </div>
  </form>
  }
}

function TaskDueDateTimePicker(handle: Handle<{
  id: string
  value: string
  testId: string
  disabled?: boolean
  onChange: (value: string) => void
  onOpenChange?: (open: boolean) => void
}>) {
  let open = false
  let surface: HTMLElement | null = null
  let initialDate = taskDueLocalDate(handle.props.value) ?? new Date()
  let visibleMonth = new Date(initialDate.getFullYear(), initialDate.getMonth(), 1)
  let focusedDate = new Date(initialDate.getFullYear(), initialDate.getMonth(), initialDate.getDate())

  // Remix can reconcile a server-rendered popover node whose native top-layer
  // state outlives this component's local state. Always close the DOM surface,
  // even when `open` is already false, before its anchor changes.
  handle.frame.addEventListener('reloadStart', closePopover, { signal: handle.signal })

  function closePopover() {
    if (surface?.matches(':popover-open')) surface.hidePopover()
    if (open) updateOpen(false)
  }

  function updateOpen(nextOpen: boolean) {
    if (nextOpen) {
      let selectedDate = taskDueLocalDate(handle.props.value) ?? new Date()
      focusedDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate())
      visibleMonth = new Date(focusedDate.getFullYear(), focusedDate.getMonth(), 1)
    }
    open = nextOpen
    handle.props.onOpenChange?.(nextOpen)
    handle.update()
  }

  function updateDate(dateValue: string) {
    if (!dateValue) {
      handle.props.onChange('')
      return
    }
    let nextDate = taskDateFromLocalValue(dateValue)
    if (nextDate) focusedDate = nextDate
    let timeValue = taskDueTimeValue(handle.props.value) || currentLocalTimeValue()
    handle.props.onChange(`${dateValue}T${timeValue}`)
  }

  function updateTime(timeValue: string) {
    let dateValue = taskDueDateValue(handle.props.value)
    if (!dateValue || !timeValue) return
    handle.props.onChange(`${dateValue}T${timeValue}`)
  }

  function moveCalendarFocus(date: Date, focusCell: boolean) {
    focusedDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    visibleMonth = new Date(focusedDate.getFullYear(), focusedDate.getMonth(), 1)
    let update = handle.update()
    if (!focusCell) return
    void update.then((signal) => {
      if (signal.aborted) return
      surface?.querySelector<HTMLButtonElement>(`[data-testid="${handle.props.testId}-day-${taskLocalDateValue(focusedDate)}"]`)?.focus()
    })
  }

  function moveCalendarMonth(year: number, month: number, focusCell = false) {
    let day = Math.min(focusedDate.getDate(), new Date(year, month + 1, 0).getDate())
    moveCalendarFocus(new Date(year, month, day), focusCell)
  }

  function handleCalendarKeyDown(event: KeyboardEvent, day: Date) {
    let nextDate: Date | undefined
    if (event.key === 'ArrowLeft') nextDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1)
    if (event.key === 'ArrowRight') nextDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    if (event.key === 'ArrowUp') nextDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 7)
    if (event.key === 'ArrowDown') nextDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 7)
    if (event.key === 'Home') nextDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() - day.getDay())
    if (event.key === 'End') nextDate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (6 - day.getDay()))
    if (event.key === 'PageUp') nextDate = taskShiftCalendarMonth(day, event.shiftKey ? -12 : -1)
    if (event.key === 'PageDown') nextDate = taskShiftCalendarMonth(day, event.shiftKey ? 12 : 1)
    if (!nextDate) return
    event.preventDefault()
    moveCalendarFocus(nextDate, true)
  }

  return () => {
    let dateValue = taskDueDateValue(handle.props.value)
    let timeValue = taskDueTimeValue(handle.props.value)
    let selectedDate = taskDueLocalDate(handle.props.value)
    let triggerLabel = handle.props.value
      ? formatTaskDueDateTime(taskDueIsoValue(handle.props.value))
      : DEFAULT_TASK_DUE_LABEL
    let today = new Date()
    let calendarDays = taskCalendarDays(visibleMonth)
    let currentYear = today.getFullYear()
    let firstYear = Math.min(currentYear - 100, visibleMonth.getFullYear())
    let lastYear = Math.max(currentYear + 10, visibleMonth.getFullYear())

    return <div mix={css({ display: "grid", gap: "0.375rem" })}>
      <label mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="" htmlFor={handle.props.id}>Due date and time</label>
      <popover.Context>
        <button
          id={handle.props.id}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={handle.props.disabled}
          data-testid={handle.props.testId}
          mix={[css({
            ...inputStyles,
            display: 'flex',
            minHeight: '2.75rem',
            cursor: 'pointer',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: '0.375rem',
            textAlign: 'left',
            fontWeight: '400',
            '&:disabled': {
              cursor: 'not-allowed',
              opacity: '50%'
            },
            ...(handle.props.value ? {
              color: 'var(--color-slate-900)'
            } : {
              color: 'var(--color-slate-500)'
            })
          }),
            popover.anchor({ placement: 'bottom-start' }),
            popover.focusOnHide(),
            ref((_button, signal) => {
              window.navigation?.addEventListener('navigate', () => {
                closePopover()
              }, { signal })
            }),
            on('click', () => updateOpen(!open)),
          ]}
        ><CalendarIcon /><span mix={css({ minWidth: "0rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{triggerLabel}</span></button>

        <section
          role="dialog"
          aria-label="Schedule action"
          data-testid={`${handle.props.testId}-popover`}
          mix={[css({
            zIndex: '50',
            display: 'flex',
            width: 'min(20rem, calc(100vw - 2rem))',
            flexDirection: 'column',
            gap: '0rem',
            overflow: 'hidden',
            borderRadius: 'var(--radius)',
            backgroundColor: 'var(--popover)',
            padding: '0rem',
            fontSize: '0.875rem',
            lineHeight: '1.42857143',
            color: 'var(--popover-foreground)',
            boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
            outlineStyle: 'none',
            '&:not(:popover-open)': {
              display: 'none'
            }
          }),
            popover.surface({
              open,
              closeOnAnchorClick: false,
              stopOutsideClickPropagation: false,
              onHide() {
                updateOpen(false)
              },
            }),
            ref((node, signal) => {
              surface = node
              if (!open && node.matches(':popover-open')) node.hidePopover()
              signal.addEventListener('abort', () => {
                if (node.matches(':popover-open')) node.hidePopover()
                if (surface === node) surface = null
              }, { once: true })
            }),
          ]}
        >
          <header mix={css({
            display: 'flex',
            flexDirection: 'column',
            gap: '0.125rem',
            borderBottomStyle: 'solid',
            borderBottomWidth: '1px',
            paddingInline: '0.75rem',
            paddingBlock: '0.625rem',
            fontSize: '0.875rem',
            lineHeight: '1.42857143'
          })}>
            <h3 mix={css({ fontFamily: "'Geist Variable', sans-serif", fontWeight: "500" })}>Schedule action</h3>
            <p mix={css({ color: "var(--muted-foreground)" })}>Choose a concrete due date and time for this action.</p>
          </header>
          <div mix={css({ width: "100%", padding: "0.5rem" })} data-testid={`${handle.props.testId}-calendar`}>
            <div mix={css({ position: "relative", display: "flex", height: "2.5rem", width: "100%", alignItems: "center", justifyContent: "center", paddingInline: "2.5rem" })}>
              <button
                type="button"
                aria-label="Go to previous month"
                mix={[css({
                  position: 'absolute',
                  top: '0rem',
                  left: '0rem',
                  display: 'inline-flex',
                  width: '2.5rem',
                  height: '2.5rem',
                  cursor: 'pointer',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius)',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'transparent',
                  color: 'var(--foreground)',
                  outlineStyle: 'none',
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                  '&:hover': {
                    '@media (hover: hover)': {
                      backgroundColor: 'var(--muted)'
                    }
                  },
                  '&:focus-visible': {
                    borderColor: 'var(--ring)',
                    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                  }
                }), on('click', () => {
                  moveCalendarMonth(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1)
                })]}
              ><ChevronLeftIcon /></button>
              <div mix={css({
                display: 'flex',
                height: '2.5rem',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.375rem',
                fontSize: '0.875rem',
                lineHeight: '1.42857143',
                fontWeight: '500'
              })}>
                <label mix={css({ position: "relative", display: "flex", minHeight: "2.5rem", alignItems: "center", gap: "0.25rem", borderRadius: "var(--radius)", paddingInline: "0.375rem" })}>
                  <span>{monthLabelsLong[visibleMonth.getMonth()]}</span><ChevronDownIcon />
                  <select
                    aria-label="Choose month"
                    mix={[css({ position: "absolute", inset: "0rem", cursor: "pointer", opacity: "0%" }), on('change', (event) => {
                      moveCalendarMonth(visibleMonth.getFullYear(), Number((event.currentTarget as HTMLSelectElement).value))
                    })]}
                  >{monthLabelsLong.map((label, index) => <option key={label} value={String(index)} selected={index === visibleMonth.getMonth()}>{label}</option>)}</select>
                </label>
                <label mix={css({ position: "relative", display: "flex", minHeight: "2.5rem", alignItems: "center", gap: "0.25rem", borderRadius: "var(--radius)", paddingInline: "0.375rem" })}>
                  <span>{visibleMonth.getFullYear()}</span><ChevronDownIcon />
                  <select
                    aria-label="Choose year"
                    mix={[css({ position: "absolute", inset: "0rem", cursor: "pointer", opacity: "0%" }), on('change', (event) => {
                      moveCalendarMonth(Number((event.currentTarget as HTMLSelectElement).value), visibleMonth.getMonth())
                    })]}
                  >{Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index).map((year) => <option key={year} value={String(year)} selected={year === visibleMonth.getFullYear()}>{year}</option>)}</select>
                </label>
              </div>
              <button
                type="button"
                aria-label="Go to next month"
                mix={[css({
                  position: 'absolute',
                  top: '0rem',
                  right: '0rem',
                  display: 'inline-flex',
                  width: '2.5rem',
                  height: '2.5rem',
                  cursor: 'pointer',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius)',
                  borderStyle: 'solid',
                  borderWidth: '1px',
                  borderColor: 'transparent',
                  color: 'var(--foreground)',
                  outlineStyle: 'none',
                  WebkitUserSelect: 'none',
                  userSelect: 'none',
                  '&:hover': {
                    '@media (hover: hover)': {
                      backgroundColor: 'var(--muted)'
                    }
                  },
                  '&:focus-visible': {
                    borderColor: 'var(--ring)',
                    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                  }
                }), on('click', () => {
                  moveCalendarMonth(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1)
                })]}
              ><ChevronRightIcon /></button>
            </div>
            <div mix={css({ marginTop: "1rem", display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))" })} aria-hidden="true">
              {weekdayLabels.map((label) => <div key={label} mix={css({
                display: 'flex',
                height: '1.75rem',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius)',
                fontSize: '0.8rem',
                fontWeight: '400',
                color: 'var(--muted-foreground)',
                WebkitUserSelect: 'none',
                userSelect: 'none'
              })}>{label}</div>)}
            </div>
            <div mix={css({ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", rowGap: "0.5rem" })} role="grid" aria-label={`${monthLabelsLong[visibleMonth.getMonth()]} ${visibleMonth.getFullYear()}`}>
              {calendarDays.map((day) => {
                let value = taskLocalDateValue(day)
                let selected = Boolean(selectedDate && sameLocalDay(day, selectedDate))
                let isToday = sameLocalDay(day, today)
                let outside = day.getMonth() !== visibleMonth.getMonth()
                let focused = sameLocalDay(day, focusedDate)
                return <button
                  key={value}
                  type="button"
                  role="gridcell"
                  tabIndex={focused ? 0 : -1}
                  aria-label={day.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  aria-selected={selected}
                  aria-current={isToday ? 'date' : undefined}
                  data-testid={`${handle.props.testId}-day-${value}`}
                  disabled={handle.props.disabled}
                  mix={[css({
                    position: 'relative',
                    isolation: 'isolate',
                    zIndex: '10',
                    display: 'inline-flex',
                    height: '2.5rem',
                    width: '100%',
                    minWidth: '2.5rem',
                    cursor: 'pointer',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 'var(--radius)',
                    borderStyle: 'solid',
                    borderWidth: '1px',
                    borderColor: 'transparent',
                    fontSize: '0.875rem',
                    lineHeight: '1',
                    fontWeight: '400',
                    outlineStyle: 'none',
                    WebkitUserSelect: 'none',
                    userSelect: 'none',
                    '&:hover': {
                      '@media (hover: hover)': {
                        backgroundColor: 'var(--muted)'
                      }
                    },
                    '&:focus-visible': {
                      borderColor: 'var(--ring)',
                      boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
                    },
                    '&:disabled': {
                      pointerEvents: 'none',
                      opacity: '50%'
                    },
                    ...(isToday && !selected ? {
                      backgroundColor: 'var(--muted)',
                      color: 'var(--foreground)'
                    } : {}),
                    ...(outside ? {
                      color: 'var(--muted-foreground)'
                    } : {}),
                    ...(selected ? {
                      backgroundColor: 'var(--primary)',
                      color: 'var(--primary-foreground)',
                      '&:hover': {
                        '@media (hover: hover)': {
                          backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
                        }
                      }
                    } : {})
                  }),
                    focused ? popover.focusOnShow() : undefined,
                    on('keydown', (event) => handleCalendarKeyDown(event, day)),
                    on('click', () => updateDate(value)),
                  ]}
                >{day.getDate()}</button>
              })}
            </div>
          </div>
          <div mix={css({ borderTopStyle: "solid", borderTopWidth: "1px", padding: "0.75rem" })}>
            <div mix={css({ display: "grid", gap: "0.625rem" })}>
              <label mix={css({ display: "grid", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.42857143", fontWeight: "500", color: "var(--foreground)" })} htmlFor={`${handle.props.id}-time`}>
                Due time
                <input
                  id={`${handle.props.id}-time`}
                  type="time"
                  step="60"
                  value={timeValue}
                  disabled={handle.props.disabled || !dateValue}
                  mix={[css({
                    ...inputStyles,
                    minHeight: '2.75rem',
                    '&:disabled': {
                      cursor: 'not-allowed',
                      opacity: '50%'
                    }
                  }), on('input', (event) => updateTime((event.currentTarget as HTMLInputElement).value))]}
                />
              </label>
              {!dateValue ? <p mix={css({ fontSize: "0.875rem", lineHeight: "1.5rem", color: "var(--muted-foreground)" })}>Select a date first, then choose a time.</p> : null}
            </div>
          </div>
        </section>
      </popover.Context>
    </div>
  }
}

function ViewSelect(handle: Handle<{
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  testId: string
  styles?: Parameters<typeof css>[0]
  onChange: (value: string) => void
}>) {
  return () => <>
    <TaskSelect
      key={`${handle.props.testId}:${handle.props.value}`}
      value={handle.props.value}
      options={handle.props.options}
      disabled={handle.props.options.length <= 1}
      ariaLabel={`${handle.props.label} actions`}
      testId={handle.props.testId}
      styles={handle.props.styles ?? { width: "100%" }}
      prefix={handle.props.label}
      variant="filter"
      onChange={(value) => handle.props.onChange(value)}
    />
  </>
}

function TaskSelectValue(handle: Handle) {
  let context = handle.context.get(select.Context)
  return () => <span mix={css({ minWidth: "0rem", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" })}>{context.displayedLabel}</span>
}

function TaskSelect(handle: Handle<{
  id?: string
  name?: string
  value: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  ariaLabel: string
  testId: string
  styles?: Parameters<typeof css>[0]
  prefix?: string
  variant?: 'field' | 'filter'
  onChange: (value: string, trigger: HTMLButtonElement) => void
}>) {
  return () => {
    let selectedLabel = handle.props.options.find((option) => option.value === handle.props.value)?.label ?? handle.props.options[0]?.label ?? handle.props.ariaLabel
    let filter = handle.props.variant === 'filter'
    let triggerStyles: Parameters<typeof css>[0] = filter ? {
      display: 'inline-flex',
      height: '2.75rem',
      minWidth: '0rem',
      cursor: 'pointer',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '0.375rem',
      borderRadius: 'calc(infinity * 1px)',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'color-mix(in oklab, var(--color-slate-200) 90%, transparent)',
      backgroundColor: 'color-mix(in oklab, var(--color-slate-50) 80%, transparent)',
      paddingInline: '0.625rem',
      fontSize: '0.75rem',
      lineHeight: '1.33333333',
      fontWeight: '500',
      color: 'var(--color-slate-700)',
      boxShadow: 'none',
      outlineStyle: 'none',
      WebkitUserSelect: 'none',
      userSelect: 'none',
      '&:hover': {
        '@media (hover: hover)': {
          backgroundColor: 'color-mix(in oklab, var(--color-slate-100) 80%, transparent)'
        }
      },
      '&:focus-visible': {
        borderColor: 'var(--ring)',
        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
      },
      '&:disabled': {
        cursor: 'not-allowed',
        backgroundColor: 'var(--color-slate-50)',
        color: 'var(--color-slate-500)'
      },
      '@media (width >= 48rem)': {
        height: '2rem'
      },
      ...(handle.props.styles ?? {
        width: '100%'
      })
    } : {
      display: 'flex',
      height: '2.75rem',
      minWidth: '0rem',
      cursor: 'pointer',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '0.375rem',
      borderRadius: 'var(--radius)',
      borderStyle: 'solid',
      borderWidth: '1px',
      borderColor: 'var(--input)',
      backgroundColor: 'transparent',
      paddingBlock: '0.5rem',
      paddingRight: '0.5rem',
      paddingLeft: '0.625rem',
      fontSize: '0.875rem',
      lineHeight: '1.42857143',
      whiteSpace: 'nowrap',
      outlineStyle: 'none',
      WebkitUserSelect: 'none',
      userSelect: 'none',
      '&:focus-visible': {
        borderColor: 'var(--ring)',
        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
      },
      '&:disabled': {
        cursor: 'not-allowed',
        opacity: '50%'
      },
      ...(handle.props.styles ?? {
        width: '100%'
      })
    }

    return <select.Context
      defaultLabel={selectedLabel}
      defaultValue={handle.props.value}
      disabled={handle.props.disabled}
      name={handle.props.name}
    >
      <button
        id={handle.props.id}
        type="button"
        aria-label={handle.props.ariaLabel}
        data-testid={handle.props.testId}
        data-value={handle.props.value}
        mix={[css(triggerStyles), select.trigger(), onSelectChange((event) => {
          if (event.value) handle.props.onChange(event.value, event.currentTarget as HTMLButtonElement)
        })]}
      >
        {handle.props.prefix ? <span mix={css({ flexShrink: "0", fontSize: "11px", fontWeight: "600", letterSpacing: "0.12em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{handle.props.prefix}</span> : null}
        <TaskSelectValue />
        <ChevronDownIcon styles={{ width: "1rem", height: "1rem", flexShrink: "0", color: "var(--muted-foreground)" }} />
      </button>
      <popover.Context>
        <div mix={[css({
          zIndex: '50',
          maxHeight: '50dvh',
          minWidth: '11rem',
          overflow: 'hidden',
          borderRadius: 'var(--radius)',
          backgroundColor: 'var(--popover)',
          color: 'var(--popover-foreground)',
          boxShadow: '0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent), 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
          outlineStyle: 'none'
        }), select.popover()]}>
          <div mix={[css({
            display: 'flex',
            minHeight: '0rem',
            flexDirection: 'column',
            overflow: 'auto',
            padding: '0.25rem',
            outlineStyle: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none'
          }), select.list()]}>
            {handle.props.options.map((option) => <div
              key={option.value}
              data-select-value={option.value}
              mix={[css({
                position: 'relative',
                display: 'flex',
                minHeight: '2.75rem',
                width: '100%',
                cursor: 'default',
                alignItems: 'center',
                gap: '0.375rem',
                borderRadius: 'calc(var(--radius) * 0.8)',
                paddingBlock: '0.25rem',
                paddingRight: '2rem',
                paddingLeft: '0.375rem',
                fontSize: '0.875rem',
                lineHeight: '1.42857143',
                whiteSpace: 'nowrap',
                outlineStyle: 'none',
                WebkitUserSelect: 'none',
                userSelect: 'none',
                '&[aria-disabled="true"]': {
                  pointerEvents: 'none',
                  opacity: '50%'
                },
                '&[data-highlighted="true"]': {
                  backgroundColor: 'var(--accent)',
                  color: 'var(--accent-foreground)'
                },
                '&[aria-selected=true] [data-task-select-check]': {
                  opacity: '100%'
                }
              }), select.option({ label: option.label, value: option.value })]}
            >
              <span mix={css({ minWidth: "0rem", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" })}>{option.label}</span>
              <span data-task-select-check mix={css({
                pointerEvents: 'none',
                position: 'absolute',
                right: '0.5rem',
                display: 'flex',
                width: '1rem',
                height: '1rem',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: '0%'
              })}><CheckIcon /></span>
            </div>)}
          </div>
        </div>
      </popover.Context>
      {handle.props.name ? <input mix={select.hiddenInput()} /> : null}
    </select.Context>
  }
}

function taskDueDateValue(localValue: string) {
  return localValue.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)?.[0].slice(0, 10) ?? ''
}

function taskDueTimeValue(localValue: string) {
  return localValue.match(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})$/)?.[1] ?? ''
}

function taskDueLocalDate(localValue: string) {
  let match = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) return null
  let [, yearValue, monthValue, dayValue, hourValue, minuteValue] = match
  let year = Number(yearValue)
  let month = Number(monthValue) - 1
  let day = Number(dayValue)
  let hour = Number(hourValue)
  let minute = Number(minuteValue)
  let date = new Date(year, month, day, hour, minute)
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null
}

function taskCalendarDays(month: Date) {
  let first = new Date(month.getFullYear(), month.getMonth(), 1)
  let start = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay())
  return Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index))
}

function taskLocalDateValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function taskDateFromLocalValue(value: string) {
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  let [, yearValue, monthValue, dayValue] = match
  let year = Number(yearValue)
  let month = Number(monthValue) - 1
  let day = Number(dayValue)
  let date = new Date(year, month, day)
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null
}

function taskShiftCalendarMonth(date: Date, monthOffset: number) {
  let firstOfTargetMonth = new Date(date.getFullYear(), date.getMonth() + monthOffset, 1)
  let lastDay = new Date(firstOfTargetMonth.getFullYear(), firstOfTargetMonth.getMonth() + 1, 0).getDate()
  return new Date(firstOfTargetMonth.getFullYear(), firstOfTargetMonth.getMonth(), Math.min(date.getDate(), lastDay))
}

function sameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

function currentLocalTimeValue() {
  let now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function csrf(token?: string): RemixNode {
  return token ? <input type="hidden" name="_csrf" value={token} /> : null
}

function taskScopeOptions(tasks: TaskSummary[], patientOptions: Array<{ key: string; label: string }>, timeZone?: string) {
  let patientLabelByKey = new Map(patientOptions.map((patient) => [patient.key, patient.label]))
  let patientKeys = [...new Set(tasks.map((task) => task.patientKey).filter((value): value is string => Boolean(value && patientLabelByKey.has(value))))]
  let handoverTasks = tasks.filter((task) => Boolean(task.handoverId && taskHandoverLabel(task, timeZone)))
  let handoverIds = [...new Set(handoverTasks.map((task) => task.handoverId).filter((value): value is string => Boolean(value)))]
  let multiplePatients = patientOptions.length > 1
  return [
    { value: 'all', label: handoverIds.length ? 'All handovers' : multiplePatients ? 'All patients' : 'All actions' },
    ...(multiplePatients ? patientKeys.map((patientKey) => ({ value: `patient:${patientKey}`, label: patientLabelByKey.get(patientKey)! })) : []),
    ...handoverIds.map((handoverId) => ({
      value: `handover:${handoverId}`,
      label: taskHandoverLabel(handoverTasks.find((task) => task.handoverId === handoverId)!, timeZone)!,
    })),
  ]
}

function taskMetaLabel(task: TaskSummary, patientLabel?: string, timeZone?: string) {
  return [patientLabel, taskHandoverLabel(task, timeZone), getTaskDueDisplay(task.dueAt, timeZone)].filter(Boolean).join(' • ')
}

function taskHandoverLabel(task: TaskSummary, timeZone?: string) {
  if (!task.handoverDirection || !task.handoverUpdatedAt) return null
  let direction = task.handoverDirection === 'outgoing'
    ? 'Delivering'
    : task.handoverDirection === 'intra-shift'
      ? 'Intra-shift'
      : 'Receiving'
  return `${direction} · ${formatCompactTimestamp(task.handoverUpdatedAt, timeZone)}`
}

function formatCompactTimestamp(value: string, timeZone?: string) {
  let date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'recently'
  let parts = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(date)
  let part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? ''
  return `${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
}

function ClipboardIcon(handle: Handle<{ styles?: Parameters<typeof css>[0] }>) { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css(handle.props.styles ?? { width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 12h6M9 16h6" /></svg> }
function CalendarIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4M16 2v4M3 10h18" /><rect width="18" height="18" x="3" y="4" rx="2" /></svg> }
function ChevronDownIcon(handle: Handle<{ styles?: Parameters<typeof css>[0] }>) { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css(handle.props.styles ?? { width: "0.875rem", height: "0.875rem", color: "var(--muted-foreground)" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg> }
function ChevronLeftIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg> }
function ChevronRightIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg> }
function CheckIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6" /></svg> }
function BellIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem", color: "var(--color-slate-500)" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 21a2 2 0 0 0 3.4 0" /><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /></svg> }
function CheckCheckIcon() { return () => <svg data-icon="inline-start" viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "1rem", height: "1rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 6-11 11-5-5" /><path d="m22 10-7.5 7.5L13 16" /></svg> }
function XIcon() { return () => <svg viewBox="0 0 24 24" aria-hidden="true" mix={css({ width: "0.875rem", height: "0.875rem" })} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg> }
const reminderOptions = [{ value: 'all', label: 'All reminders' }, { value: 'on', label: 'Reminder on' }, { value: 'off', label: 'Reminder off' }]
const statusOptions = [{ value: 'all', label: 'All statuses' }, { value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }]
const sortOptions = [
  { value: 'current', label: 'Current order' },
  { value: 'title-asc', label: 'Action A–Z' },
  { value: 'title-desc', label: 'Action Z–A' },
  { value: 'open-first', label: 'Open first' },
  { value: 'done-first', label: 'Done first' },
  { value: 'reminder-on-first', label: 'Reminder on first' },
]

const monthLabelsLong = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const weekdayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const inputStyles: Parameters<typeof css>[0] = {
  display: 'block',
  height: '2rem',
  width: '100%',
  minWidth: '0rem',
  borderRadius: 'var(--radius)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'var(--input)',
  backgroundColor: 'transparent',
  paddingInline: '0.625rem',
  paddingBlock: '0.25rem',
  fontSize: '1rem',
  lineHeight: '1.5',
  transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&::placeholder': {
    color: 'var(--muted-foreground)'
  },
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  },
  '@media (width >= 48rem)': {
    fontSize: '0.875rem',
    lineHeight: '1.42857143'
  }
}
const buttonBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '2rem',
  flexShrink: '0',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.375rem',
  borderRadius: 'calc(infinity * 1px)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  paddingInline: '0.625rem',
  fontSize: '0.875rem',
  lineHeight: '1.42857143',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  }
}
const smallButtonBaseStyles: Parameters<typeof css>[0] = {
  display: 'inline-flex',
  height: '1.75rem',
  flexShrink: '0',
  cursor: 'pointer',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  borderRadius: 'calc(infinity * 1px)',
  borderStyle: 'solid',
  borderWidth: '1px',
  borderColor: 'transparent',
  paddingInline: '0.625rem',
  fontSize: '0.8rem',
  fontWeight: '500',
  whiteSpace: 'nowrap',
  transitionProperty: 'all',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  transitionDuration: '150ms',
  outlineStyle: 'none',
  '&:focus-visible': {
    borderColor: 'var(--ring)',
    boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)'
  }
}
const primaryButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  textDecorationLine: 'none',
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
  textDecorationLine: 'none',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'var(--muted)'
    }
  }
}
const dangerButtonStyles: Parameters<typeof css>[0] = {
  ...buttonBaseStyles,
  backgroundColor: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
  color: 'var(--destructive)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'color-mix(in oklab, var(--destructive) 20%, transparent)'
    }
  }
}
const smallPrimaryButtonStyles: Parameters<typeof css>[0] = {
  ...smallButtonBaseStyles,
  backgroundColor: 'var(--primary)',
  color: 'var(--primary-foreground)',
  textDecorationLine: 'none',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)'
    }
  }
}
const smallOutlineButtonStyles: Parameters<typeof css>[0] = {
  ...smallButtonBaseStyles,
  borderColor: 'transparent',
  backgroundColor: 'var(--background)',
  color: 'var(--foreground)',
  textDecorationLine: 'none',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'var(--muted)'
    }
  }
}
const smallDangerButtonStyles: Parameters<typeof css>[0] = {
  ...smallButtonBaseStyles,
  backgroundColor: 'color-mix(in oklab, var(--destructive) 10%, transparent)',
  color: 'var(--destructive)',
  '&:hover': {
    '@media (hover: hover)': {
      backgroundColor: 'color-mix(in oklab, var(--destructive) 20%, transparent)'
    }
  }
}
