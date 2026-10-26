import { css, clientEntry, ref, type Handle, type RemixNode } from 'remix/component'

import { attachFrameMutation } from './frame-mutation.ts'
import { wakeProcessingCoordinator } from './processing-events.ts'

interface FrameMutationFormProps {
  action: string
  children?: RemixNode
  styles?: Parameters<typeof css>[0]
  id?: string
  workflow?: string
  testId?: string
  studyTask?: string
  ariaLabel?: string
  confidence?: string
  preserveScroll?: boolean
  wakeProcessing?: boolean
}

/** Keeps styled form content owned by the server while enhancing submission. */
export function FrameMutationForm(handle: Handle<FrameMutationFormProps>) {
  return () => (
    <form
      id={handle.props.id}
      method="post"
      action={handle.props.action}
      aria-label={handle.props.ariaLabel}
      data-workflow={handle.props.workflow}
      data-testid={handle.props.testId}
      data-study-task={handle.props.studyTask}
      data-confidence={handle.props.confidence}
      mix={css(handle.props.styles ?? {})}
    >
      {handle.props.children}
      <FrameMutationEnhancer
        preserveScroll={handle.props.preserveScroll}
        wakeProcessing={handle.props.wakeProcessing}
      />
    </form>
  )
}

/**
 * Enhances an ancestor server-rendered form without making its full subtree a
 * client-entry child. This is useful for large forms containing server Handle
 * components, which should remain owned by the Frame reconciler.
 */
export const FrameMutationEnhancer = clientEntry(
  import.meta.url + '#FrameMutationEnhancer',
  function FrameMutationEnhancer(handle: Handle<{ preserveScroll?: boolean; wakeProcessing?: boolean }>) {
    let pending = false
    let error = ''
    let attachedForm: HTMLFormElement | null = null

    return () => (
      <span
        mix={[
          css({ display: 'contents' }),
          ref((node) => {
            let form = node.closest('form')
            if (!form || form === attachedForm) return
            attachedForm = form
            attachFrameMutation(handle, form, {
              resetScroll: handle.props.preserveScroll === true ? false : undefined,
              onPending(value) {
                pending = value
                if (value) {
                  error = ''
                  form.setAttribute('aria-busy', 'true')
                } else {
                  form.removeAttribute('aria-busy')
                }
              },
              onError(message) {
                error = message
              },
              onSuccess() {
                if (handle.props.wakeProcessing) wakeProcessingCoordinator()
              },
              onRefreshError() {
                error = 'The change was saved, but the page could not be refreshed.'
              },
            })
          }),
        ]}
      >
        {pending ? (
          <span
            mix={css({
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              borderWidth: 0,
            })}
            role="status"
          >
            Saving change…
          </span>
        ) : null}
        {error ? (
          <span
            role="alert"
            mix={css({
              borderRadius: '14px',
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
              color: 'var(--color-rose-900)',
            })}
          >
            {error}
          </span>
        ) : null}
      </span>
    )
  },
)
