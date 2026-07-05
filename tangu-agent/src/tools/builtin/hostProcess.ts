/**
 * 后台进程工具(host 模式):run_background 启动长跑命令(dev server/watch/长测试),
 * list_processes / read_process_output 轮询,kill_process 终止(进审批闸门,见 approvals)。
 * 注册表与生命周期在 ../processRegistry.ts;模块 dispose 时统一 SIGKILL 防泄漏。
 * 注意:不给 run_bash 加 background 参数——改既有工具的 schema 会打破 defs 字节级前缀稳定。
 */
import { startBackgroundProcess, listProcesses, getProcess, killProcess, writeStdin, waitForOutput } from '../processRegistry.js';
import type { ToolProvider } from '../toolRegistry.js';

const READ_CHUNK_CHARS = 20_000;
const WRITE_YIELD_DEFAULT_MS = 8_000;
const WRITE_YIELD_MIN_MS = 250;
const WRITE_YIELD_MAX_MS = 15_000;

export const hostProcessProvider: ToolProvider = {
  id: 'builtin:host-process',
  tools: () => [
    {
      name: 'run_background',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      definition: {
        type: 'function',
        function: {
          name: 'run_background',
          description:
            'Start a long-running shell command in the background on this machine (dev server, watch, long test, etc.) and return a process_id immediately. ' +
            'Use read_process_output to view output, list_processes to check status, kill_process to terminate. ' +
            'Use run_bash for one-off commands; only use this for things that must keep running or must not block subsequent steps. ' +
            'You can also start **interactive** processes (such as `python3 -i`, `node`, a question-and-answer CLI), then feed input to their stdin with write_process_input. ' +
            'Note: this is a pipe, not a real TTY — it supports line-based input (REPL/debugger/line-by-line prompts), but not full-screen TUIs (vim/top), ' +
            'programs that only become interactive when isatty is detected, or reading passwords from /dev/tty (sudo/ssh).',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'The shell command to run in the background' } },
            required: ['command'],
          },
        },
      },
      execute: (args, ctx) => {
        const command = String(args.command ?? '').trim();
        if (!command) return 'Error: command is required';
        const r = startBackgroundProcess(ctx.sessionId, command, ctx.cwd || process.cwd());
        if (typeof r === 'string') return r;
        return `started background process ${r.id} (pid ${r.pid})\n稍后用 read_process_output 查看输出。`;
      },
    },
    {
      name: 'list_processes',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      definition: {
        type: 'function',
        function: {
          name: 'list_processes',
          description: 'List the background processes started in this session (id/command/status/uptime).',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      execute: (_args, ctx) => {
        const list = listProcesses(ctx.sessionId);
        if (!list.length) return '(no background processes)';
        return list
          .map((p) => {
            const dur = Math.round(((p.endedAt ?? Date.now()) - p.startedAt) / 1000);
            const code = p.exitCode !== null ? ` exit=${p.exitCode}` : '';
            return `${p.id} [${p.status}${code}] ${dur}s · ${p.command.length > 80 ? p.command.slice(0, 80) + '…' : p.command}`;
          })
          .join('\n');
      },
    },
    {
      name: 'read_process_output',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      definition: {
        type: 'function',
        function: {
          name: 'read_process_output',
          description: 'Read the accumulated output of a background process (stdout+stderr merged). offset is a character offset; omit it to read the tail.',
          parameters: {
            type: 'object',
            properties: {
              process_id: { type: 'string', description: 'The process id returned by run_background' },
              offset: { type: 'number', description: 'Starting character offset (defaults to the most recent 20000 characters)' },
            },
            required: ['process_id'],
          },
        },
      },
      execute: (args, ctx) => {
        const p = getProcess(ctx.sessionId, String(args.process_id ?? ''));
        if (!p) return `Error: 进程 ${args.process_id} 不存在`;
        const total = p.output.length;
        const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) >= 0 ? Number(args.offset) : Math.max(0, total - READ_CHUNK_CHARS);
        const chunk = p.output.slice(offset, offset + READ_CHUNK_CHARS);
        const head = `[${p.id} ${p.status}${p.exitCode !== null ? ` exit=${p.exitCode}` : ''} · chars ${offset}-${offset + chunk.length} of ${total}${p.truncated ? '(头部已被环形缓冲覆盖)' : ''}]`;
        return `${head}\n${chunk || '(no output yet)'}`;
      },
    },
    {
      name: 'kill_process',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      definition: {
        type: 'function',
        function: {
          name: 'kill_process',
          description: 'Terminate a background process (SIGTERM→3s→SIGKILL).',
          parameters: {
            type: 'object',
            properties: { process_id: { type: 'string', description: 'The id of the process to terminate' } },
            required: ['process_id'],
          },
        },
      },
      execute: (args, ctx) => killProcess(ctx.sessionId, String(args.process_id ?? '')),
    },
    // append-only(保前缀缓存):交互式 stdin 写入 + yield 收集本轮新输出。
    {
      name: 'write_process_input',
      mode: 'host',
      isEnabledFor: (profile) => profile.capabilities.hostExec,
      definition: {
        type: 'function',
        function: {
          name: 'write_process_input',
          description:
            'Write one line of input to a background process\'s stdin to drive an interactive process (REPL/debugger/Q&A CLI). ' +
            'A trailing newline is appended by default (most line-based programs need a newline to process input). After writing, it waits for the process to produce new output and settle, then returns the **new** output. ' +
            'Leave input empty to only poll (don\'t write, just see what else the process emitted); pass a single Ctrl-C character as input to send an interrupt signal. ' +
            'The process must have been started by run_background and still be running.',
          parameters: {
            type: 'object',
            properties: {
              process_id: { type: 'string', description: 'The process id returned by run_background' },
              input: { type: 'string', description: 'The text to write to stdin (leave empty to only poll for new output)' },
              append_newline: { type: 'boolean', description: 'Whether to append a trailing newline (default true)' },
              yield_ms: { type: 'number', description: `Maximum milliseconds to wait for new output (default ${WRITE_YIELD_DEFAULT_MS}, range ${WRITE_YIELD_MIN_MS}-${WRITE_YIELD_MAX_MS})` },
            },
            required: ['process_id'],
          },
        },
      },
      execute: async (args, ctx) => {
        const id = String(args.process_id ?? '');
        const p = getProcess(ctx.sessionId, id);
        if (!p) return `Error: 进程 ${id} 不存在`;
        const input = typeof args.input === 'string' ? args.input : '';
        const appendNewline = args.append_newline !== false; // 默认 true
        const capMs = Math.min(
          WRITE_YIELD_MAX_MS,
          Math.max(WRITE_YIELD_MIN_MS, Number.isFinite(Number(args.yield_ms)) ? Number(args.yield_ms) : WRITE_YIELD_DEFAULT_MS),
        );
        const fromLen = p.output.length;
        if (input !== '') {
          const w = writeStdin(ctx.sessionId, id, input, appendNewline);
          if (w.startsWith('Error:')) return w;
        }
        const { output, status } = await waitForOutput(p, fromLen, { capMs, signal: ctx.signal });
        const exit = p.exitCode !== null ? ` exit=${p.exitCode}` : '';
        return `[${id} ${status}${exit} · +${output.length} chars]\n${output || '(no new output)'}`;
      },
    },
  ],
};
