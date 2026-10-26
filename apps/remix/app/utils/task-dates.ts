export const DEFAULT_TASK_DUE_LABEL = 'No due date set'

const isoDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export type TaskDueInput = {
  dueAt?: string
  dueLocal?: string
  dueLabel?: string
}

export type ResolvedTaskDue =
  | { success: true; dueAt: Date | null; dueLabel: string }
  | { success: false }

/**
 * Resolves the browser's canonical ISO value first and falls back to the
 * native datetime-local value so the server form remains usable without JS.
 */
export function resolveTaskDueInput(input: TaskDueInput): ResolvedTaskDue {
  let dueAtValue = input.dueAt?.trim() ?? ''
  let dueLocalValue = input.dueLocal?.trim() ?? ''
  let dueLabel = input.dueLabel?.trim() ?? ''

  if (dueAtValue) {
    let dueAt = parseTaskDueAt(dueAtValue)
    if (!dueAt) return { success: false }
    return {
      success: true,
      dueAt,
      dueLabel: dueLabel && dueLabel !== DEFAULT_TASK_DUE_LABEL
        ? dueLabel
        : formatTaskDueDateTime(dueAt),
    }
  }

  if (dueLocalValue) {
    let dueAt = parseTaskDueLocalValue(dueLocalValue)
    if (!dueAt) return { success: false }
    return {
      success: true,
      dueAt,
      dueLabel: dueLabel && dueLabel !== DEFAULT_TASK_DUE_LABEL
        ? dueLabel
        : formatTaskDueDateTime(dueAt),
    }
  }

  return {
    success: true,
    dueAt: null,
    dueLabel: dueLabel || DEFAULT_TASK_DUE_LABEL,
  }
}

function parseTaskDueAt(value: string) {
  if (!isoDateTimePattern.test(value)) return null
  let date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function parseTaskDueLocalValue(value: string) {
  let match = value.match(localDateTimePattern)
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

function formatTaskDueDateTime(date: Date) {
  let parts = new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).formatToParts(date)
  let part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? ''
  let month = monthLabels[Number(part('month')) - 1] ?? ''
  return `${part('day')} ${month} ${part('year')}, ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`
}
