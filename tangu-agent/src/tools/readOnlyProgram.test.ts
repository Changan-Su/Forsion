import { describe, expect, it, vi } from 'vitest';
import { runReadOnlyProgram } from './readOnlyProgram.js';
describe('isolated read-only programs', () => {
  it('reduces several tool results and returns only printed evidence', async () => {
    const call = vi.fn(async (_name: string, args: any) => JSON.stringify({ source: args.path, value: 7, large: 'private'.repeat(500) }));
    const output = await runReadOnlyProgram('let sum=0; for (const path of ["a", "b", "c"]) sum += JSON.parse(tool("read_file", {path})).value; print({sum});', { call });
    expect(JSON.parse(output)).toEqual({ sum: 21 }); expect(call).toHaveBeenCalledTimes(3);
    expect(output).not.toContain('private');
  });
  it('cannot invoke writes, shell, plugins or host globals', async () => {
    const call = vi.fn(async () => 'bad');
    for (const name of ['write_file', 'run_bash', 'read_only_code', 'mcp__write', 'read_computer_history']) {
      await expect(runReadOnlyProgram(`tool(${JSON.stringify(name)}, {})`, { call })).rejects.toThrow('not allowed');
    }
    expect(call).not.toHaveBeenCalled();
    expect(await runReadOnlyProgram('print([typeof process, typeof require, typeof fetch, typeof WebAssembly]);', { call })).toBe('["undefined","undefined","undefined","undefined"]');
    await expect(runReadOnlyProgram('print.constructor("return process")()', { call })).rejects.toThrow('process');
  });
  it('bounds CPU, output, call count and cancellation', async () => {
    const call = vi.fn(async () => 'x');
    await expect(runReadOnlyProgram('while(true){}', { call, timeoutMs: 50 })).rejects.toThrow();
    await expect(runReadOnlyProgram('print("x".repeat(25000))', { call })).rejects.toThrow('Printed output');
    await expect(runReadOnlyProgram('for(let i=0;i<33;i++) tool("read_file",{})', { call })).rejects.toThrow('32 tool calls');
    const ac = new AbortController(); ac.abort();
    await expect(runReadOnlyProgram('tool("read_file",{})', { call, signal: ac.signal })).rejects.toThrow();
  });
  it('propagates failures rather than presenting partial work as complete', async () => {
    await expect(runReadOnlyProgram('try { tool("read_file", {}) } catch {} print("success");', { call: async () => { throw new Error('Access denied'); } })).rejects.toThrow('Access denied');
    await expect(runReadOnlyProgram('print(tool("read_file", {path:"x"}))', { call: async () => { throw new Error('Access denied'); } })).rejects.toThrow('Access denied');
    await expect(runReadOnlyProgram('tool("read_file", {})', { call: async () => 'x'.repeat(2_000_001) })).rejects.toThrow('input budget');
  });
});
