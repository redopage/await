// Shared helpers for running a model CLI (Codex or Claude Code) as a locked-down child
// process. Used by the local agent host, its installer and the project agent broker.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

// Await credentials stay in the parent process, never in a model subprocess environment.
export function childEnvironment(env = process.env) {
  const copy = { ...env };
  for (const key of Object.keys(copy)) if (key.startsWith('AWAIT_')) delete copy[key];
  return copy;
}

// `codex exec` with no user config, session files, shell, agents, apps, plugins, browser,
// computer use, skill search or web search. Callers append their output and MCP options.
export function codexArgs(extra = []) {
  return ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '-c', 'features.shell_tool=false', '-c', 'features.multi_agent=false', '-c', 'features.apps=false',
    '-c', 'features.plugins=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
    '-c', 'features.skill_search=false', '-c', 'web_search="disabled"', ...extra];
}

const isExecutableFile = (path) => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
};

// The absolute path a command runs from: a path containing a directory separator is
// checked as given, a bare name is looked up on PATH. Null when nothing executable matches.
export function resolveExecutable(name, env = process.env) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) return isExecutableFile(name) ? resolve(name) : null;
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (isExecutableFile(candidate)) return resolve(candidate);
    }
  }
  return null;
}

export const isOnPath = (name, env = process.env) => resolveExecutable(name, env) !== null;

// Runs a CLI with `input` on stdin and resolves { code, signal, timedOut } when it exits.
// Output reaches onStdout and onStderr as UTF-8 text. After timeoutMs the process gets
// SIGTERM, then SIGKILL five seconds later if it is still running. A CLI that cannot start
// rejects with the system error (error.code is ENOENT for a missing executable).
export function runCli(executable, args, { cwd, env = childEnvironment(), input = '', timeoutMs, onStdout, onStderr } = {}) {
  if (!(timeoutMs > 0)) throw new TypeError('runCli needs a positive timeoutMs.');
  return new Promise((accept, reject) => {
    let child;
    try { child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (text) => onStdout?.(text));
    child.stderr.setEncoding('utf8').on('data', (text) => onStderr?.(text));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); accept({ code, signal, timedOut }); });
    child.stdin.on('error', () => { /* The close handler reports the failure. */ });
    child.stdin.end(input);
  });
}
