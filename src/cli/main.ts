// Dev host CLI dispatch (SPEC-0001 section 11).
import { VERSION } from '../protocol/version.ts';
import * as commands from './commands.ts';
import { findProject } from './project.ts';

export const USAGE = `fivem-testbed ${VERSION}

usage: fivem-testbed <command>

  init                                  write fivem-testbed.config.json and a server.cfg
  host install [--local]                install this version on the test host and run host setup
  deploy [resource...]                  build, upload and restart resources
  server <start|stop|restart|status>
  client <launch|quit|status>
  logs [--client] [--follow] [--lines <n>]
  rcon <command...>
  doctor                                check the test environment

on the test host:
  host setup --root <dir> --build <build>
  host daemon --root <dir>
  host connect --root <dir>`;

export async function runCli([command, ...args]: string[]): Promise<void> {
  switch (command) {
    case 'init':
      return commands.init();
    case 'doctor':
      return commands.doctor();
    case 'deploy':
      return commands.deploy(findProject(), args);
    case 'server':
      return commands.server(findProject(), args[0]);
    case 'client':
      return commands.client(findProject(), args[0]);
    case 'rcon':
      return commands.rconCommand(findProject(), args);
    case 'logs':
      return commands.logs(findProject(), args);
    case 'host':
      if (args[0] === 'install') return commands.hostInstall(findProject(), args.includes('--local'));
      throw new commands.UsageError(USAGE);
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;
    case '--version':
      console.log(VERSION);
      return;
    default:
      throw new commands.UsageError(USAGE);
  }
}
