import 'dotenv/config'
import { buildUsabilityAnalyticsReport, createDataRuntime, formatUsabilityAnalyticsReport } from './index.ts'

function read(name: string): string | undefined {
  let index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

let since = new Date(read('--since') ?? Date.now() - 7 * 24 * 60 * 60 * 1000)
if (!Number.isFinite(since.getTime())) throw new Error('Invalid --since value')
let limit = Number(read('--limit') ?? 20_000)
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250_000) throw new Error('--limit must be between 1 and 250000')

let runtime = createDataRuntime()
try {
  let report = await buildUsabilityAnalyticsReport(runtime.db, { since, limit })
  console.log(read('--format') === 'json' ? JSON.stringify(report, null, 2) : formatUsabilityAnalyticsReport(report))
} finally {
  await runtime.close()
}
