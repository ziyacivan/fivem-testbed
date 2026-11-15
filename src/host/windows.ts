// Small wrappers around Windows tools on the test host.
import { spawnSync } from 'node:child_process';

export function run(command: string, args: string[]): { status: number; output: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

export function powershell(script: string): { status: number; output: string } {
  const encoded = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
}

// Image names of running processes that start with the prefix (case-insensitive).
export function processesWithPrefix(prefix: string): string[] {
  const result = run('tasklist', ['/fo', 'csv', '/nh']);
  const names = new Set<string>();
  for (const line of result.output.split(/\r?\n/)) {
    const name = line.split('","')[0]?.replace(/^"/, '');
    if (name?.toLowerCase().startsWith(prefix.toLowerCase())) names.add(name);
  }
  return [...names];
}

// IDs of the running processes of the image whose executable is in the folder (SPEC-0005 D1).
// Other FXServer processes on the host (for example of redm-testbed) do not count.
export function processesUnder(image: string, folder: string): number[] {
  const filter = `Name='${image.replace(/'/g, "''")}'`;
  const result = powershell(
    `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [string]$_.ProcessId + '|' + $_.ExecutablePath }`,
  );
  return idsUnder(result.output, folder);
}

// Parses `<id>|<path>` lines (SPEC-0005 D2, D3). A line with no path counts as in the folder.
export function idsUnder(lines: string, folder: string): number[] {
  const normalize = (value: string) => value.trim().replace(/\//g, '\\').toLowerCase();
  const prefix = normalize(folder).replace(/\\+$/, '') + '\\';
  const ids: number[] = [];
  for (const line of lines.split(/\r?\n/)) {
    const separator = line.indexOf('|');
    if (separator < 0) continue;
    const id = Number(line.slice(0, separator).trim());
    if (!Number.isInteger(id) || id <= 0) continue;
    const exe = normalize(line.slice(separator + 1));
    if (exe === '' || exe.startsWith(prefix)) ids.push(id);
  }
  return ids;
}

export function killTree(pid: number): void {
  run('taskkill', ['/f', '/t', '/pid', String(pid)]);
}

export function killImage(image: string): void {
  run('taskkill', ['/f', '/t', '/im', image]);
}
