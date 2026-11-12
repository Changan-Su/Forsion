/** Isolated data reduction: no Node globals, filesystem, imports or network in the VM.
 * Only JSON/text crosses the boundary. Each invocation owns its WASM instance. */
import { newAsyncContext } from 'quickjs-emscripten';

export const READ_ONLY_PROGRAM_TOOLS = new Set([
  'read_file', 'list_dir', 'list_files', 'search_files', 'glob_files',
  'calculator', 'get_datetime', 'todo_read', 'read_tool_output',
]);
export interface ProgramOptions {
  signal?: AbortSignal;
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
  timeoutMs?: number;
}
export async function runReadOnlyProgram(code: string, options: ProgramOptions): Promise<string> {
  if (!code || code.length > 24_000) throw new Error('code must contain 1–24000 characters');
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 60_000)]);
  signal.throwIfAborted();
  const vm = await newAsyncContext();
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  let computeDeadline = Date.now() + 1000;
  vm.runtime.setInterruptHandler(() => signal.aborted || Date.now() > computeDeadline);
  let calls = 0, inputChars = 0, outputChars = 0;
  const output: string[] = [];
  let bridgeFailure: Error | undefined;
  try {
    const tool = vm.newAsyncifiedFunction('tool', async (nameHandle, argsHandle) => {
      try {
        if (bridgeFailure) throw bridgeFailure;
        signal.throwIfAborted();
        if (++calls > 32) throw new Error('Read-only program exceeded 32 tool calls');
        const name = vm.getString(nameHandle);
        if (!READ_ONLY_PROGRAM_TOOLS.has(name)) throw new Error(`Tool ${name} is not allowed in read_only_code`);
        const args = vm.dump(argsHandle);
        if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 32_000) throw new Error('Tool arguments must be a JSON object of at most 32000 characters');
        const text = await options.call(name, args, signal);
        signal.throwIfAborted();
        inputChars += text.length;
        if (inputChars > 2_000_000) throw new Error('Read-only program exceeded its 2 MB input budget');
        computeDeadline = Date.now() + 1000;
        return vm.newString(text);
      } catch (error) {
        bridgeFailure ??= error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    });
    vm.setProp(vm.global, 'tool', tool); tool.dispose();
    const print = vm.newFunction('print', (...args) => {
      const line = args.map(arg => { const value = vm.dump(arg); return typeof value === 'string' ? value : JSON.stringify(value); }).join(' ');
      outputChars += line.length + 1;
      if (outputChars > 24_000) {
        bridgeFailure ??= new Error('Printed output exceeds 24000 characters; filter or aggregate before printing');
        throw bridgeFailure;
      }
      output.push(line);
    });
    vm.setProp(vm.global, 'print', print); print.dispose();
    // Script mode is deliberately synchronous to callers; Asyncify suspends only at tool().
    const result = await vm.evalCodeAsync(`"use strict";\n${code}`, 'read-only-program.js', { type: 'global' });
    if (result.error) {
      const error = vm.dump(result.error); result.error.dispose();
      throw new Error(`Read-only program failed: ${error?.message || JSON.stringify(error)}`);
    }
    result.value.dispose();
    if (bridgeFailure) throw bridgeFailure;
    signal.throwIfAborted();
    return output.length ? output.join('\n') : 'No output. Use print(value) to return selected evidence to the model.';
  } finally { vm.dispose(); }
}
