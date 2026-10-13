#!/usr/bin/env node
// Installs the local Await agent host as a macOS LaunchAgent so it runs now and
// at login. On other systems it prints an equivalent systemd user unit.
//
// Usage: node scripts/install-agent-host.mjs [env-file] [label] [--runner claude|codex] [--state-dir <path>]
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAwaitClient } from './lib/await-client.mjs';
import { defaultLaunchLabel, defaultStateDir, parseArgs, parseEnvFile, selectRunner, serviceEnvironment, slugify } from './lib/await-host-config.mjs';
import { isOnPath, resolveExecutable } from './lib/model-cli.mjs';

const installUsage = `Usage: node scripts/install-agent-host.mjs [env-file] [label] [--runner claude|codex] [--state-dir <path>]

  env-file   Private file with AWAIT_AGENT_TOKEN (and optional AWAIT_ORIGIN, AWAIT_RUNNER). Default .env.await-bot
  label      Service label. Default com.await.<agent-name>, read from the token's agent
  --runner   Model CLI the host should use. Default: AWAIT_RUNNER in the env file, else codex when installed, else claude

The runner CLI is found on this shell's PATH (or at AWAIT_CLAUDE_EXECUTABLE / AWAIT_CODEX_EXECUTABLE
in the env file) and its absolute path is written into the service, which does not inherit this PATH.

macOS: writes ~/Library/LaunchAgents/<label>.plist and starts it. Other systems: prints a systemd user unit.`;

const options = parseArgs(process.argv.slice(2), { flags: ['runner', 'state-dir'] });
if (options.help) { console.log(installUsage); process.exit(0); }
const envPath = resolve(options._[0] ?? '.env.await-bot');
const info = await stat(envPath);
if (info.mode & 0o077) throw new Error('The bot env file must be private: chmod 600 your-env-file.');
const envVars = parseEnvFile(await readFile(envPath, 'utf8'));
if (!envVars.AWAIT_AGENT_TOKEN) throw new Error(`${envPath} must set AWAIT_AGENT_TOKEN.`);
const runner = selectRunner({ runner: options.runner ?? envVars.AWAIT_RUNNER, available: isOnPath });
// Resolve the CLI now, with this shell's PATH (nvm, volta, fnm...), so the service can start it.
const executableKey = `AWAIT_${runner.toUpperCase()}_EXECUTABLE`;
const requested = envVars[executableKey] ?? runner;
const executable = resolveExecutable(requested);
if (!executable) throw new Error(`The ${runner} CLI (${requested}) was not found on this shell's PATH. Install it, or set ${executableKey} in ${envPath} to its absolute path, then run the installer again.`);

// Derive the label and state directory from the connected agent, not a fixed bot name.
let label = options._[1], agent = null;
try {
  const context = await createAwaitClient({ origin: envVars.AWAIT_ORIGIN || undefined, token: envVars.AWAIT_AGENT_TOKEN }).context();
  if (context.kind !== 'agent') throw new Error('the token belongs to a person, not a named agent');
  agent = context.agent;
} catch (error) {
  if (!label) throw new Error(`Could not identify the agent for ${envPath} (${error.message}). Pass a service label as the second argument.`);
  console.error(`Warning: could not identify the agent (${error.message}). Using label ${label}.`);
}
label ??= defaultLaunchLabel(agent);
if (!/^[a-zA-Z0-9.-]+$/.test(label)) throw new Error('Use a simple service label: letters, digits, dots and dashes.');
const stateDir = resolve(options['state-dir'] ?? envVars.AWAIT_HOST_STATE ?? (agent ? defaultStateDir(agent, homedir()) : join(homedir(), '.await', 'hosts', slugify(label.replace(/^com\.await\./, '')) || 'agent')));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostScript = join(root, 'scripts', 'await-agent-host.mjs');
const args = [process.execPath, `--env-file=${envPath}`, hostScript, '--runner', runner];
// Service variables win over the env file, because node --env-file never overrides them.
const environment = serviceEnvironment({ runner, executable, stateDir, home: homedir() });

if (process.platform !== 'darwin') {
  const unitName = `${label}.service`;
  const unitValue = (value) => (/[\s"\\]/.test(value) ? JSON.stringify(value) : value);
  console.log(`This installer only writes macOS LaunchAgents. On Linux, save this systemd user unit to ~/.config/systemd/user/${unitName}:

[Unit]
Description=Await agent host for ${agent?.name ?? label}
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${args.map(unitValue).join(' ')}
WorkingDirectory=${root}
${Object.entries(environment).map(([key, value]) => `Environment=${unitValue(`${key}=${value}`)}`).join('\n')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target

Then run:
  mkdir -p ${stateDir} && chmod 700 ${stateDir}
  systemctl --user daemon-reload && systemctl --user enable --now ${unitName}
  loginctl enable-linger $USER     # keep it running while logged out
  journalctl --user -u ${unitName} -f`);
  process.exit(0);
}

await mkdir(stateDir, { recursive: true, mode: 0o700 });
const directory = join(homedir(), 'Library', 'LaunchAgents');
await mkdir(directory, { recursive: true });
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plistPath = join(directory, `${label}.plist`);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escape(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${escape(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${escape(key)}</key><string>${escape(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${escape(join(stateDir, 'host.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(stateDir, 'host.log'))}</string>
</dict></plist>`;
await writeFile(plistPath, plist, { mode: 0o600 });
const domain = `gui/${process.getuid()}`;
spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
const result = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(`LaunchAgent setup failed: ${result.stderr.trim()}`);
console.log(`Installed ${label} for ${agent?.name ?? label} with the ${runner} runner (${executable}). Log: ${join(stateDir, 'host.log')}\nStop it with: launchctl bootout ${domain}/${label}`);
