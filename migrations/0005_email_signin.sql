CREATE TABLE IF NOT EXISTS email_signin_codes (
  challenge_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  invite_token TEXT,
  return_to TEXT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS email_signin_codes_email_created ON email_signin_codes(email, created_at);
CREATE INDEX IF NOT EXISTS email_signin_codes_ip_created ON email_signin_codes(ip_hash, created_at);
