import { createSession, createSessionId, type Session, type SessionStorage } from 'remix/session'
import { sql, type Database } from 'remix/data-table'

type StoredSessionData = [Record<string, unknown>, Record<string, unknown>]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseStoredData(value: unknown): StoredSessionData {
  if (!Array.isArray(value) || value.length !== 2 || !isRecord(value[0]) || !isRecord(value[1])) {
    return [{}, {}]
  }
  return [value[0], value[1]]
}

/** Native Remix SessionStorage backed by the shared data-table Database. */
export function createPostgresSessionStorage(
  db: Database,
  options: { ttlMs?: number; now?: () => Date } = {},
): SessionStorage {
  let ttlMs = options.ttlMs ?? 1000 * 60 * 60 * 24 * 30
  let now = options.now ?? (() => new Date())

  return {
    async read(cookie) {
      if (!cookie) return createSession()
      let result = await db.exec(sql`
        delete from sessions
        where id = ${cookie} and expires_at <= now()
        returning id
      `)
      if ((result.rows?.length ?? 0) > 0) return createSession()

      let found = await db.exec(sql`
        update sessions set last_seen_at = now(), updated_at = now()
        where id = ${cookie} and expires_at > now()
        returning id, payload
      `)
      let row = found.rows?.[0]
      return row ? createSession(String(row.id), parseStoredData(row.payload)) : createSession()
    },

    async save(session: Session) {
      if (session.destroyed) {
        if (session.id) await db.exec(sql`delete from sessions where id = ${session.id}`)
        if (session.deleteId) await db.exec(sql`delete from sessions where id = ${session.deleteId}`)
        return null
      }
      if (!session.dirty && session.id) return null

      let id = session.id || createSessionId()
      let expiresAt = new Date(now().getTime() + ttlMs)
      let auth = session.get('auth')
      let userId = typeof session.get('userId') === 'string'
        ? session.get('userId') as string
        : isRecord(auth) && typeof auth.userId === 'string' ? auth.userId : null

      await db.exec(sql`
        insert into sessions (id, user_id, payload, expires_at, created_at, updated_at, last_seen_at)
        values (${id}, ${userId}, ${JSON.stringify(session.data)}::jsonb, ${expiresAt}, now(), now(), now())
        on conflict (id) do update set
          user_id = excluded.user_id,
          payload = excluded.payload,
          expires_at = excluded.expires_at,
          updated_at = now(),
          last_seen_at = now()
      `)
      if (session.deleteId && session.deleteId !== id) {
        await db.exec(sql`delete from sessions where id = ${session.deleteId}`)
      }
      return id
    },
  }
}
