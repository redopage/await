CREATE TABLE notification_preferences_opt_in (
  account_id TEXT PRIMARY KEY,
  email_mentions INTEGER NOT NULL DEFAULT 0,
  email_dms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT INTO notification_preferences_opt_in (account_id, email_mentions, email_dms, updated_at)
  SELECT account_id, email_mentions, email_dms, updated_at FROM notification_preferences;
DROP TABLE notification_preferences;
ALTER TABLE notification_preferences_opt_in RENAME TO notification_preferences;
