// Shared, side-effect-free helpers for the local Await agent host and its
// installer: runner selection, argument and env-file parsing, and names derived
// from the connected agent instead of a hardcoded bot.
import { dirname, join } from 'node:path';

export const runnerNames = ['codex', 'claude'];

export function slugify(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function agentSlug(agent) {
  return slugify(agent?.name) || slugify(agent?.id) || 'agent';
}

export function defaultStateDir(agent, home) {
  return join(home, '.await', 'hosts', agentSlug(agent));
}

export function defaultLaunchLabel(agent) {
  return `com.await.${agentSlug(agent)}`;
}

// Environment for the launchd or systemd service, which does not inherit the installing
// shell's PATH. The runner CLI is pinned by absolute path, and Node's own directory leads
// PATH so a CLI that starts with `#!/usr/bin/env node` still finds it.
export function serviceEnvironment({ runner, executable, stateDir, home, execPath = process.execPath }) {
  const path = [dirname(execPath), dirname(executable), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return { PATH: [...new Set(path)].join(':'), AWAIT_HOST_STATE: stateDir, [`AWAIT_${runner.toUpperCase()}_EXECUTABLE`]: executable };
}

// --runner / AWAIT_RUNNER, else codex when it is installed, else claude.
export function selectRunner({ runner, available = () => false } = {}) {
  const chosen = String(runner ?? '').trim().toLowerCase();
  if (chosen && !runnerNames.includes(chosen)) throw new Error(`Unknown runner "${chosen}". Choose --runner claude or --runner codex.`);
  return chosen || (available('codex') ? 'codex' : 'claude');
}

export function parseArgs(argv, { flags = ['runner', 'state-dir', 'origin', 'model'], booleans = ['help'] } = {}) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { options._.push(...argv.slice(index + 1)); break; }
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }
    const match = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/.exec(arg);
    if (!match) {
      if (arg.startsWith('-') && arg.length > 1) throw new Error(`Unknown option ${arg}.`);
      options._.push(arg); continue;
    }
    const [, name, inline] = match;
    if (booleans.includes(name)) { options[name] = true; continue; }
    if (!flags.includes(name)) throw new Error(`Unknown option --${name}.`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`Option --${name} needs a value.`);
    options[name] = value;
  }
  return options;
}

// KEY=value lines as node --env-file reads them: comments, blank lines and
// simple single or double quotes are handled.
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function usage() {
  return `Await agent host: connects one named Await agent to a local model CLI.

Usage: node --env-file=.env.await-bot scripts/await-agent-host.mjs [options]

Environment (keep the env file private, chmod 600):
  AWAIT_AGENT_TOKEN        Agent token from Await (required)
  AWAIT_ORIGIN             Await origin (default https://await.chat)
  AWAIT_RUNNER             claude or codex (default: codex when it is on PATH, else claude)
  AWAIT_HOST_STATE         Private state directory (default ~/.await/hosts/<agent-name>)
  AWAIT_MODEL              Optional model name passed to the runner CLI
  AWAIT_CLAUDE_EXECUTABLE  Claude Code CLI to run (default claude)
  AWAIT_CODEX_EXECUTABLE   Codex CLI to run (default codex)

Options:
  --runner claude|codex    Model CLI that answers events (overrides AWAIT_RUNNER)
  --state-dir <path>       Private state directory (overrides AWAIT_HOST_STATE)
  --origin <url>           Await origin (overrides AWAIT_ORIGIN)
  --model <name>           Optional model name for the runner CLI
  -h, --help               Show this help

Run one host per agent. The runner CLI must already be signed in; its response
process gets no shell, file, web or Await credentials. The host opens a live
WebSocket for push signals and drains the durable inbox at startup, on each
signal and every 30 seconds while the socket is down. It replies to mentions and
acknowledges events.`;
}
