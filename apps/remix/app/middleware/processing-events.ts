import { createContextKey, type Middleware } from 'remix/router'

import type { HandoverProcessingChanges } from '../data/index.ts'

export const HandoverProcessingChangesKey = createContextKey<HandoverProcessingChanges>()

export function handoverProcessingChanges(source: HandoverProcessingChanges): Middleware<
  readonly [{ key: typeof HandoverProcessingChangesKey; value: HandoverProcessingChanges }]
> {
  return (context, next) => {
    context.set(HandoverProcessingChangesKey, source)
    return next()
  }
}
