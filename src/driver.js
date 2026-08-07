import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * One client, two destinations.
 *
 * Turso is libSQL, which is a fork of SQLite, so the same client and the same
 * SQL work against a local file and against a hosted database. Development and
 * production therefore run identical code; only the URL changes.
 *
 *   no TURSO_DATABASE_URL  -> file:<cwd>/data/timesheet.db
 *   TURSO_DATABASE_URL set -> libsql://your-db.turso.io  (+ TURSO_AUTH_TOKEN)
 */
export function openDriver({ file, url, authToken }) {
  let client;
  let describe;

  if (url) {
    client = createClient({ url, authToken });
    // Never log the token, and strip any query string that might carry one.
    describe = url.replace(/\?.*$/, '');
  } else {
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true });
    client = createClient({ url: `file:${path}` });
    describe = path;
  }

  return {
    describe,
    remote: Boolean(url),

    async execute(sql, params = []) {
      const r = await client.execute({ sql, args: params });
      // Rows arrive as array-like objects; spread them into plain ones.
      return { rows: r.rows.map((row) => ({ ...row })), rowsAffected: Number(r.rowsAffected ?? 0) };
    },

    /** Semicolon-separated script, for schema creation. */
    async script(sql) {
      await client.executeMultiple(sql);
    },

    /** All or nothing. A half-applied set of writes is worse than none. */
    async batch(statements) {
      if (statements.length === 0) return;
      await client.batch(
        statements.map(([sql, params = []]) => ({ sql, args: params })),
        'write',
      );
    },

    async close() {
      client.close();
    },
  };
}
