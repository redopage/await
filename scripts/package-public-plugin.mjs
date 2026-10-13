import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repository, 'plugins/await-public');
const output = join(repository, 'dist/await-public-draft.zip');
const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'));
const openai = manifest.extensions?.['com.openai'];

function requireValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}.`);
}

requireValue(manifest.name, 'plugin name');
requireValue(manifest.version, 'plugin version');
requireValue(openai?.interface?.displayName, 'display name');
for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
  const value = openai?.interface?.[field];
  requireValue(value, field);
  if (new URL(value).origin !== 'https://await.chat') throw new Error(`${field} must use await.chat over HTTPS.`);
}
for (const field of ['logo', 'composerIcon']) {
  const path = openai?.interface?.[field];
  requireValue(path, field);
  if (!path.startsWith('./assets/') || !(await stat(join(source, path)).catch(() => null))?.isFile()) throw new Error(`Missing ${field} asset.`);
}
const skill = openai?.onboardingSkill;
requireValue(skill, 'onboarding skill');
if (!skill.startsWith('./skills/') || !(await stat(join(source, skill)).catch(() => null))?.isFile()) throw new Error('Missing onboarding skill file.');
const cases = openai?.review?.test_cases;
if (cases?.positive?.length !== 5 || cases?.negative?.length !== 3) throw new Error('Review requires five positive and three negative cases.');
for (const item of [...cases.positive, ...cases.negative]) {
  requireValue(item.description, 'review case description');
  requireValue(item.prompt, 'review case prompt');
  requireValue(item.expected_behavior, 'review case expected behavior');
}
JSON.parse(await readFile(join(source, 'mcp.json'), 'utf8'));

await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(join(tmpdir(), 'await-public-plugin-'));
try {
  for (const entry of ['plugin.json', 'mcp.json', 'assets', 'skills']) await cp(join(source, entry), join(staging, entry), { recursive: true });
  await rm(output, { force: true });
  execFileSync('zip', ['-X', '-q', '-r', output, 'plugin.json', 'mcp.json', 'assets', 'skills'], { cwd: staging });
  console.log(`Draft plugin ZIP: ${output}`);
  console.log('Submission still requires accurate public legal/support pages, verified publisher identity, and a reviewer-accessible demo recording.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
