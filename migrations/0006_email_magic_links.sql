CREATE TABLE IF NOT EXISTS email_signin_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invite_token TEXT,
  return_to TEXT,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS email_signin_links_email_created ON email_signin_links(email, created_at);
CREATE INDEX IF NOT EXISTS email_signin_links_ip_created ON email_signin_links(ip_hash, created_at);
