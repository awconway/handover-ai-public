import 'dotenv/config'
import { createDataRuntime, migrateDatabase } from '../app/data/index.ts'

let runtime = createDataRuntime()
try {
  let result = await migrateDatabase(runtime.pool, { dryRun: process.argv.includes('--dry-run') })
  console.log(JSON.stringify({ applied: result.applied.map((entry) => entry.id), sql: result.sql }, null, 2))
} finally {
  await runtime.close()
}
