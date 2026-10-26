import { css, clientEntry, on, type Handle, type SerializableProps } from 'remix/component'

interface NewShiftFormProps extends SerializableProps {
  action: string
  assignedUserId?: string
  csrfToken?: string
  defaultTitle?: string
  defaultDepartment?: string
}

/** React-parity pending feedback around the ordinary native shift creation POST. */
export const NewShiftForm = clientEntry(
  import.meta.url + '#NewShiftForm',
  function NewShiftForm(handle: Handle<NewShiftFormProps>) {
    let pending = false
    let title = handle.props.defaultTitle ?? 'Day shift'
    let department = handle.props.defaultDepartment ?? ''
    let notes = ''
    let titleError = ''
    let departmentError = ''
    let validationFocusQueued = false

    function queueValidationFocus() {
      if (!validationFocusQueued) {
        validationFocusQueued = true
        handle.queueTask(() => {
          document.querySelector<HTMLElement>('[data-testid="new-shift-form"] [aria-invalid="true"]')?.focus()
          validationFocusQueued = false
        })
      }
    }

    function showFieldError(target: HTMLInputElement) {
      if (target.name === 'title') titleError = shiftTitleError(target.value)
      if (target.name === 'department') departmentError = shiftDepartmentError(target.value)
      queueValidationFocus()
      void handle.update()
    }

    return () => (
      <form
        method="post"
        action={handle.props.action}
        aria-busy={pending || undefined}
        data-testid="new-shift-form"
        data-workflow="start-shift"
        data-study-task="task-start-shift"
        mix={[
          css({ display: 'grid', gap: '1rem' }),
          on('submit', (event) => {
            let data = new FormData(event.currentTarget)
            title = String(data.get('title') ?? '')
            department = String(data.get('department') ?? '')
            notes = String(data.get('notes') ?? '')
            titleError = shiftTitleError(title)
            departmentError = shiftDepartmentError(department)
            if (titleError || departmentError) {
              event.preventDefault()
              pending = false
              queueValidationFocus()
              void handle.update()
              return
            }
            pending = true
            handle.update()
          }),
        ]}
      >
        {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
        <input
          type="hidden"
          name="assignedUserIds"
          value={JSON.stringify(handle.props.assignedUserId ? [handle.props.assignedUserId] : [])}
        />
        <div
          data-slot="field-group"
          mix={css({
            containerType: 'inline-size',
            containerName: 'field-group',
            display: 'flex',
            width: '100%',
            flexDirection: 'column',
            gap: '1rem',
            '&[data-slot=checkbox-group]': { gap: '0.75rem' },
            '& > *': { '&[data-slot=field-group]': { gap: '1rem' } },
          })}
        >
          <div
            mix={css({
              display: 'grid',
              gap: '1rem',
              '@media (min-width: 48rem)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
            })}
          >
            <div
              role="group"
              data-slot="field"
              data-orientation="vertical"
              mix={css({
                display: 'flex',
                width: '100%',
                flexDirection: 'column',
                gap: '0.5rem',
                '& > *': { width: '100%' },
                '&>[data-visually-hidden]': { width: 'auto' },
              })}
            >
              <label
                data-slot="field-label"
                mix={css({
                  display: 'flex',
                  width: 'fit-content',
                  gap: '0.5rem',
                  fontSize: '.875rem',
                  lineHeight: 1.375,
                  fontWeight: 500,
                })}
                htmlFor="shift-title"
              >
                Shift title
              </label>
              <div
                data-slot="field-content"
                mix={css({ display: 'flex', flex: '1', flexDirection: 'column', gap: '0.25rem', lineHeight: 1.375 })}
              >
                <input
                  data-slot="input"
                  id="shift-title"
                  name="title"
                  placeholder="Day shift"
                  value={title}
                  required
                  minLength={3}
                  maxLength={120}
                  aria-invalid={Boolean(titleError) || undefined}
                  aria-describedby={titleError ? 'shift-title-error' : undefined}
                  mix={[
                    css({
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
                      transitionProperty:
                        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      outlineStyle: 'none',
                      '&::placeholder': { color: 'var(--muted-foreground)' },
                      '&:focus-visible': {
                        borderColor: 'var(--ring)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
                      },
                      '&[aria-invalid="true"]': {
                        borderColor: 'var(--destructive)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)',
                      },
                      '@media (min-width: 48rem)': { fontSize: '.875rem', lineHeight: 1.4285714285714286 },
                    }),
                    on('input', (event) => {
                      title = event.currentTarget.value
                      titleError = ''
                      void handle.update()
                    }),
                    on('invalid', (event) => showFieldError(event.currentTarget)),
                  ]}
                />
                {titleError ? (
                  <span
                    id="shift-title-error"
                    mix={css({ fontSize: '.75rem', lineHeight: '1.25rem', color: 'var(--color-rose-700)' })}
                  >
                    {titleError}
                  </span>
                ) : null}
              </div>
            </div>
            <div
              role="group"
              data-slot="field"
              data-orientation="vertical"
              mix={css({
                display: 'flex',
                width: '100%',
                flexDirection: 'column',
                gap: '0.5rem',
                '& > *': { width: '100%' },
                '&>[data-visually-hidden]': { width: 'auto' },
              })}
            >
              <label
                data-slot="field-label"
                mix={css({
                  display: 'flex',
                  width: 'fit-content',
                  gap: '0.5rem',
                  fontSize: '.875rem',
                  lineHeight: 1.375,
                  fontWeight: 500,
                })}
                htmlFor="shift-department"
              >
                Department
              </label>
              <div
                data-slot="field-content"
                mix={css({ display: 'flex', flex: '1', flexDirection: 'column', gap: '0.25rem', lineHeight: 1.375 })}
              >
                <input
                  data-slot="input"
                  id="shift-department"
                  name="department"
                  value={department}
                  required
                  minLength={2}
                  maxLength={80}
                  aria-invalid={Boolean(departmentError) || undefined}
                  aria-describedby={departmentError ? 'shift-department-error' : undefined}
                  mix={[
                    css({
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
                      transitionProperty:
                        'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                      transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                      transitionDuration: '150ms',
                      outlineStyle: 'none',
                      '&::placeholder': { color: 'var(--muted-foreground)' },
                      '&:focus-visible': {
                        borderColor: 'var(--ring)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
                      },
                      '&[aria-invalid="true"]': {
                        borderColor: 'var(--destructive)',
                        boxShadow: '0 0 0 3px color-mix(in oklab, var(--destructive) 20%, transparent)',
                      },
                      '@media (min-width: 48rem)': { fontSize: '.875rem', lineHeight: 1.4285714285714286 },
                    }),
                    on('input', (event) => {
                      department = event.currentTarget.value
                      departmentError = ''
                      void handle.update()
                    }),
                    on('invalid', (event) => showFieldError(event.currentTarget)),
                  ]}
                />
                {departmentError ? (
                  <span
                    id="shift-department-error"
                    mix={css({ fontSize: '.75rem', lineHeight: '1.25rem', color: 'var(--color-rose-700)' })}
                  >
                    {departmentError}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div
            role="group"
            data-slot="field"
            data-orientation="vertical"
            mix={css({
              display: 'flex',
              width: '100%',
              flexDirection: 'column',
              gap: '0.5rem',
              '& > *': { width: '100%' },
              '&>[data-visually-hidden]': { width: 'auto' },
            })}
          >
            <label
              data-slot="field-label"
              mix={css({
                display: 'flex',
                width: 'fit-content',
                gap: '0.5rem',
                fontSize: '.875rem',
                lineHeight: 1.375,
                fontWeight: 500,
              })}
              htmlFor="shift-notes"
            >
              Shift notes
            </label>
            <div
              data-slot="field-content"
              mix={css({ display: 'flex', flex: '1', flexDirection: 'column', gap: '0.125rem', lineHeight: 1.375 })}
            >
              <textarea
                data-slot="textarea"
                id="shift-notes"
                name="notes"
                rows={3}
                maxLength={500}
                placeholder="Optional"
                value={notes}
                mix={[
                  css({
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
                    transitionProperty:
                      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
                    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                    transitionDuration: '150ms',
                    outlineStyle: 'none',
                    '&::placeholder': { color: 'var(--muted-foreground)' },
                    '&:focus-visible': {
                      borderColor: 'var(--ring)',
                      boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
                    },
                    '@media (min-width: 48rem)': { fontSize: '.875rem', lineHeight: 1.4285714285714286 },
                  }),
                  on('input', (event) => {
                    notes = event.currentTarget.value
                    void handle.update()
                  }),
                ]}
              ></textarea>
            </div>
          </div>
        </div>
        <div mix={css({ display: 'flex', justifyContent: 'flex-end' })}>
          <button
            type="submit"
            disabled={pending}
            data-slot="button"
            mix={css({
              display: 'inline-flex',
              height: '2rem',
              flexShrink: 0,
              cursor: 'pointer',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.375rem',
              borderRadius: '9999px',
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
              '@media (hover: hover)': {
                '&:hover': { backgroundColor: 'color-mix(in oklab, var(--primary) 80%, transparent)' },
              },
              '&:focus-visible': {
                borderColor: 'var(--ring)',
                boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent)',
              },
              '&:disabled': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
            })}
          >
            {pending ? <SpinnerIcon /> : <HistoryIcon />}
            {pending ? 'Starting shift' : 'Start shift'}
          </button>
        </div>
      </form>
    )
  },
)

function shiftTitleError(value: string) {
  let length = value.trim().length
  if (length < 3) return 'Enter a shift title using at least 3 characters.'
  if (length > 120) return 'Keep the shift title under 120 characters.'
  return ''
}

function shiftDepartmentError(value: string) {
  let length = value.trim().length
  if (length < 2) return 'Enter a department using at least 2 characters.'
  if (length > 80) return 'Keep the department under 80 characters.'
  return ''
}

function HistoryIcon() {
  return () => (
    <svg
      data-icon="inline-start"
      aria-hidden="true"
      mix={css({ width: '1rem', height: '1rem' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l4 2" />
    </svg>
  )
}

function SpinnerIcon() {
  return () => (
    <svg
      role="status"
      aria-label="Loading"
      data-icon="inline-start"
      mix={css({ width: '1rem', height: '1rem', animation: 'spin 1s linear infinite' })}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
