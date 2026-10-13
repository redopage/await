export function migrateAgentAccess(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE agent_channel_access (
      account_id TEXT PRIMARY KEY, granted_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec('ALTER TABLE channel_members ADD COLUMN access_grant INTEGER NOT NULL DEFAULT 0');
    sql.exec(`CREATE TRIGGER agent_access_new_channel AFTER INSERT ON channels
      WHEN new.is_dm = 0 AND new.archived_at IS NULL BEGIN
      INSERT OR IGNORE INTO channel_members(channel_id, account_id, access_grant)
        SELECT new.id, a.account_id, 1 FROM agent_channel_access a JOIN members m ON m.account_id=a.account_id WHERE m.kind='agent'; END`);
    sql.exec(`CREATE TRIGGER agent_access_removed_member AFTER DELETE ON members BEGIN
      DELETE FROM agent_channel_access WHERE account_id=old.account_id; END`);
    sql.exec("INSERT INTO meta(key,value) VALUES ('schema_version','7') ON CONFLICT(key) DO UPDATE SET value='7'");
  });
}
