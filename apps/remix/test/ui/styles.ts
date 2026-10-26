import * as assert from 'remix/assert'

// Isolated component tests do not mount Document. Supply a minimal foundation;
// full-document/e2e checks exercise the real document.css asset and theme.
const foundation = document.createElement('style')
foundation.textContent = `
  @layer base, rmx;
  @layer base {
    :root {
      --radius: .625rem;
      --radius-sm: .375rem;
      --radius-md: .5rem;
      --radius-lg: .625rem;
      --radius-xl: .875rem;
      --radius-2xl: 1.125rem;
      --radius-3xl: 1.375rem;
      --radius-4xl: 1.625rem;
      --primary: oklch(.53 .07 253);
      --primary-foreground: oklch(.985 .003 255);
      --background: oklch(.977 .004 255);
      --foreground: oklch(.29 .014 255);
      --muted: oklch(.955 .006 252);
      --border: oklch(.905 .008 252);
      --ring: oklch(.64 .05 252);
      --color-white: #fff;
      --color-slate-700: oklch(.372 .044 257.287);
      --color-slate-950: oklch(.129 .042 264.695);
      --color-rose-900: oklch(.41 .159 10.272);
    }
    *, ::before, ::after { box-sizing: border-box; border: 0 solid; margin: 0; padding: 0; }
    html { font-size: 16px; line-height: 1.5; }
    button, input, select, textarea { font: inherit; }
  }
`
document.head.append(foundation)

export function computedStyle(element: Element | null | undefined): CSSStyleDeclaration {
  assert.ok(element, 'Expected the styled element to exist')
  return getComputedStyle(element)
}

export function resolvedColor(value: string): string {
  let probe = document.createElement('span')
  probe.style.color = value
  document.body.append(probe)
  let color = getComputedStyle(probe).color
  probe.remove()
  return color
}
