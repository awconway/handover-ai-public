import { createContextKey, type Middleware } from 'remix/router'
import { Database } from 'remix/data-table'

import type { createDataRuntime } from '../data/index.ts'

export type DataRuntime = ReturnType<typeof createDataRuntime>

/** The request-scoped data-table runtime and its domain query surface. */
export const DataRuntimeKey = createContextKey<DataRuntime>()

export function dataRuntime(runtime: DataRuntime): Middleware<
  readonly [
    { key: typeof DataRuntimeKey; value: DataRuntime },
    { key: typeof Database; value: Database },
  ]
> {
  return (context, next) => {
    context.set(DataRuntimeKey, runtime)
    context.set(Database, runtime.db)
    return next()
  }
}
