// One spelling for SQLite lookups inside a Durable Object. Rows are read eagerly
// so callers never hold a cursor across an await.
export class Db {
  constructor(private sql: SqlStorage) {}
  one<T>(query: string, ...params: unknown[]): T | null { return ([...this.sql.exec(query, ...params)][0] as T | undefined) ?? null; }
  all<T>(query: string, ...params: unknown[]): T[] { return [...this.sql.exec(query, ...params)] as T[]; }
  run(query: string, ...params: unknown[]): void { this.sql.exec(query, ...params); }
  meta(key: string): string | null { return this.one<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null; }
  setMeta(key: string, value: string): void { this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); }
}
