import { sql, type Database } from 'remix/data-table'

export type UsabilityReportOptions = { since: Date; limit?: number }

type RankedCount = { name: string; count: number }
type DurationSummary = { name: string; count: number; averageMs: number; medianMs: number; p95Ms: number }

export type UsabilityAnalyticsReport = {
  generatedAt: string
  window: { startedAt: string | null; endedAt: string | null }
  totals: {
    sessions: number; knownUsers: number; events: number; routes: number; apiRequests: number;
    apiErrors: number; validationErrors: number; clientErrors: number; workflowStarts: number;
    workflowCompletions: number; workflowAbandons: number; frictionSignals: number
  }
  deviceMix: RankedCount[]
  eventCounts: RankedCount[]
  routeTimings: DurationSummary[]
  frequentClickTargets: RankedCount[]
  frictionSignals: RankedCount[]
}

function number(value: unknown): number { return Number.isFinite(Number(value)) ? Number(value) : 0 }
function iso(value: unknown): string | null { return value == null ? null : new Date(value as string | Date).toISOString() }

export async function buildUsabilityAnalyticsReport(db: Database, options: UsabilityReportOptions): Promise<UsabilityAnalyticsReport> {
  let limit = Math.min(250_000, Math.max(1, options.limit ?? 20_000))
  let totalsResult = await db.exec(sql`
    with selected as (
      select * from usability_events where occurred_at >= ${options.since} order by occurred_at desc limit ${limit}
    ) select
      count(*)::int events, count(distinct usability_session_id)::int sessions,
      count(distinct user_id) filter (where user_id is not null)::int known_users,
      count(distinct route) filter (where route <> '')::int routes,
      min(occurred_at) started_at, max(occurred_at) ended_at,
      count(*) filter (where event_type in ('api_request','api_error'))::int api_requests,
      count(*) filter (where event_type = 'api_error')::int api_errors,
      count(*) filter (where event_type = 'validation_error')::int validation_errors,
      count(*) filter (where event_type = 'client_error')::int client_errors,
      count(*) filter (where event_type = 'workflow_start')::int workflow_starts,
      count(*) filter (where event_type = 'workflow_complete')::int workflow_completions,
      count(*) filter (where event_type = 'workflow_abandon')::int workflow_abandons,
      count(*) filter (where event_type in ('validation_error','client_error','rage_click','dead_click','search_no_results','workflow_abandon','workflow_error','help_request'))::int friction_signals
    from selected
  `)
  let row = totalsResult.rows?.[0] ?? {}

  async function ranked(expression: string, where = 'true', max = 16): Promise<RankedCount[]> {
    // Expressions are fixed internal constants; all user values stay parameterized.
    let result = await db.exec(`
      select ${expression} name, count(*)::int count from (
        select * from usability_events where occurred_at >= $1 order by occurred_at desc limit $2
      ) selected where ${where} group by 1 order by 2 desc, 1 asc limit ${max}
    `, [options.since, limit])
    return (result.rows ?? []).map((item) => ({ name: String(item.name ?? 'unknown'), count: number(item.count) }))
  }

  let routeResult = await db.exec(sql`
    select route name, count(*)::int count, round(avg(duration_ms))::int average_ms,
      percentile_cont(0.5) within group (order by duration_ms)::int median_ms,
      percentile_cont(0.95) within group (order by duration_ms)::int p95_ms
    from (select * from usability_events where occurred_at >= ${options.since} order by occurred_at desc limit ${limit}) selected
    where event_type = 'route_duration' and duration_ms is not null and route <> ''
    group by route order by p95_ms desc limit 12
  `)

  let [eventCounts, frequentClickTargets, frictionSignals, deviceMix] = await Promise.all([
    ranked('event_type'),
    ranked("coalesce(target->>'analyticsId', target->>'testId', target->>'name', target->>'role', target->>'tagName', 'unknown')", "event_type = 'click'", 10),
    ranked('event_type', "event_type in ('validation_error','client_error','rage_click','dead_click','search_no_results','workflow_abandon','workflow_error','help_request')", 10),
    (async () => {
      let result = await db.exec(sql`
        select coalesce(device->>'deviceType','unknown') name, count(*)::int count
        from usability_sessions where started_at >= ${options.since} group by 1 order by 2 desc limit 8
      `)
      return (result.rows ?? []).map((item) => ({ name: String(item.name), count: number(item.count) }))
    })(),
  ])

  return {
    generatedAt: new Date().toISOString(), window: { startedAt: iso(row.started_at), endedAt: iso(row.ended_at) },
    totals: {
      sessions: number(row.sessions), knownUsers: number(row.known_users), events: number(row.events), routes: number(row.routes),
      apiRequests: number(row.api_requests), apiErrors: number(row.api_errors), validationErrors: number(row.validation_errors),
      clientErrors: number(row.client_errors), workflowStarts: number(row.workflow_starts), workflowCompletions: number(row.workflow_completions),
      workflowAbandons: number(row.workflow_abandons), frictionSignals: number(row.friction_signals),
    },
    deviceMix, eventCounts, frequentClickTargets, frictionSignals,
    routeTimings: (routeResult.rows ?? []).map((item) => ({
      name: String(item.name), count: number(item.count), averageMs: number(item.average_ms), medianMs: number(item.median_ms), p95Ms: number(item.p95_ms),
    })),
  }
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  if (!rows.length) return '_No rows._'
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

export function formatUsabilityAnalyticsReport(report: UsabilityAnalyticsReport): string {
  return [
    '# Usability Analytics Report', '', `Generated: ${report.generatedAt}`, `Window: ${report.window.startedAt ?? 'n/a'} to ${report.window.endedAt ?? 'n/a'}`, '',
    '## Summary', '', table(['Sessions','Users','Events','Routes','Workflow starts','Completed','Abandoned','API errors','Validation errors','Client errors','Friction'], [[
      report.totals.sessions, report.totals.knownUsers, report.totals.events, report.totals.routes,
      report.totals.workflowStarts, report.totals.workflowCompletions, report.totals.workflowAbandons,
      report.totals.apiErrors, report.totals.validationErrors, report.totals.clientErrors, report.totals.frictionSignals,
    ]]), '',
    '## Event mix', '', table(['Event','Count'], report.eventCounts.map((item) => [item.name, item.count])), '',
    '## Route timing', '', table(['Route','Count','Average ms','Median ms','p95 ms'], report.routeTimings.map((item) => [item.name,item.count,item.averageMs,item.medianMs,item.p95Ms])), '',
    '## Friction signals', '', table(['Signal','Count'], report.frictionSignals.map((item) => [item.name,item.count])), '',
    '## Frequent click targets', '', table(['Target','Count'], report.frequentClickTargets.map((item) => [item.name,item.count])), '',
    '## Device mix', '', table(['Device','Count'], report.deviceMix.map((item) => [item.name,item.count])), '',
  ].join('\n')
}
