CREATE TABLE IF NOT EXISTS notification_preferences (
  account_id TEXT PRIMARY KEY,
  email_mentions INTEGER NOT NULL DEFAULT 1,
  email_dms INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
