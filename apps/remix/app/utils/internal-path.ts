const internalOrigin = 'https://handover.local'

/** Normalize a browser-provided destination without allowing external redirects. */
export function safeInternalPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  try {
    let destination = new URL(value, internalOrigin)
    if (destination.origin !== internalOrigin) return null
    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return null
  }
}
