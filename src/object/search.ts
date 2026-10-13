// Keep the searchable text and its index in the workspace database. Source
// triggers make edits and deletions atomic with their index updates.
export function migrateSearch(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE search_records (
      rowid INTEGER PRIMARY KEY, kind TEXT NOT NULL, item_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, board_id TEXT, author_id TEXT, state TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(kind, item_id))`);
    sql.exec('CREATE INDEX search_records_channel ON search_records(channel_id, kind, updated_at)');
    sql.exec(`CREATE VIRTUAL TABLE search_fts USING fts5(title, body,
      content='search_records', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2', prefix='2 3')`);
    sql.exec(`CREATE TRIGGER search_records_insert AFTER INSERT ON search_records BEGIN
      INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END`);
    sql.exec(`CREATE TRIGGER search_records_delete AFTER DELETE ON search_records BEGIN
      INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END`);
    sql.exec(`CREATE TRIGGER search_records_update AFTER UPDATE ON search_records BEGIN
      INSERT INTO search_fts(search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END`);

    const sources = [
      { table: 'messages', kind: 'message', select: `SELECT 'message', id, channel_id, NULL, author_id, NULL, created_at, COALESCE(edited_at, created_at), '', body FROM messages WHERE deleted_at IS NULL` },
      { table: 'channels', kind: 'channel', select: `SELECT 'channel', id, id, NULL, created_by, NULL, created_at, created_at, name, description FROM channels WHERE is_dm = 0` },
      { table: 'boards', kind: 'board', select: `SELECT 'board', id, channel_id, id, created_by, NULL, created_at, created_at, name, '' FROM boards` },
      { table: 'tasks', kind: 'task', select: `SELECT 'task', t.id, b.channel_id, t.board_id, t.created_by, t.status, t.created_at, t.updated_at, t.title, t.description FROM tasks t JOIN boards b ON b.id = t.board_id` },
      { table: 'documents', kind: 'document', select: `SELECT 'document', id, channel_id, NULL, created_by, NULL, created_at, updated_at, title, body FROM documents` },
    ];
    const columns = 'kind, item_id, channel_id, board_id, author_id, state, created_at, updated_at, title, body';
    for (const source of sources) {
      // A WHERE clause also disambiguates SQLite's SELECT ... ON CONFLICT grammar.
      const upsert = `${source.select}${source.select.includes(' WHERE ') ? ' AND' : ' WHERE'} ${source.table === 'tasks' ? 't.' : ''}id = new.id
        ON CONFLICT(kind, item_id) DO UPDATE SET channel_id=excluded.channel_id,
          board_id=excluded.board_id, author_id=excluded.author_id, state=excluded.state,
          updated_at=excluded.updated_at, title=excluded.title, body=excluded.body`;
      sql.exec(`CREATE TRIGGER search_${source.table}_insert AFTER INSERT ON ${source.table} BEGIN
        INSERT INTO search_records (${columns}) ${upsert}; END`);
      sql.exec(`CREATE TRIGGER search_${source.table}_update AFTER UPDATE ON ${source.table} BEGIN
        ${source.table === 'messages' ? "DELETE FROM search_records WHERE kind='message' AND item_id=new.id AND new.deleted_at IS NOT NULL;" : ''}
        INSERT INTO search_records (${columns}) ${upsert}; END`);
      sql.exec(`CREATE TRIGGER search_${source.table}_delete AFTER DELETE ON ${source.table} BEGIN
        DELETE FROM search_records WHERE kind='${source.kind}' AND item_id=old.id;
        ${source.table === 'boards' ? "DELETE FROM search_records WHERE kind='task' AND board_id=old.id;" : ''}
        ${source.table === 'channels' ? 'DELETE FROM search_records WHERE channel_id=old.id;' : ''}
        END`);
      sql.exec(`INSERT INTO search_records (${columns}) ${source.select}`);
    }
    sql.exec("INSERT INTO search_fts(search_fts, rank) VALUES ('rank', 'bm25(5.0, 1.0)')");
    sql.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '6') ON CONFLICT(key) DO UPDATE SET value='6'");
  });
}

export const searchKinds = ['message', 'channel', 'board', 'task', 'document'] as const;
type SearchKind = typeof searchKinds[number];
export type SearchOptions = {
  query: string; channelId?: string; kinds?: SearchKind[]; taskState?: 'active' | 'done' | 'all';
  after?: number; before?: number; limit?: number; offset?: number;
};

export function parseSearchQuery(query: string): { text: string; state?: SearchOptions['taskState'] } {
  let state: SearchOptions['taskState'];
  const text = query.replace(/(?:^|\s)is:(active|done|all)(?=\s|$)/gi, (_match, value: string) => {
    state = value.toLowerCase() as SearchOptions['taskState']; return ' ';
  }).trim();
  return { text, state };
}

