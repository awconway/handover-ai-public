/*
 * Select presentation adapted from @remix-run/ui 0.8.0.
 *
 * MIT License
 *
 * Copyright (c) 2025 Shopify Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { css, type Handle, type Props, type RemixNode } from 'remix/component'
import * as popover from '@remix-run/ui/popover'
import * as select from '@remix-run/ui/select'

type SelectProps = Omit<Props<'button'>, 'children' | 'name'> & {
  children?: RemixNode
  defaultLabel: string
  defaultValue?: string | null
  name?: string
}

type OptionProps = Props<'div'> & {
  disabled?: boolean
  label: string
  value: string
}

/** App-owned presentation for the headless Remix UI select. */
export function Select(handle: Handle<SelectProps>) {
  return () => {
    let { children, defaultLabel, defaultValue, disabled, name, mix, ...buttonProps } = handle.props
    return <select.Context defaultLabel={defaultLabel} defaultValue={defaultValue} disabled={disabled} name={name}>
      <button type="button" {...buttonProps} mix={[css({
        appearance: 'none',
        margin: 0,
        boxSizing: 'border-box',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
        width: '100%',
        minWidth: 0,
        height: '32px',
        gap: '6px',
        borderRadius: '8px',
        fontStyle: 'normal',
        fontWeight: 400,
        lineHeight: '20px',
        fontFeatureSettings: '"ss01" on, "cv01" on',
        letterSpacing: 0,
        textAlign: 'left',
        whiteSpace: 'nowrap',
        '&:disabled': { opacity: 0.55 },
      }), select.trigger(), mix]}>
        <SelectLabel />
      </button>
      <popover.Context>
        <div mix={[css({
          position: 'fixed',
          inset: 'auto',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: '12rem',
          maxWidth: 'min(24rem, calc(100vw - 32px))',
          maxHeight: '50dvh',
          border: '1px solid light-dark(#e7e7e7, #333333)',
          borderRadius: '12px',
          backgroundColor: 'light-dark(#ffffff, #1a1a1a)',
          color: 'light-dark(#151515, #ececec)',
          overflow: 'hidden',
          boxShadow: '0 1px 1px rgb(0 0 0 / 0.05), 0 6px 18px rgb(0 0 0 / 0.08)',
          opacity: 0,
          '&:popover-open': { opacity: 1 },
          '&:not(:popover-open)': {
            pointerEvents: 'none',
            transition: 'opacity 180ms ease-in, overlay 180ms ease-in, display 180ms ease-in',
            transitionBehavior: 'allow-discrete',
          },
          '&::backdrop': { background: 'transparent' },
        }), select.popover()]}>
          <div mix={[css({
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 auto',
            minHeight: 0,
            padding: '4px 0',
            overflow: 'auto',
            overscrollBehavior: 'contain',
            outline: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }), select.list()]}>{children}</div>
        </div>
      </popover.Context>
      {name ? <input mix={select.hiddenInput()} /> : null}
    </select.Context>
  }
}

function SelectLabel(handle: Handle) {
  let context = handle.context.get(select.Context)
  return () => <span mix={css({
    display: 'inline-flex',
    alignItems: 'center',
    flex: '1 1 auto',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  })}>{context.displayedLabel}</span>
}

export function Option(handle: Handle<OptionProps>) {
  return () => {
    let { label, value, disabled, children, mix, ...divProps } = handle.props
    return <div {...divProps} mix={[css({
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      minWidth: 0,
      minHeight: '32px',
      boxSizing: 'border-box',
      position: 'relative',
      isolation: 'isolate',
      paddingInline: '12px',
      color: 'light-dark(#151515, #ececec)',
      fontFamily: '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '13px',
      fontWeight: 400,
      lineHeight: '1.45',
      textAlign: 'left',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      scrollMarginBlock: '4px',
      '&::before': {
        content: '""',
        position: 'absolute',
        insetBlock: 0,
        insetInline: '4px',
        borderRadius: '8px',
        backgroundColor: 'transparent',
        pointerEvents: 'none',
        zIndex: -1,
      },
      '&:focus': { outline: 'none' },
      '&[data-highlighted="true"]': { color: 'light-dark(rgb(255 255 255 / 0.92), #151515)' },
      '&[data-highlighted="true"]::before': { backgroundColor: 'light-dark(#1A72FF, #6eaaff)' },
      '&[aria-disabled="true"]': { opacity: 0.5 },
      '&[hidden]': { display: 'none' },
      '&[data-select-flash="true"]': { color: 'light-dark(#151515, #ececec)' },
      '&[data-select-flash="true"]::before': { backgroundColor: 'transparent' },
      '& > svg': { opacity: 0 },
      '&[aria-selected="true"] > svg': { opacity: 1 },
    }), select.option({ label, value, disabled }), mix]}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" mix={css({
        display: 'block',
        flex: '0 0 14px',
        width: '14px',
        height: '14px',
        marginInlineEnd: '4px',
      })}><path d="m20 6-11 11-5-5" /></svg>
      <span mix={css({ display: 'inline-flex', alignItems: 'center', flex: '1 1 auto', minWidth: 0 })}>{children ?? label}</span>
    </div>
  }
}
