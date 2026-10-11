// Project configuration file `fivem-testbed.config.json` (SPEC-0001 section 10).
import { z } from 'zod';

export const CONFIG_FILE = 'fivem-testbed.config.json';

export const resourceEntry = z.object({
  name: z.string().regex(/^[\w-]+$/),
  path: z.string().min(1),
  category: z.string().regex(/^\[[\w-]+\]$/).default('[project]'),
  reload: z.boolean().optional(),
});

export const projectConfig = z.object({
  $schema: z.string().optional(),
  host: z.string().min(1),
  root: z.string().default('C:/fivem-testbed'),
  fxserver: z.object({ build: z.string().regex(/^\d+-[0-9a-f]{40}$/) }),
  connect: z.string().regex(/^[\w.-]+:\d+$/).default('127.0.0.1:30120'),
  build: z.string().optional(),
  serverCfg: z.string().default('fivem-testbed/server.cfg'),
  resources: z.array(resourceEntry).default([]),
});

export type ProjectConfig = z.infer<typeof projectConfig>;
export type ResourceEntry = z.infer<typeof resourceEntry>;

export function fxserverUrl(build: string): string {
  return `https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/${build}/server.7z`;
}

export function pipeName(user: string): string {
  return `\\\\.\\pipe\\fivem-testbed-${user.toLowerCase().replace(/[^\w-]/g, '_')}`;
}