// Tokens are always quoted. User text cannot become SQL or FTS operators.
// A trailing * is the only supported operator, for prefix discovery.
export function searchExpression(text: string): string {
  if (text.length > 200) throw new Error('Search for at most 200 characters.');
  const tokens = text.match(/[\p{L}\p{N}_]+\*?/gu) ?? [];
  if (!tokens.length || tokens.every((token) => token.replace(/\*$/, '').length < 2)) throw new Error('Search for at least two letters or numbers.');
  if (tokens.length > 8) throw new Error('Use at most eight search terms, or narrow the channel or dates.');
  return tokens.map((token) => `"${token.replace(/\*$/, '')}"${token.endsWith('*') ? '*' : ''}`).join(' AND ');
}

type SearchRow = { kind: SearchKind; id: string; title: string; excerpt: string; channel_id: string;
  channel_name: string; board_id: string | null; status: string | null; created_at: number; updated_at: number;
  author_id: string; author_name: string; author_kind: string; thread_id: string | null; reply_count: number };

export function searchWorkspace(sql: SqlStorage, accountId: string, options: SearchOptions) {
  const parsed = parseSearchQuery(options.query);
  const expression = searchExpression(parsed.text);
  const kinds = options.kinds ?? [...searchKinds];
  if (!kinds.length || kinds.length > searchKinds.length || new Set(kinds).size !== kinds.length
    || kinds.some((kind) => !searchKinds.includes(kind))) throw new Error('Choose distinct valid search kinds.');
  const state = options.taskState ?? parsed.state ?? 'active';
  if (!['active', 'done', 'all'].includes(state)) throw new Error('Choose active, done, or all tasks.');
  const limit = options.limit ?? 10;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Choose a result limit from 1 to 50.');
  if (!Number.isInteger(offset) || offset < 0 || offset > 500) throw new Error('Narrow the search before paging beyond 500 results.');
  for (const date of [options.after, options.before]) if (date !== undefined && (!Number.isSafeInteger(date) || date < 0)) throw new Error('Dates must be Unix milliseconds.');
  if (options.after !== undefined && options.before !== undefined && options.after >= options.before) throw new Error('after must be earlier than before.');
  // In placeholder order: the membership join, the MATCH, then the filters.
  const params: (string | number)[] = [accountId, expression, ...kinds];
  const filters = ["c.archived_at IS NULL", `r.kind IN (${kinds.map(() => '?').join(',')})`];
  if (options.channelId) { filters.push('r.channel_id = ?'); params.push(options.channelId); }
  if (state !== 'all') { filters.push(`(r.kind <> 'task' OR r.state ${state === 'done' ? '=' : '<>'} 'done')`); }
  if (options.after !== undefined) { filters.push('r.updated_at >= ?'); params.push(options.after); }
  if (options.before !== undefined) { filters.push('r.updated_at < ?'); params.push(options.before); }
  params.push(limit + 1, offset);
  const rows = [...sql.exec<SearchRow>(`SELECT r.kind, r.item_id AS id, r.title,
      snippet(search_fts, -1, '', '', '…', 32) AS excerpt,
      r.channel_id, c.name AS channel_name, r.board_id, r.state AS status,
      r.created_at, r.updated_at, r.author_id,
      COALESCE(a.name, f.name, 'Former member') AS author_name,
      COALESCE(a.kind, f.kind, 'unknown') AS author_kind,
      m.thread_id, CASE WHEN r.kind = 'message' THEN
        (SELECT COUNT(*) FROM messages replies WHERE replies.thread_id = COALESCE(m.thread_id, m.id) AND replies.deleted_at IS NULL) ELSE 0 END AS reply_count
    FROM search_fts JOIN search_records r ON r.rowid = search_fts.rowid
    JOIN channel_members cm ON cm.channel_id = r.channel_id AND cm.account_id = ?
    JOIN channels c ON c.id = r.channel_id
    LEFT JOIN messages m ON r.kind = 'message' AND m.id = r.item_id
    LEFT JOIN members a ON a.account_id = r.author_id
    LEFT JOIN former_members f ON f.account_id = r.author_id
    WHERE search_fts MATCH ? AND ${filters.join(' AND ')}
    ORDER BY search_fts.rank, r.updated_at DESC, r.kind, r.item_id LIMIT ? OFFSET ?`,
    // Membership is checked before ranking results are returned or limited.
    ...params)];
  const more = rows.length > limit;
  return { items: rows.slice(0, limit).map(({ author_name, author_kind, ...row }) => ({ ...row,
    excerpt: row.excerpt.length > 320 ? `${row.excerpt.slice(0, 319)}…` : row.excerpt,
    author: { account_id: row.author_id, name: author_name, kind: author_kind } })),
    has_more: more, next_offset: more && offset + limit <= 500 ? offset + limit : null,
    task_state: state, query: parsed.text };
}
