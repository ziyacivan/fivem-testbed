// JSON-RPC methods between the dev host and the daemon (SPEC-0001 section 8).
import { z } from 'zod';

export const consoleTarget = z.enum(['server', 'client']);
export type ConsoleTarget = z.infer<typeof consoleTarget>;

export const consoleLine = z.object({ seq: z.number().int(), time: z.number(), text: z.string() });
export type ConsoleLine = z.infer<typeof consoleLine>;

const empty = z.object({}).strict();
const output = z.object({ output: z.string() });

const serverStatus = z.object({
  running: z.boolean(),
  pid: z.number().int().optional(),
  rcon: z.boolean(),
  startedAt: z.number().optional(),
});

const clientStatus = z.object({ running: z.boolean(), processes: z.array(z.string()) });

const healthCheck = z.object({ ok: z.boolean(), label: z.string(), detail: z.string() });

export const methods = {
  hello: {
    params: z.object({ version: z.string() }),
    result: z.object({ version: z.string(), root: z.string() }),
  },
  health: { params: empty, result: z.object({ checks: z.array(healthCheck) }) },
  'server.configure': {
    params: z.object({ serverCfg: z.string(), connect: z.string() }),
    result: empty,
  },
  'server.start': { params: empty, result: serverStatus },
  'server.stop': { params: empty, result: serverStatus },
  'server.restart': { params: empty, result: serverStatus },
  'server.status': { params: empty, result: serverStatus },
  'client.launch': { params: empty, result: clientStatus },
  'client.quit': { params: empty, result: clientStatus },
  'client.status': { params: empty, result: clientStatus },
  rcon: { params: z.object({ command: z.string().min(1).max(512) }), result: output },
  'console.read': {
    params: z.object({
      target: consoleTarget,
      after: z.number().int().optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      pattern: z.string().optional(),
    }),
    result: z.object({ lines: z.array(consoleLine), cursor: z.number().int() }),
  },
  'console.wait': {
    params: z.object({
      target: consoleTarget,
      pattern: z.string(),
      after: z.number().int().optional(),
      timeoutMs: z.number().int().min(1).max(600_000),
    }),
    result: z.object({ line: consoleLine.nullable(), cursor: z.number().int() }),
  },
  'resource.upload': {
    params: z.object({ uploadId: z.string().regex(/^[\w-]{8,64}$/), chunk: z.string() }),
    result: z.object({ bytes: z.number().int() }),
  },
  'resource.commit': {
    params: z.object({
      uploadId: z.string().regex(/^[\w-]{8,64}$/),
      category: z.string().regex(/^\[[\w-]+\]$/),
      name: z.string().regex(/^[\w-]+$/),
    }),
    result: empty,
  },
  'resource.reload': { params: z.object({ names: z.array(z.string().regex(/^[\w-]+$/)) }), result: output },
} as const;

export type Methods = typeof methods;
export type MethodName = keyof Methods;
export type Params<M extends MethodName> = z.infer<Methods[M]['params']>;
export type Result<M extends MethodName> = z.infer<Methods[M]['result']>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
