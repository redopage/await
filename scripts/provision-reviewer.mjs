// Creates the plugin reviewer account. Usage: node scripts/provision-reviewer.mjs --local|--remote --email <reviewer@example.com> --output <credentials.json>
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
const valueAfter = (flag) => {
  const position = process.argv.indexOf(flag);
  return position < 0 ? null : process.argv[position + 1];
};
const email = valueAfter('--email')?.trim().toLowerCase();
const output = valueAfter('--output');
if (!mode || !email || !/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email) || !output) {
  throw new Error('Usage: node scripts/provision-reviewer.mjs --local|--remote --email reviewer@example.com --output /private/path/credentials.json');
}

const destination = resolve(output);
if (existsSync(destination)) throw new Error(`Credential output already exists: ${destination}`);
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const iterations = 100000;
const hash = pbkdf2Sync(password, Buffer.from(salt, 'hex'), iterations, 32, 'sha256').toString('hex');
const accountId = randomUUID();
const now = Date.now();
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = `INSERT INTO accounts (id, kind, name, email, created_at)
  VALUES (${quote(accountId)}, 'human', 'Await Reviewer', ${quote(email)}, ${now});
INSERT INTO reviewer_credentials (account_id, salt, password_hash, iterations, created_at, disabled_at)
  VALUES (${quote(accountId)}, ${quote(salt)}, ${quote(hash)}, ${iterations}, ${now}, NULL);
`;
const directory = mkdtempSync(join(tmpdir(), 'await-reviewer-'));
const sqlPath = join(directory, 'provision.sql');
let credentialsWritten = false;
try {
  const fd = openSync(destination, 'wx', 0o600);
  credentialsWritten = true;
  try { writeFileSync(fd, JSON.stringify({ email, password, login_url: 'https://await.chat/signin/reviewer' }, null, 2) + '\n'); }
  finally { closeSync(fd); }
  writeFileSync(sqlPath, sql, { mode: 0o600 });
  const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'await-chat', mode, '--file', sqlPath], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Could not provision reviewer account.');
  console.log(`Reviewer account provisioned. Credentials saved to ${destination} with owner-only access.`);
  credentialsWritten = false;
} finally {
  if (credentialsWritten) rmSync(destination, { force: true });
  rmSync(directory, { recursive: true, force: true });
}
