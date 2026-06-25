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
            '在本机后台启动一条长跑 shell 命令(dev server、watch、长测试等),立即返回 process_id。' +
            '用 read_process_output 看输出、list_processes 看状态、kill_process 终止。' +
            '一次性命令请用 run_bash;只有需要持续运行/不能阻塞后续步骤的才用这个。' +
            '也可启动**交互式**进程(如 `python3 -i`、`node`、问答式 CLI),再用 write_process_input 向其 stdin 喂输入。' +
            '注意:管道而非真 TTY——支持行式输入(REPL/调试器/逐行提示),但不支持全屏 TUI(vim/top)、' +
            '检测 isatty 才变交互的程序、以及从 /dev/tty 读密码(sudo/ssh)。',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: '要后台执行的 shell 命令' } },
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
          description: '列出本会话启动的后台进程(id/命令/状态/运行时长)。',
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
          description: '读取某后台进程的累计输出(stdout+stderr 合流)。offset 为字符偏移,省略则读尾部。',
          parameters: {
            type: 'object',
            properties: {
              process_id: { type: 'string', description: 'run_background 返回的进程 id' },
              offset: { type: 'number', description: '起始字符偏移(默认读最近 20000 字符)' },
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
          description: '终止某个后台进程(SIGTERM→3s→SIGKILL)。',
          parameters: {
            type: 'object',
            properties: { process_id: { type: 'string', description: '要终止的进程 id' } },
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
            '向某后台进程的 stdin 写入一行输入,用于驱动交互式进程(REPL/调试器/问答式 CLI)。' +
            '默认在末尾补换行(多数行式程序需要换行才处理)。写入后会等待该进程产出新输出并稳定下来,返回**新增**输出。' +
            'input 留空=只轮询(不写,看进程又吐了什么);input 传单个 Ctrl-C 字符则发送中断信号。' +
            '进程须由 run_background 启动且仍在运行。',
          parameters: {
            type: 'object',
            properties: {
              process_id: { type: 'string', description: 'run_background 返回的进程 id' },
              input: { type: 'string', description: '要写入 stdin 的文本(留空=仅轮询新输出)' },
              append_newline: { type: 'boolean', description: '是否在末尾补换行(默认 true)' },
              yield_ms: { type: 'number', description: `最多等待新输出的毫秒数(默认 ${WRITE_YIELD_DEFAULT_MS},范围 ${WRITE_YIELD_MIN_MS}-${WRITE_YIELD_MAX_MS})` },
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
