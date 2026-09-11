import { expect, it } from 'vitest';
import { hostShellName, hostShellQuoting } from './shellPrompt.js';
it('describes the actual Windows shell and avoids the single-quote pipe trap', () => {
  expect(hostShellName('win32')).toContain('ComSpec');
  expect(hostShellName('win32')).not.toContain('/bin/sh');
  expect(hostShellQuoting('win32')).toContain('Single quotes do not protect');
  expect(hostShellQuoting('win32')).toContain('UTF-16LE');
});
it('leaves POSIX definitions unchanged', () => {
  expect(hostShellName('darwin')).toBe('/bin/sh -c');
  expect(hostShellQuoting('linux')).toBe('');
});
