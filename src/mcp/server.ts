// MCP server on the dev host (SPEC-0001 D7, section 12). It runs local actions and calls the daemon over SSH.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runDeploy } from '../cli/deploy.ts';
import { findProject, type Project } from '../cli/project.ts';
import { bridgeClientOps, bridgeServerOps, type MethodName, type Params, type Result } from '../protocol/messages.ts';
import { VERSION } from '../protocol/version.ts';
import { Remote } from '../remote/client.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

class Session {
  private remote: Remote | undefined;
  readonly project: Project;

  constructor(project: Project) {
    this.project = project;
  }

  private async connection(): Promise<Remote> {
    this.remote ??= await Remote.connect(this.project.config);
    return this.remote;
  }

  // Drops a broken connection, so the next call connects again.
  async call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>> {
    const remote = await this.connection();
    try {
      return await remote.call(method, params);
    } catch (error) {
      if ((error as Error).message.includes('ssh exited')) this.remote = undefined;
      throw error;
    }
  }

  async withRemote<T>(run: (remote: Remote) => Promise<T>): Promise<T> {
    return run(await this.connection());
  }

  close(): void {
    this.remote?.close();
  }
}

function tool<A>(run: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return text(await run(args));
    } catch (error) {
      return { ...text(error instanceof Error ? error.message : String(error)), isError: true };
    }
  };
}

const target = z.enum(['server', 'client']).describe('Which console: the FXServer console or the FiveM client console (devcon).');

export async function runMcp(): Promise<void> {
  const session = new Session(findProject());
  const server = new McpServer({ name: 'fivem-testbed', version: VERSION });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'doctor',
    { description: 'Check the configuration, the daemon on the test host, FXServer and FiveM. Call first.', annotations: readOnly },
    tool(async () => {
      const { checks } = await session.call('health', {});
      return checks.map((check) => `${check.ok ? 'OK  ' : 'FAIL'} ${check.label}: ${check.detail}`).join('\n');
    }),
  );

  server.registerTool(
    'deploy',
    {
      description:
        'Run the build command of the project, upload the resources to the test host and restart them (refresh + ensure). ' +
        'Without `resources`, deploys all resources of fivem-testbed.config.json.',
      inputSchema: { resources: z.array(z.string()).optional().describe('Resource names to deploy.') },
    },
    tool(async ({ resources }: { resources?: string[] | undefined }) => {
      const lines: string[] = [];
      await session.withRemote((remote) => runDeploy(session.project, remote, resources ?? [], (line) => lines.push(line)));
      return lines.join('\n');
    }),
  );

  server.registerTool(
    'server_control',
    { description: 'Start, stop, restart or read the state of FXServer on the test host.', inputSchema: { action: z.enum(['start', 'stop', 'restart', 'status']) } },
    tool(async ({ action }: { action: 'start' | 'stop' | 'restart' | 'status' }) => session.call(`server.${action}`, {})),
  );

  server.registerTool(
    'client_control',
    {
      description: 'Launch FiveM on the test host and join the test server, quit it, or read its state. A join takes about 1 to 2 minutes.',
      inputSchema: { action: z.enum(['launch', 'quit', 'status']) },
    },
    tool(async ({ action }: { action: 'launch' | 'quit' | 'status' }) => session.call(`client.${action}`, {})),
  );

  server.registerTool(
    'server_command',
    { description: 'Run one FXServer console command over RCON and return its output.', inputSchema: { command: z.string().min(1) } },
    tool(async ({ command }: { command: string }) => (await session.call('rcon', { command })).output),
  );

  server.registerTool(
    'client_command',
    {
      description:
        'Run one F8 console command in the FiveM client (devcon) and return the console lines it printed. ' +
        'This is the client console, not chat: RegisterCommand chat commands do not run here.',
      inputSchema: { command: z.string().min(1), timeoutMs: z.number().int().optional() },
    },
    tool(async ({ command, timeoutMs }: { command: string; timeoutMs?: number | undefined }) =>
      (await session.call('client.command', { command, ...(timeoutMs ? { timeoutMs } : {}) })).lines.join('\n'),
    ),
  );

  server.registerTool(
    'read_console',
    {
      description: 'Read console lines. Without `after`, returns the newest lines. Use the returned cursor as `after` to page.',
      inputSchema: {
        target,
        after: z.number().int().optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        pattern: z.string().optional().describe('Case-insensitive regular expression filter.'),
      },
      annotations: readOnly,
    },
    tool(async (args: Params<'console.read'>) => {
      const { lines, cursor } = await session.call('console.read', args);
      return `${lines.map((line) => line.text).join('\n')}\n(cursor ${cursor})`;
    }),
  );

  server.registerTool(
    'wait_for_console',
    {
      description: 'Wait for the first console line that matches a pattern. Your assertion primitive. Returns null on timeout.',
      inputSchema: {
        target,
        pattern: z.string().describe('Case-insensitive regular expression.'),
        after: z.number().int().optional().describe('Only lines after this cursor. Default: lines from now on.'),
        timeoutMs: z.number().int().min(1).max(600_000).default(30_000),
      },
      annotations: readOnly,
    },
    tool(async (args: Params<'console.wait'>) => session.call('console.wait', args)),
  );

  server.registerTool(
    'bridge',
    {
      description:
        `Run a testbed-bridge operation inside the game. Server ops: ${bridgeServerOps.join(', ')}. ` +
        `Client ops (need src, the server ID of the player): ${bridgeClientOps.join(', ')}. ` +
        'Args: call_export {resource, method, args}, trigger_event {event, args, player?}, teleport {x, y, z, heading?}, ' +
        'freeze {on}, call_native {name, args}, nui_callback {resource, endpoint, payload, timeoutMs?}.',
      inputSchema: {
        target: z.enum(['server', 'client']),
        op: z.enum([...new Set([...bridgeServerOps, ...bridgeClientOps])] as [string, ...string[]]),
        src: z.number().int().min(1).optional(),
        args: z.record(z.string(), z.unknown()).optional(),
      },
    },
    tool(async ({ target: side, op, src, args }: { target: 'server' | 'client'; op: string; src?: number | undefined; args?: Record<string, unknown> | undefined }) => {
      if (side === 'client' && src === undefined) throw new Error('a client op needs src (bridge server op `players` lists them)');
      const params = side === 'server' ? { target: side, op, args: args ?? {} } : { target: side, op, src, args: args ?? {} };
      return session.call('bridge', params as Params<'bridge'>);
    }),
  );

  server.registerPrompt(
    'test_resource',
    {
      description: 'Deploy a resource, scan both consoles for errors, run an in-game scenario and report PASS or FAIL with evidence.',
      argsSchema: { resource: z.string(), expectations: z.string().optional() },
    },
    ({ resource, expectations }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Test the FiveM resource "${resource}" with the fivem-testbed tools.`,
              '1. Call doctor. Stop and report if a check fails.',
              `2. Call deploy with resources ["${resource}"]. If the server is stopped, call server_control start.`,
              `3. wait_for_console (server) for "Started resource ${resource}" or an error line.`,
              '4. read_console (server) and look for errors and warnings of the resource.',
              '5. client_control status. If FiveM does not run, launch it and wait until bridge server players lists a player.',
              '6. read_console (client) and look for script errors of the resource.',
              `7. Run the scenario with bridge ops and console tools.${expectations ? ` Expectations: ${expectations}` : ''}`,
              '8. Report PASS or FAIL for each expectation, with the console lines or bridge results as evidence. Say so when you cannot verify a step.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => {
    session.close();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
