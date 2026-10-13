import { DurableObject } from 'cloudflare:workers';
import { canonicalJson } from '../src/shared/json';
import { json as respond, sameSecret } from '../src/shared/http';

interface Env { COMPUTERS: DurableObjectNamespace<Computer>; ARTIFACTS: Artifacts; EXECUTION_SECRET: string }
type RepoInput = { repository: string; commit: string };
type Job = { id: string; command_id: string; kind: 'execute' | 'prepare' | 'check' | 'publish' | 'delete_branch' | 'restore_branch'; repository: string; branch: string; base: string; command?: string; candidates?: RepoInput[]; target?: string; commit?: string };
type Result = { status: 'complete' | 'failed' | 'interrupted'; exit_code: number; stdout: string; stderr: string; commit?: string; started_at: number; finished_at: number; image: string };
const hash = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9-]{1,160}$/.test(value);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!sameSecret(request.headers.get('Authorization'), env.EXECUTION_SECRET && `Bearer ${env.EXECUTION_SECRET}`)) return respond({ error: 'Unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
    const input = await request.json<Job>();
    if (!identifier(input.id)) return respond({ error: 'Invalid computer ID' }, 400);
    const computer = env.COMPUTERS.get(env.COMPUTERS.idFromName(input.id));
    if (path === '/stop') return computer.fetch(new Request('https://computer/stop', { method: 'POST' }));
    if (path === '/status') return computer.fetch(new Request('https://computer/status', { method: 'POST', body: JSON.stringify(input) }));
    if (path !== '/job' || !identifier(input.command_id) || !identifier(input.repository) || !hash(input.base) || !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,120}$/.test(input.branch) || input.branch.includes('..')) return respond({ error: 'Invalid job' }, 400);
    if (!['execute', 'prepare', 'check', 'publish', 'delete_branch', 'restore_branch'].includes(input.kind)) return respond({ error: 'Invalid job kind' }, 400);
    if (['delete_branch','restore_branch'].includes(input.kind) && !/^codex\/[a-f0-9-]{36}$/.test(input.branch)) return respond({ error: 'Protected branch' }, 400);
    if (input.command && (typeof input.command !== 'string' || input.command.length > 12000)) return respond({ error: 'Command too long' }, 400);
    if (input.candidates && (input.candidates.length > 8 || input.candidates.some(c => !identifier(c.repository) || !hash(c.commit)))) return respond({ error: 'Invalid candidates' }, 400);
    if (input.target && !identifier(input.target) || input.commit && !hash(input.commit)) return respond({ error: 'Invalid target' }, 400);
    return computer.fetch(new Request('https://computer/job', { method: 'POST', body: JSON.stringify(input) }));
  },
};

