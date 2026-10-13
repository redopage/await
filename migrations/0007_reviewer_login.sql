CREATE TABLE IF NOT EXISTS reviewer_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviewer_login_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviewer_login_attempts_expires ON reviewer_login_attempts(expires_at);
