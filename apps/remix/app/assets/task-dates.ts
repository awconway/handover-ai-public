export const DEFAULT_TASK_DUE_LABEL = 'No due date set'

const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function parseTaskDueAt(value: string | null | undefined) {
  if (!value || !isoDateTimePattern.test(value)) return null
  let date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function parseTaskDueLocalValue(value: string | null | undefined) {
  let match = value?.match(localDateTimePattern)
  if (!match) return null
  let [, yearValue, monthValue, dayValue, hoursValue, minutesValue] = match
  let year = Number(yearValue)
  let month = Number(monthValue)
  let day = Number(dayValue)
  let hours = Number(hoursValue)
  let minutes = Number(minutesValue)
  let date = new Date(year, month - 1, day, hours, minutes, 0, 0)

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) return null

  return date
}

export function taskDueLocalValue(value: string | Date | null | undefined) {
  let date = typeof value === 'string' ? parseTaskDueAt(value) : value
  if (!date || Number.isNaN(date.getTime())) return ''
  return [
    `${date.getFullYear()}`.padStart(4, '0'),
    '-',
    `${date.getMonth() + 1}`.padStart(2, '0'),
    '-',
    `${date.getDate()}`.padStart(2, '0'),
    'T',
    `${date.getHours()}`.padStart(2, '0'),
    ':',
    `${date.getMinutes()}`.padStart(2, '0'),
  ].join('')
}

export function taskDueIsoValue(localValue: string) {
  return parseTaskDueLocalValue(localValue)?.toISOString() ?? ''
}

export function formatTaskDueDateTime(value: string | Date, timeZone?: string) {
  let date = typeof value === 'string' ? parseTaskDueAt(value) : value
  if (!date || Number.isNaN(date.getTime())) return DEFAULT_TASK_DUE_LABEL
  let parts = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
    timeZone,
  }).formatToParts(date)
  let part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? ''
  let month = monthLabels[Number(part('month')) - 1] ?? ''
  return `${part('day')} ${month} ${part('year')}, ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`
}

export function getTaskDueDisplay(dueAt: string | null | undefined, timeZone?: string) {
  return dueAt ? formatTaskDueDateTime(dueAt, timeZone) : DEFAULT_TASK_DUE_LABEL
}
