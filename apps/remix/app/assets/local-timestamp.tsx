import { clientEntry, type Handle, type SerializableProps } from 'remix/component'

interface LocalTimestampProps extends SerializableProps {
  value?: string
  fallback?: string
}

export const LocalTimestamp = clientEntry(import.meta.url + '#LocalTimestamp', function LocalTimestamp(
  handle: Handle<LocalTimestampProps>,
) {
  // The server cannot know the browser's time zone. Hydrate the exact UTC text
  // that was rendered on the server, then replace it with the user's local
  // time after the client entry is connected.
  let useLocalTime = false
  handle.queueTask((signal) => {
    // Yield until the enclosing Frame has finished its complete hydration
    // pass. Updating synchronously from this component's commit can otherwise
    // race sibling client-entry hydration.
    let timer = setTimeout(() => {
      if (signal.aborted) return
      useLocalTime = true
      void handle.update()
    }, 0)
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  })

  return () => {
    let value = handle.props.value
    return value
      ? <time dateTime={value}>{formatTimestamp(value, handle.props.fallback, useLocalTime ? undefined : 'UTC')}</time>
      : <span>{handle.props.fallback ?? 'recently'}</span>
  }
})

function formatTimestamp(value: string, fallback = 'recently', timeZone?: string) {
  let date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
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
