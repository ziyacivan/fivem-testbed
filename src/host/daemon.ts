// The daemon runs in the interactive session of the test host (SPEC-0001 D3, section 9.1).
// It owns FXServer and serves JSON-RPC to relays on a named pipe.
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { rcon } from '../fivem/rcon.ts';
import { pipeName } from '../protocol/config.ts';
import { isMethodName, type MethodName, methods, type Params, type Result } from '../protocol/messages.ts';
import { APP_ERROR, auth, encode, LineSplitter, PROTOCOL_ERROR, request } from '../protocol/rpc.ts';
import { VERSION } from '../protocol/version.ts';
import { ConsoleBuffer } from './console-buffer.ts';
import { type HostPaths, hostPaths, readSecrets, requireSecret } from './paths.ts';
import { killImage, killTree, processesWithPrefix, run } from './windows.ts';

interface State {
  connect: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Daemon {
  private readonly server = new ConsoleBuffer();
  private readonly client = new ConsoleBuffer();
  private fxserver: ChildProcess | undefined;
  private startedAt: number | undefined;
  private readonly uploads = new Map<string, string>();

  private readonly paths: HostPaths;

  constructor(paths: HostPaths) {
    this.paths = paths;
  }

  private get state(): State {
    try {
      return JSON.parse(fs.readFileSync(this.paths.state, 'utf8')) as State;
    } catch {
      return { connect: '127.0.0.1:30120' };
    }
  }

  private get rconPort(): number {
    return Number(this.state.connect.split(':')[1]);
  }

  private rcon(command: string, timeoutMs = 5000): Promise<string> {
    return rcon(
      { host: '127.0.0.1', port: this.rconPort, password: requireSecret(this.paths.secrets, 'RCON_PASSWORD'), timeoutMs },
      command,
    );
  }

  private async rconAlive(): Promise<boolean> {
    if (!this.fxserver) return false;
    try {
      await this.rcon('version', 2000);
      return true;
    } catch {
      return false;
    }
  }

  private async serverStatus(): Promise<Result<'server.status'>> {
    const running = this.fxserver !== undefined;
    return {
      running,
      rcon: await this.rconAlive(),
      ...(this.fxserver?.pid ? { pid: this.fxserver.pid } : {}),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    };
  }

  configure({ serverCfg, connect }: Params<'server.configure'>): Result<'server.configure'> {
    const port = connect.split(':')[1];
    const header = [
      '# Written by fivem-testbed. Edit the server.cfg of the project, not this file.',
      `endpoint_add_tcp "127.0.0.1:${port}"`,
      `endpoint_add_udp "127.0.0.1:${port}"`,
      'exec secrets.cfg',
      '',
    ].join('\n');
    fs.mkdirSync(this.paths.serverData, { recursive: true });
    fs.writeFileSync(this.paths.serverCfg, `${header}${serverCfg.replace(/\r\n/g, '\n')}\n`);
    fs.writeFileSync(this.paths.state, JSON.stringify({ connect } satisfies State));
    return {};
  }

  private writeSecretsCfg(): void {
    const lines = [
      '# Written by fivem-testbed from secrets.env before each start.',
      `set sv_licenseKey "${requireSecret(this.paths.secrets, 'LICENSE_KEY')}"`,
      `set rcon_password "${requireSecret(this.paths.secrets, 'RCON_PASSWORD')}"`,
    ];
    fs.writeFileSync(this.paths.secretsCfg, `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  async start(): Promise<Result<'server.start'>> {
    if (this.fxserver) return this.serverStatus();
    if (processesWithPrefix('FXServer').length > 0) {
      throw new Error('another FXServer process runs on the test host; stop it first');
    }
    const exe = path.join(this.paths.server, 'FXServer.exe');
    if (!fs.existsSync(exe)) throw new Error(`${exe} does not exist; run \`fivem-testbed host setup\``);
    if (!fs.existsSync(this.paths.serverCfg)) throw new Error('no server.cfg; run `fivem-testbed deploy` first');
    this.writeSecretsCfg();
    fs.mkdirSync(this.paths.logs, { recursive: true });
    if (fs.existsSync(this.paths.serverLog)) {
      fs.renameSync(this.paths.serverLog, path.join(this.paths.logs, 'server.prev.log'));
    }
    const log = fs.createWriteStream(this.paths.serverLog);
    const child = spawn(exe, ['+exec', 'server.cfg'], {
      cwd: this.paths.serverData,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.fxserver = child;
    this.startedAt = Date.now();
    this.server.push(`[fivem-testbed] FXServer started (pid ${child.pid})`);
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        log.write(chunk);
        this.server.write(chunk);
      });
    }
    child.on('exit', (code) => {
      this.server.flush();
      this.server.push(`[fivem-testbed] FXServer exited (code ${code})`);
      log.end();
      if (this.fxserver === child) {
        this.fxserver = undefined;
        this.startedAt = undefined;
      }
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (!this.fxserver) {
        const tail = this.server.read({ limit: 15 }).map((line) => line.text).join('\n');
        throw new Error(`FXServer exited during start:\n${tail}`);
      }
      if (await this.rconAlive()) return this.serverStatus();
      await sleep(1000);
    }
    throw new Error('FXServer gave no RCON answer in 120 s; read the server console');
  }

  async stop(): Promise<Result<'server.stop'>> {
    const child = this.fxserver;
    if (!child) return this.serverStatus();
    await this.rcon('quit "fivem-testbed stop"', 2000).catch(() => undefined);
    for (let i = 0; i < 20 && this.fxserver === child; i++) await sleep(500);
    if (this.fxserver === child && child.pid) killTree(child.pid);
    for (let i = 0; i < 20 && this.fxserver === child; i++) await sleep(250);
    return this.serverStatus();
  }

  private clientStatus(): Result<'client.status'> {
    const processes = processesWithPrefix('FiveM');
    return { running: processes.length > 0, processes };
  }

  // FiveM refuses a start from a service or a task. The shell opens the link (SPEC-0001 D6).
  async launch(): Promise<Result<'client.launch'>> {
    if (this.clientStatus().running) return this.clientStatus();
    const child = spawn('explorer.exe', [`fivem://connect/${this.state.connect}`], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    for (let i = 0; i < 40 && !this.clientStatus().running; i++) await sleep(250);
    return this.clientStatus();
  }

  async quit(): Promise<Result<'client.quit'>> {
    killImage('FiveM.exe');
    for (let i = 0; i < 20 && this.clientStatus().running; i++) await sleep(250);
    return this.clientStatus();
  }

  upload({ uploadId, chunk }: Params<'resource.upload'>): Result<'resource.upload'> {
    fs.mkdirSync(this.paths.tmp, { recursive: true });
    const file = this.uploads.get(uploadId) ?? path.join(this.paths.tmp, `${uploadId}.tar`);
    if (!this.uploads.has(uploadId)) {
      fs.rmSync(file, { force: true });
      this.uploads.set(uploadId, file);
    }
    fs.appendFileSync(file, Buffer.from(chunk, 'base64'));
    return { bytes: fs.statSync(file).size };
  }

  // Unpacks into a staging folder, then swaps it in, so no stale file stays.
  commit({ uploadId, category, name }: Params<'resource.commit'>): Result<'resource.commit'> {
    const file = this.uploads.get(uploadId);
    if (!file) throw new Error(`unknown upload ${uploadId}`);
    this.uploads.delete(uploadId);
    const target = path.join(this.paths.resources, category, name);
    const staging = `${target}.staging`;
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      const result = run('tar', ['-x', '-f', file, '-C', staging]);
      if (result.status !== 0) throw new Error(`tar failed: ${result.output}`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(file, { force: true });
    }
    return {};
  }

  async reload({ names }: Params<'resource.reload'>): Promise<Result<'resource.reload'>> {
    if (!(await this.rconAlive())) return { output: 'server not running; reload skipped' };
    const outputs = [await this.rcon('refresh')];
    for (const name of names) outputs.push(await this.rcon(`ensure ${name}`));
    return { output: outputs.map((text) => text.trim()).filter(Boolean).join('\n') };
  }

  async health(): Promise<Result<'health'>> {
    const checks: Result<'health'>['checks'] = [];
    const check = (ok: boolean, label: string, detail: string) => checks.push({ ok, label, detail });
    const build = fs.existsSync(this.paths.buildMarker) ? fs.readFileSync(this.paths.buildMarker, 'utf8').trim() : '';
    check(build !== '', 'fxserver', build ? `build ${build}` : 'not installed');
    const secrets = readSecrets(this.paths.secrets);
    check(Boolean(secrets.get('RCON_PASSWORD')), 'rcon password', this.paths.secrets);
    check(Boolean(secrets.get('LICENSE_KEY')), 'license key', `LICENSE_KEY in ${this.paths.secrets}`);
    check(fs.existsSync(this.paths.serverCfg), 'server.cfg', this.paths.serverCfg);
    const server = await this.serverStatus();
    check(!server.running || server.rcon, 'server', server.running ? `running, rcon ${server.rcon ? 'ok' : 'no answer'}` : 'stopped');
    const client = this.clientStatus();
    check(true, 'client', client.running ? `running (${client.processes.join(', ')})` : 'not running');
    return { checks };
  }

  private buffer(target: 'server' | 'client'): ConsoleBuffer {
    return target === 'server' ? this.server : this.client;
  }

  async handle(method: MethodName, params: unknown): Promise<unknown> {
    switch (method) {
      case 'hello': {
        const { version } = methods.hello.params.parse(params);
        if (version !== VERSION) {
          throw new Error(`version mismatch: dev host ${version}, test host ${VERSION}; run \`fivem-testbed host install\``);
        }
        return { version: VERSION, root: this.paths.root };
      }
      case 'health':
        return this.health();
      case 'server.configure':
        return this.configure(methods['server.configure'].params.parse(params));
      case 'server.start':
        return this.start();
      case 'server.stop':
        return this.stop();
      case 'server.restart':
        await this.stop();
        return this.start();
      case 'server.status':
        return this.serverStatus();
      case 'client.launch':
        return this.launch();
      case 'client.quit':
        return this.quit();
      case 'client.status':
        return this.clientStatus();
      case 'rcon': {
        const { command } = methods.rcon.params.parse(params);
        return { output: await this.rcon(command) };
      }
      case 'console.read': {
        const p = methods['console.read'].params.parse(params);
        const buffer = this.buffer(p.target);
        const lines = buffer.read({
          ...(p.after !== undefined ? { after: p.after } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
          ...(p.pattern ? { pattern: new RegExp(p.pattern, 'i') } : {}),
        });
        return { lines, cursor: buffer.cursor };
      }
      case 'console.wait': {
        const p = methods['console.wait'].params.parse(params);
        const buffer = this.buffer(p.target);
        const line = await buffer.wait(new RegExp(p.pattern, 'i'), {
          timeoutMs: p.timeoutMs,
          ...(p.after !== undefined ? { after: p.after } : {}),
        });
        return { line, cursor: buffer.cursor };
      }
      case 'resource.upload':
        return this.upload(methods['resource.upload'].params.parse(params));
      case 'resource.commit':
        return this.commit(methods['resource.commit'].params.parse(params));
      case 'resource.reload':
        return this.reload(methods['resource.reload'].params.parse(params));
    }
  }

  shutdown(): void {
    if (this.fxserver?.pid) killTree(this.fxserver.pid);
  }
}

function serveConnection(socket: net.Socket, daemon: Daemon, token: Buffer): void {
  const splitter = new LineSplitter();
  let authed = false;
  socket.setEncoding('utf8');
  const send = (message: unknown) => {
    if (!socket.destroyed) socket.write(encode(message));
  };
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    for (const line of splitter.push(chunk)) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: PROTOCOL_ERROR.parse, message: 'invalid JSON' } });
        continue;
      }
      if (!authed) {
        const given = auth.safeParse(message);
        const ok =
          given.success &&
          Buffer.byteLength(given.data.auth) === token.length &&
          timingSafeEqual(Buffer.from(given.data.auth), token);
        if (!ok) {
          socket.destroy();
          return;
        }
        authed = true;
        continue;
      }
      const parsed = request.safeParse(message);
      if (!parsed.success) {
        send({ jsonrpc: '2.0', id: null, error: { code: PROTOCOL_ERROR.invalidRequest, message: 'invalid request' } });
        continue;
      }
      const { id, method, params } = parsed.data;
      if (!isMethodName(method)) {
        send({ jsonrpc: '2.0', id, error: { code: PROTOCOL_ERROR.methodNotFound, message: `unknown method ${method}` } });
        continue;
      }
      daemon
        .handle(method, params ?? {})
        .then((result) => send({ jsonrpc: '2.0', id, result }))
        .catch((error: unknown) =>
          send({ jsonrpc: '2.0', id, error: { code: APP_ERROR, message: error instanceof Error ? error.message : String(error) } }),
        );
    }
  });
}

export async function runDaemon(root: string): Promise<void> {
  const paths = hostPaths(root);
  fs.mkdirSync(paths.root, { recursive: true });
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(paths.token, token, { mode: 0o600 });
  run('icacls', [paths.token, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`, 'SYSTEM:F']);

  const daemon = new Daemon(paths);
  const pipe = pipeName(os.userInfo().username);
  const server = net.createServer((socket) => serveConnection(socket, daemon, Buffer.from(token)));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => resolve());
  });
  process.title = 'fivem-testbed daemon';
  console.log(`fivem-testbed ${VERSION} daemon: listening on ${pipe}, root ${paths.root}`);
  const exit = () => {
    daemon.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);
}
