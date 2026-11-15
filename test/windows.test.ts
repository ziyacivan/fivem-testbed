import { describe, expect, it } from 'vitest';
import { idsUnder } from '../src/host/windows.ts';

const SERVER = 'C:\\fivem-testbed\\server';

describe('idsUnder (SPEC-0005)', () => {
  it('keeps only the processes in the folder', () => {
    const lines = [
      '9420|C:\\redm-testbed\\server\\FXServer.exe',
      '1200|C:\\fivem-testbed\\server\\FXServer.exe',
      '28408|C:\\redm-testbed\\server\\FXServer.exe',
    ].join('\r\n');
    expect(idsUnder(lines, SERVER)).toEqual([1200]);
  });

  it('ignores case and the kind of slash', () => {
    expect(idsUnder('7|c:/FiveM-Testbed/Server/fxserver.exe', SERVER)).toEqual([7]);
    expect(idsUnder('7|C:\\fivem-testbed\\server\\FXServer.exe', 'c:/fivem-testbed/server/')).toEqual([7]);
  });

  it('does not match a folder that only starts with the same name', () => {
    expect(idsUnder('8|C:\\fivem-testbed\\server2\\FXServer.exe', SERVER)).toEqual([]);
    expect(idsUnder('8|C:\\fivem-testbed\\server.staging\\FXServer.exe', SERVER)).toEqual([]);
  });

  it('counts a process with no readable path', () => {
    expect(idsUnder('11|', SERVER)).toEqual([11]);
    expect(idsUnder('11|   ', SERVER)).toEqual([11]);
  });

  it('skips empty and broken lines', () => {
    expect(idsUnder('', SERVER)).toEqual([]);
    expect(idsUnder('no separator\nx|C:\\fivem-testbed\\server\\FXServer.exe\n0|', SERVER)).toEqual([]);
  });
});