// One trust scope per instance. Checks and publication never reuse an agent computer.
export class Computer extends DurableObject<Env> {
  private busy = false;
  private stopped = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT, started_at INTEGER NOT NULL)');
    const interrupted = [...ctx.storage.sql.exec('SELECT id FROM jobs WHERE result IS NULL')].length;
    if (interrupted && ctx.container?.running) ctx.blockConcurrencyWhile(async () => { await ctx.container!.destroy('Interrupted operation'); });
    ctx.storage.sql.exec("UPDATE jobs SET result=? WHERE result IS NULL", JSON.stringify({status:'interrupted', exit_code:-1, error:'Execution interrupted. Inspect the last Git checkpoint before retrying with a new command ID.'}));
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(300_000));
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/stop') { this.stopped = true; await this.ctx.storage.put('stopped', true); await this.ctx.container?.destroy(); return respond({ stopped: true }); }
    const input = await request.json<Job>();
    const rows = [...this.ctx.storage.sql.exec<{ payload: string; result: string | null; started_at: number }>('SELECT * FROM jobs WHERE id=?', input.command_id)];
    const existing = rows[0];
    if (path === '/status') return respond(existing?.result ? JSON.parse(existing.result) : { status: existing ? 'running' : 'missing' });
    if (existing) {
      if (existing.payload !== canonicalJson(input)) return respond({ error: 'Command ID reused with different input.' }, 409);
      if (existing.result) return respond(JSON.parse(existing.result));
      if (this.busy) return respond({ status: 'running' }, 202);
      // Lost execution acknowledgement never repeats arbitrary commands.
      return respond({ status: 'interrupted', error: 'The command receipt was interrupted. Inspect Git state before starting a new command.' }, 409);
    }
    if (this.busy) return respond({ error: 'A command is already running.' }, 409);
    this.busy = true;
    if (await this.ctx.storage.get('stopped')) { this.busy = false; return respond({ error: 'This computer was stopped.' }, 409); }
    const binding = canonicalJson({kind:input.kind,repository:input.repository});
    const previousBinding = await this.ctx.storage.get<string>('binding');
    if (previousBinding && previousBinding !== binding) { this.busy = false; return respond({error:'Computer trust scope mismatch.'},409); }
    await this.ctx.storage.put('binding',binding);
    const started = Date.now();
    this.ctx.storage.sql.exec('INSERT INTO jobs VALUES(?,?,NULL,?)', input.command_id, canonicalJson(input), started);
    // Persist the reservation before returning; execution survives the calling HTTP request.
    this.ctx.waitUntil(this.perform(input, started));
    return respond({ status: 'running' }, 202);
  }
  private async perform(input: Job, started: number): Promise<void> {
    let result: Result;
    const timer = setTimeout(() => { void this.ctx.container?.destroy('Job deadline'); }, 240_000);
    try {
      const container = this.ctx.container!;
      if (!container.running) {
        container.start({ image: 'cloudflare/debian-trixie', instance: 'standard-1', enableInternet: true, entrypoint: ['sleep', 'infinity'] });
        await container.setInactivityTimeout(300_000);
        await this.must(['sh', '-c', 'command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git ca-certificates)']);
        await this.clone(input.repository, input.base, input.kind === 'execute' ? input.branch : undefined);
      }
      if (this.stopped) throw new Error('Computer stopped.');
      let commit: string | undefined, output = { exit_code: 0, stdout: '', stderr: '' };
      if (input.kind === 'execute') {
        output = await this.exec(['bash', '-c', input.command || 'git status --short'], '/work');
        // Persist the working tree as ordinary Git so a fresh computer can recover it.
        // This is author output, never independently trusted test evidence.
        if (output.exit_code === 0) {
          await this.git(['add', '-A']);
          await this.git(['-c', 'user.name=Await agent', '-c', 'user.email=agent@await.invalid', 'commit', '--allow-empty', '-m', 'Hosted attempt checkpoint']);
          commit = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
          await this.withToken(input.repository, 'write', async (remote, env) => this.git(['push', remote, `HEAD:refs/heads/${input.branch}`], env));
        }
      } else if (input.kind === 'prepare') {
        for (const candidate of input.candidates ?? []) {
          await this.withToken(candidate.repository, 'read', (remote, env) => this.git(['fetch', '--no-tags', remote, candidate.commit], env));
          await this.git(['-c', 'user.name=Await integration', '-c', 'user.email=integration@await.invalid', 'merge', '--no-ff', '--no-edit', candidate.commit]);
        }
        commit = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
        await this.withToken(input.target!, 'write', (remote, env) => this.git(['push', remote, `HEAD:refs/heads/${input.branch}`], env));
      } else if (input.kind === 'check') {
        commit = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
        if (commit !== input.base) throw new Error('Check input mismatch.');
        output = await this.exec(['bash', '-c', input.command || 'exit 1'], '/work');
      } else if (input.kind === 'delete_branch' || input.kind === 'restore_branch') {
        // Preserve an immutable recovery ref before removing the working branch.
        // This computer has never run repository code.
        const branch = `refs/heads/${input.branch}`, archive = `refs/heads/await/archive/${input.branch}/${input.base}`;
        await this.withToken(input.repository, 'write', async (remote, env) => {
          const refs = (await this.git(['ls-remote',remote,branch,archive],env)).stdout;
          const entries = refs.trim().split('\n').filter(Boolean).map(line => line.split(/\s+/));
          const head = entries.find(([,ref])=>ref===branch)?.[0], saved = entries.find(([,ref])=>ref===archive)?.[0];
          if (input.kind === 'delete_branch') {
            if (!head && saved === input.base) return; // Receipt recovery after a lost acknowledgement.
            if (head !== input.base) throw new Error('Branch changed; deletion refused.');
            if (saved && saved !== input.base) throw new Error('Recovery ref mismatch.');
            if (!saved) await this.git(['push',`--force-with-lease=${archive}:`,remote,`${input.base}:${archive}`],env);
            await this.git(['push',`--force-with-lease=${branch}:${input.base}`,remote,`:${branch}`],env);
          } else {
            if (saved !== input.base) throw new Error('Recovery commit is unavailable.');
            if (head === input.base) return;
            if (head) throw new Error('Branch exists; restoration refused.');
            await this.git(['push',`--force-with-lease=${branch}:`,remote,`${input.base}:${branch}`],env);
          }
        });
        output = await this.withToken(input.repository,'read',(remote,env)=>this.git(['ls-remote',remote,branch,archive],env));
        commit = input.base;
      } else {
        // This instance has never run repository commands or dependency installation.
        commit = input.commit!;
        await this.withToken(input.repository, 'read', (remote, env) => this.git(['fetch', '--no-tags', remote, commit!], env));
        await this.git(['merge-base', '--is-ancestor', input.base, commit]);
        await this.withToken(input.target!, 'write', (remote, env) => this.git(['push', `--force-with-lease=refs/heads/${input.branch}:${input.base}`, remote, `${commit}:refs/heads/${input.branch}`], env));
      }
      result = { status: output.exit_code === 0 ? 'complete' : 'failed', ...output, commit, started_at: started, finished_at: Date.now(), image: 'cloudflare/debian-trixie' };
    } catch (error) {
      result = { status: 'failed', exit_code: -1, stdout: '', stderr: error instanceof Error ? error.message : 'Execution failed', started_at: started, finished_at: Date.now(), image: 'cloudflare/debian-trixie' };
    } finally {
      clearTimeout(timer);
      if (input.kind !== 'execute') await this.ctx.container?.destroy().catch(() => {});
      this.busy = false;
    }
    this.ctx.storage.sql.exec('UPDATE jobs SET result=? WHERE id=?', JSON.stringify(result), input.command_id);
  }
  private async exec(cmd: string[], cwd?: string, env?: Record<string, string>) {
    const process = await this.ctx.container!.exec(cmd, { cwd, env: { HOME: '/tmp/await-home', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...env } });
    // Drain both streams, retaining bounded diagnostic output only.
    const read = async (stream: ReadableStream | null) => {
      if (!stream) return ''; const reader = stream.getReader(), decoder = new TextDecoder(); let output = '', size = 0;
      for (;;) { const value = await reader.read(); if (value.done) break; if (size < 32000) output += decoder.decode(value.value.slice(0, 32000 - size), { stream: true }); size += value.value.length; }
      return output + (size > 32000 ? '\n[output truncated]' : '');
    };
    const [stdout, stderr, exit_code] = await Promise.all([read(process.stdout), read(process.stderr), process.exitCode]);
    return { stdout, stderr, exit_code };
  }
  private async must(cmd: string[], cwd?: string, env?: Record<string, string>) {
    const result = await this.exec(cmd, cwd, env);
    if (result.exit_code !== 0) throw new Error(`Command failed (${result.exit_code}): ${result.stderr || result.stdout}`);
    return result;
  }
  private git(args: string[], env?: Record<string, string>) { return this.must(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], '/work', env); }
  private async clone(repository: string, commit: string, branch?: string) {
    await this.withToken(repository, 'read', (remote, env) => this.must(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--no-checkout', remote, '/work'], undefined, env));
    const ref = branch ? `refs/remotes/origin/${branch}` : commit;
    const found = await this.exec(['git','rev-parse','--verify',ref],'/work');
    await this.git(['checkout', '--detach', found.exit_code === 0 ? ref : commit]);
  }
  private async withToken<T>(name: string, scope: 'read' | 'write', work: (remote: string, env: Record<string, string>) => Promise<T>): Promise<T> {
    const repo = await this.env.ARTIFACTS.get(name);
    let token: { id: string; plaintext: string } | undefined;
    try {
      token = await repo.createToken(scope, 300);
      const info = await repo.info();
      return await work(info.remote, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Git operation failed';
      throw new Error(token ? message.replaceAll(token.plaintext, '[redacted]') : message);
    } finally { if (token) await repo.revokeToken(token.id).catch(() => false); repo[Symbol.dispose](); }
  }
}
