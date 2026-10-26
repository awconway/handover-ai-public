import { css, clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/component'

interface ShiftSheetUploadProps extends SerializableProps {
  action: string
  csrfToken?: string
}

export const ShiftSheetUpload = clientEntry(
  import.meta.url + '#ShiftSheetUpload',
  function ShiftSheetUpload(handle: Handle<ShiftSheetUploadProps>) {
    let photoInput: HTMLInputElement | undefined
    let fileInput: HTMLInputElement | undefined
    let submitting = false

    function markSubmitting() {
      submitting = true
      handle.update()
    }

    return () => (
      <div
        mix={css({
          marginTop: '0.75rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: '0.5rem',
        })}
      >
        <form
          method="post"
          encType="multipart/form-data"
          action={handle.props.action}
          aria-busy={submitting}
          mix={on('submit', markSubmitting)}
        >
          {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
          <input
            name="sheet"
            type="file"
            accept="image/*,.heic,.heif,image/heic,image/heif"
            capture="environment"
            aria-label="Take handover sheet photo"
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
              ref((input) => {
                photoInput = input
              }),
              on('change', (event) => {
                if (event.currentTarget.files?.[0]) event.currentTarget.form?.requestSubmit()
              }),
            ]}
          />
          <button
            type="button"
            disabled={submitting}
            mix={[
              css({
                display: 'inline-flex',
                height: '2rem',
                width: '100%',
                flexShrink: 0,
                cursor: 'pointer',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.375rem',
                borderRadius: '9999px',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: 'var(--border)',
                backgroundColor: 'var(--background)',
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
                '&:disabled': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
              }),
              on('click', () => photoInput?.click()),
            ]}
          >
            {submitting ? <SpinnerIcon /> : <UploadIcon />}
            {submitting ? 'Importing' : 'Take photo'}
          </button>
        </form>
        <form
          method="post"
          encType="multipart/form-data"
          action={handle.props.action}
          aria-busy={submitting}
          mix={on('submit', markSubmitting)}
        >
          {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
          <input
            name="sheet"
            type="file"
            accept="image/*,.heic,.heif,image/heic,image/heif,.pdf,.csv,.tsv,.txt"
            aria-label="Choose handover sheet file"
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
              ref((input) => {
                fileInput = input
              }),
              on('change', (event) => {
                if (event.currentTarget.files?.[0]) event.currentTarget.form?.requestSubmit()
              }),
            ]}
          />
          <button
            type="button"
            disabled={submitting}
            mix={[
              css({
                display: 'inline-flex',
                height: '2rem',
                width: '100%',
                flexShrink: 0,
                cursor: 'pointer',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.375rem',
                borderRadius: '9999px',
                borderWidth: '1px',
                borderStyle: 'solid',
                borderColor: 'var(--border)',
                backgroundColor: 'var(--background)',
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
                '&:disabled': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
              }),
              on('click', () => fileInput?.click()),
            ]}
          >
            <FileTextIcon />
            Choose file
          </button>
        </form>
      </div>
    )
  },
)

function UploadIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </svg>
  )
}

function FileTextIcon() {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h8" />
    </svg>
  )
}

function SpinnerIcon() {
  return () => (
    <svg
      role="status"
      aria-label="Loading"
      data-icon="inline-start"
      viewBox="0 0 24 24"
      mix={css({ width: '1rem', height: '1rem', animation: 'spin 1s linear infinite' })}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.6" />
    </svg>
  )
}
