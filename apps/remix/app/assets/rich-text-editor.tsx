import { clientEntry, css, on, ref, type Handle, type SerializableProps } from 'remix/component'

import { enhanceFrameMutation } from './frame-mutation.ts'

interface EditorProps extends SerializableProps {
  name: string
  section?: 'situation' | 'background' | 'assessment' | 'recommendation'
  action?: string
  csrfToken?: string
  value?: string
  label: string
  required?: boolean
  disabled?: boolean
}

/** Enhances server-rendered summary text with a click-to-edit overlay. */
export const RichTextEditor = clientEntry(import.meta.url + '#RichTextEditor', function RichTextEditor(handle: Handle<EditorProps>) {
  let value = handle.props.value ?? ''
  let sourceValue = value
  let editing = false
  let editor: HTMLDivElement | undefined
  let hiddenInput: HTMLInputElement | undefined
  let pending = false
  let saveError = ''

  let updateValue = (nextValue: string) => {
    value = nextValue.replace(/\u00a0/g, ' ')
    if (hiddenInput) hiddenInput.value = value
  }

  let reset = () => {
    value = handle.props.value ?? ''
    if (hiddenInput) hiddenInput.value = value
    editing = false
    handle.update()
  }

  let submit = (container: HTMLElement) => {
    if (handle.props.disabled) return
    let nextValue = value.trim()
    if (!nextValue) {
      editor?.focus()
      return
    }

    updateValue(nextValue)
    editing = false
    if (nextValue !== sourceValue.trim()) container.closest('form')?.requestSubmit()
    handle.update()
  }

  return () => {
    let nextSourceValue = handle.props.value ?? ''
    if (!editing && nextSourceValue !== sourceValue) {
      sourceValue = nextSourceValue
      value = nextSourceValue
    }

    let formStyles: Parameters<typeof css>[0] = {
      position: 'absolute',
      inset: '0rem',
      borderRadius: 'calc(var(--radius) * 1.8)',
      ...(editing ? {
        zIndex: '20',
        height: 'max-content',
        minHeight: '100%',
        borderStyle: 'solid',
        borderWidth: '1px',
        borderColor: 'color-mix(in oklab, var(--color-slate-300) 90%, transparent)',
        backgroundColor: 'var(--color-slate-50)',
        padding: '1rem',
        boxShadow: '0 16px 36px rgba(44,56,75,0.14)'
      } : {
        zIndex: '10'
      })
    }
    return <form method="post" action={handle.props.action} data-testid={`inline-editor-${handle.props.section ?? handle.props.name}`} data-editing={editing || undefined} mix={[css(formStyles), enhanceFrameMutation(handle, {
      onPending(value) { pending = value; if (value) saveError = '' },
      onError(message) { saveError = message },
      onRefreshError() { saveError = 'The summary was saved, but the page could not be refreshed.' },
    })]}>
      {handle.props.csrfToken ? <input type="hidden" name="_csrf" value={handle.props.csrfToken} /> : null}
      {handle.props.section ? <input type="hidden" name="section" value={handle.props.section} /> : null}
      {editing ? <div mix={css({ ":where(& > :not(:last-child))": { marginBlockStart: "0px", marginBlockEnd: "0.75rem" } })}>
        <div mix={css({ fontSize: "0.75rem", lineHeight: "1.33333333", fontWeight: "600", letterSpacing: "0.24em", color: "var(--color-slate-500)", textTransform: "uppercase" })}>{handle.props.label}</div>
        <div
          role="textbox"
          aria-label={`${handle.props.label} summary editor`}
          aria-multiline="true"
          contentEditable={handle.props.disabled ? 'false' : 'true'}
          aria-disabled={handle.props.disabled || undefined}
          mix={[css({
            borderRadius: '18px',
            borderStyle: 'solid',
            borderWidth: '1px',
            borderColor: 'color-mix(in oklab, var(--color-slate-200) 80%, transparent)',
            backgroundColor: 'color-mix(in oklab, var(--color-white) 92%, transparent)',
            paddingInline: '1rem',
            paddingBlock: '0.75rem',
            fontSize: '0.875rem',
            lineHeight: '1.75rem',
            whiteSpace: 'pre-wrap',
            color: 'var(--color-slate-700)',
            transitionProperty: 'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
            transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
            transitionDuration: '150ms',
            outlineStyle: 'none',
            '&:focus': {
              borderColor: 'var(--color-slate-300)',
              backgroundColor: 'var(--color-white)',
              boxShadow: '0 0 0 2px color-mix(in oklab, var(--color-slate-900) 6%, transparent)'
            }
          }),
            ref((node) => { editor = node }),
            on('input', (event) => updateValue(readEditableText(event.currentTarget))),
            on('keydown', (event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              reset()
            }),
          ]}
        >{value}</div>
        <div mix={css({ display: "flex", justifyContent: "flex-end", gap: "0.5rem" })}>
          <button type="button" disabled={handle.props.disabled} mix={[css({
            display: 'inline-flex',
            minHeight: '2.75rem',
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
          }), on('click', reset)]}>Cancel</button>
          <button type="button" disabled={handle.props.disabled || !value.trim()} mix={[css({
            display: 'inline-flex',
            minHeight: '2.75rem',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'calc(infinity * 1px)',
            backgroundColor: 'var(--primary)',
            paddingInline: '0.75rem',
            fontSize: '0.875rem',
            lineHeight: '1.42857143',
            fontWeight: '500',
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
            }
          }), on('click', (event) => submit(event.currentTarget.closest('[data-editing]') as HTMLElement))]}>Save</button>
        </div>
      </div> : <button
        type="button"
        disabled={handle.props.disabled}
        aria-label={`Edit ${handle.props.label.toLowerCase()} summary`}
        mix={[css({
          width: '100%',
          height: '100%',
          cursor: 'text',
          borderRadius: 'calc(var(--radius) * 1.8)',
          backgroundColor: 'transparent',
          textAlign: 'left',
          outlineStyle: 'none',
          '&:focus-visible': {
            boxShadow: '0 0 0 3px color-mix(in oklab, var(--ring) 40%, transparent)'
          },
          '&:disabled': {
            cursor: 'not-allowed'
          }
        }), on('click', async () => {
          if (handle.props.disabled) return
          editing = true
          let signal = await handle.update()
          if (signal.aborted) return
          editor?.focus()
          if (editor) setEditableCaretOffset(editor, value.length)
        })]}
      ><span mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="">Edit {handle.props.label.toLowerCase()} summary</span></button>}
      <input type="hidden" name={handle.props.name} value={value} required={handle.props.required} mix={ref((node) => { hiddenInput = node })} />
      {pending ? <span mix={css({
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clipPath: 'inset(50%)',
        whiteSpace: 'nowrap',
        borderWidth: '0'
      })} data-visually-hidden="" role="status">Saving summary…</span> : null}
      {saveError ? <div role="alert" mix={css({
        marginTop: '0.75rem',
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
      })}>{saveError}</div> : null}
    </form>
  }
})

function setEditableCaretOffset(root: HTMLElement, offset: number) {
  let selection = root.ownerDocument.getSelection()
  let range = root.ownerDocument.createRange()
  let walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  while (walker.nextNode()) {
    let node = walker.currentNode
    let length = node.textContent?.length ?? 0
    if (remaining <= length) {
      range.setStart(node, remaining)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    remaining -= length
  }
  range.selectNodeContents(root)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function readEditableText(element: HTMLElement) {
  return typeof element.innerText === 'string' ? element.innerText : element.textContent ?? ''
}
