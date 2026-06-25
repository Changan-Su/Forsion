/**
 * host-exec 工具（仅 TUI / execMode==='host' 暴露）：直接操作用户本机文件系统与 shell，
 * 类 codex/hermes 的本地编码 agent。路径相对 `ctx.cwd`（当前工作目录）解析。
 *
 * 与沙箱工具的取舍由 registry.visibleTools(ctx) 按 ctx.execMode 决定：host 模式隐藏
 * run_python/pip_install 与云工作区文件工具，改用这里的真实 FS 工具 + run_bash。
 *
 * 破坏性操作（run_bash / write_file / edit_file）由 agentLoop 在执行前经审批闸门把关
 * （见 services/approvals.ts）；本文件只管「真去做」，不含审批逻辑。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolImpl } from './toolTypes.js';
import type { ToolProvider } from './toolRegistry.js';
import { checkWritePath } from './fsPolicy.js';

const READ_MAX_CHARS = 100_000;
const READ_MAX_LINES = 2000;
const BASH_OUTPUT_CAP = 100_000; // 单流捕获上限，防爆内存
const BASH_TIMEOUT_MS = 120_000;

// view_image 支持的位图格式(矢量/异类格式 provider 兼容性差,先不收);单图上限贴近 provider 5-10MB。
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const VIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** 按扩展名判定是否受支持的图片;非图片返回 null。 */
function imageMimeForPath(p: string): string | null {
  return IMAGE_MIME[path.extname(p).toLowerCase()] ?? null;
}

/** 把工具路径解析为绝对路径：相对路径相对 cwd，绝对路径原样。 */
export function resolvePath(ctx: ToolContext, p: string): string {
  const cwd = ctx.cwd || process.cwd();
  return path.resolve(cwd, String(p || ''));
}

/** 相对 cwd 的展示路径（让结果更可读，绝对路径回退原样）。 */
function relDisplay(ctx: ToolContext, abs: string): string {
  const cwd = ctx.cwd || process.cwd();
  const rel = path.relative(cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

/** 按行分页 + 字符兜底（host read_file），带 [lines a-b of N] 头便于模型续翻。 */
function paginate(text: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) {
    if (text.length <= READ_MAX_CHARS) return text;
    return text.slice(0, READ_MAX_CHARS) + '\n…[truncated; use offset/limit to read more]';
  }
  const lines = text.split('\n');
  const start = Math.min(Math.max(0, offset || 0), lines.length);
  const cappedLimit = Math.min(limit ?? READ_MAX_LINES, READ_MAX_LINES);
  const end = Math.min(start + cappedLimit, lines.length);
  let out = lines.slice(start, end).join('\n');
  let trimmed = false;
  if (out.length > READ_MAX_CHARS) {
    out = out.slice(0, READ_MAX_CHARS);
    trimmed = true;
  }
  return `[lines ${start}-${end} of ${lines.length}]\n` + out + (trimmed ? '\n…[truncated; narrow your limit]' : '');
}

/** 大输出 head+tail 截断（host 模式无云工作区落盘）。 */
function truncateOutput(text: string, head = 4000, tail = 1500): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return text.slice(0, head) + `\n…[省略 ${omitted} 字符]…\n` + text.slice(-tail);
}

function runBash(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = BASH_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    // detached:true → 子进程自成进程组(pgid=child.pid);超时/中止时杀「整组」,连带它 fork 出的孙进程
    // (dev server / watch / http.server 等)。否则只杀 shell、孙进程残留撑着 stdout 管道 → 'close' 永不
    // 触发 → Promise 永不 resolve → 整个 run 挂死(本次修复的根因)。
    let child;
    try {
      child = spawn(command, { cwd, shell: true, detached: true });
    } catch (e: any) {
      resolve({ stdout: '', stderr: `[spawn error] ${e?.message || e}`, code: -1, timedOut: false, aborted: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout?.on('data', (d) => {
      if (stdout.length < BASH_OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      if (stderr.length < BASH_OUTPUT_CAP) stderr += d.toString();
    });

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, timedOut, aborted });
    };
    // 杀整个进程组(负 pid);非 POSIX / 拿不到 pid 时退回杀 child 本身。杀后给 'close' 1.5s 正常收尾;
    // 仍不来(残留 fd 撑着管道)就强制 resolve —— 绝不无限等 'close'。
    const killGroup = (): void => {
      const pid = child.pid;
      try {
        if (pid && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      if (!graceTimer) graceTimer = setTimeout(() => finish(-1), 1500);
    };
    const onAbort = (): void => { aborted = true; killGroup(); };

    timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    if (signal) {
      if (signal.aborted) { aborted = true; killGroup(); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e: any) => {
      stderr = `${stderr}\n[error] ${e?.message || e}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

export const HOST_TOOLS: Record<string, ToolImpl> = {
  run_bash: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'run_bash',
        description:
          '在用户本机执行一条 shell 命令（/bin/sh -c），工作目录为当前会话的 cwd，返回 stdout/stderr/exit_code。' +
          '用于运行构建/测试、查看目录、git 操作等。破坏性命令可能需要用户审批。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的 shell 命令' },
            timeout_ms: { type: 'number', description: '超时毫秒（默认 120000）' },
          },
          required: ['command'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const command = String(args.command ?? '').trim();
      if (!command) return 'Error: command is required';
      const cwd = ctx.cwd || process.cwd();
      const timeout = Number.isFinite(Number(args.timeout_ms)) && Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : BASH_TIMEOUT_MS;
      const r = await runBash(command, cwd, ctx.signal, timeout);
      let out = '';
      if (r.stdout) out += `stdout:\n${r.stdout}\n`;
      if (r.stderr) out += `stderr:\n${r.stderr}\n`;
      out += `exit_code: ${r.code}`;
      if (r.timedOut) {
        out += ` (timed out after ${timeout}ms, 进程组已终止)`;
        out += '\n提示:这条命令未在超时内返回。常驻/长跑命令(dev server、watch、http.server 等)请改用 ' +
          'run_background 启动,再用 read_process_output / list_processes 查看,避免阻塞。';
      } else if (r.aborted) {
        out += ' (aborted)';
      }
      return truncateOutput(out.trim() || '(no output)');
    },
  },

  read_file: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取本机文件文本内容（路径相对当前工作目录解析）。大文件用 offset/limit 按行分页。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对 cwd 或绝对路径）' },
            offset: { type: 'number', description: '起始行（从 0 计），默认 0' },
            limit: { type: 'number', description: '最多返回行数（默认读尽，受上限封顶）' },
          },
          required: ['path'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const abs = resolvePath(ctx, String(args.path ?? ''));
      // 图片文件文本读取没有意义(会吐二进制乱码)——引导模型改用 view_image「看」图。
      const imgMime = imageMimeForPath(abs);
      if (imgMime) {
        return `「${relDisplay(ctx, abs)}」是图片文件(${imgMime})。read_file 只返回文本;` +
          '要查看/识别图像内容,请按同一路径调用 view_image 工具。';
      }
      const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) >= 0 ? Number(args.offset) : undefined;
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
      let buf: Buffer;
      try {
        buf = await fs.readFile(abs);
      } catch {
        return `Error: file not found: ${args.path}`;
      }
      return paginate(buf.toString('utf-8'), offset, limit);
    },
  },

  write_file: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: '在本机写入/覆盖一个文本文件（中间目录自动创建，路径相对当前工作目录）。整文件覆盖请用此工具；局部修改优先 edit_file。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对 cwd 或绝对路径）' },
            content: { type: 'string', description: '文件文本内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const abs = resolvePath(ctx, String(args.path ?? ''));
      const guard = checkWritePath(ctx, abs);
      if (guard.hardDeny) return `Error: ${guard.reason}`;
      const content = String(args.content ?? '');
      try {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf-8');
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
      return `wrote ${relDisplay(ctx, abs)} (${content.length} chars)`;
    },
  },

  edit_file: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          '对本机文件做精确字符串替换：把唯一出现的 old_string 换成 new_string（含缩进/空白须完全一致）。' +
          'old_string 必须在文件中**恰好出现一次**，否则报错——这样改动安全可控。新建文件请用 write_file。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径（相对 cwd 或绝对路径）' },
            old_string: { type: 'string', description: '要替换的原文（须唯一匹配）' },
            new_string: { type: 'string', description: '替换后的新文本' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const abs = resolvePath(ctx, String(args.path ?? ''));
      const guard = checkWritePath(ctx, abs);
      if (guard.hardDeny) return `Error: ${guard.reason}`;
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) return 'Error: old_string is required (新建文件请用 write_file)';
      let text: string;
      try {
        text = await fs.readFile(abs, 'utf-8');
      } catch {
        return `Error: file not found: ${args.path}`;
      }
      const first = text.indexOf(oldStr);
      if (first === -1) return 'Error: old_string 未在文件中找到（注意空白/缩进须完全一致）';
      if (text.indexOf(oldStr, first + oldStr.length) !== -1) {
        return 'Error: old_string 在文件中出现多次，请补足上下文使其唯一匹配';
      }
      const next = text.slice(0, first) + newStr + text.slice(first + oldStr.length);
      try {
        await fs.writeFile(abs, next, 'utf-8');
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
      return `edited ${relDisplay(ctx, abs)}`;
    },
  },

  list_dir: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'list_dir',
        description: '列出本机某目录下的文件与子目录（路径相对当前工作目录，默认列 cwd 本身）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录路径（相对 cwd 或绝对路径），默认当前目录' } },
          required: [],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const abs = resolvePath(ctx, String(args.path ?? '.'));
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return `Error: directory not found: ${args.path ?? '.'}`;
      }
      if (!entries.length) return '(empty directory)';
      const lines: string[] = [];
      for (const e of entries) {
        if (e.isDirectory()) lines.push(`[dir]  ${e.name}/`);
        else {
          let size = 0;
          try {
            size = (await fs.stat(path.join(abs, e.name))).size;
          } catch {
            /* ignore */
          }
          lines.push(`[file] ${e.name} (${size} bytes)`);
        }
      }
      return lines.join('\n');
    },
  },
  multi_edit: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'multi_edit',
        description:
          '对本机一个文件做多处精确替换(原子:全部匹配才写入,任一失败整体不动)。' +
          '每个 edit 的 old_string 须在「前序 edit 依次应用后的文本」中恰好出现一次。' +
          '同文件多处修改用此工具,比连发多次 edit_file 更安全省轮次。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径(相对 cwd 或绝对路径)' },
            edits: {
              type: 'array',
              description: '按序应用的替换列表',
              items: {
                type: 'object',
                properties: {
                  old_string: { type: 'string', description: '要替换的原文(须唯一匹配)' },
                  new_string: { type: 'string', description: '替换后的新文本' },
                },
                required: ['old_string', 'new_string'],
              },
            },
          },
          required: ['path', 'edits'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const abs = resolvePath(ctx, String(args.path ?? ''));
      const guard = checkWritePath(ctx, abs);
      if (guard.hardDeny) return `Error: ${guard.reason}`;
      const edits = Array.isArray(args.edits) ? args.edits : null;
      if (!edits?.length) return 'Error: edits 必须是非空数组';
      let text: string;
      try {
        text = await fs.readFile(abs, 'utf-8');
      } catch {
        return `Error: file not found: ${args.path}`;
      }
      // 先在内存里全部应用,任一失败整体放弃(原子性)
      let next = text;
      for (let i = 0; i < edits.length; i++) {
        const oldStr = String(edits[i]?.old_string ?? '');
        const newStr = String(edits[i]?.new_string ?? '');
        if (!oldStr) return `Error: edits[${i}].old_string 为空`;
        const first = next.indexOf(oldStr);
        if (first === -1) return `Error: edits[${i}].old_string 未找到(注意前序 edit 已生效;空白/缩进须完全一致),整文件未改动`;
        if (next.indexOf(oldStr, first + oldStr.length) !== -1) {
          return `Error: edits[${i}].old_string 出现多次,请补足上下文使其唯一,整文件未改动`;
        }
        next = next.slice(0, first) + newStr + next.slice(first + oldStr.length);
      }
      try {
        await fs.writeFile(abs, next, 'utf-8');
      } catch (e: any) {
        return `Error: ${e?.message || e}`;
      }
      return `applied ${edits.length} edit(s) to ${relDisplay(ctx, abs)}`;
    },
  },

  // 注册序末尾追加(append-only):新增工具不打乱既有 host 工具定义顺序,旧会话前缀缓存只在部署边界失效一次。
  view_image: {
    mode: 'host',
    definition: {
      type: 'function',
      function: {
        name: 'view_image',
        description:
          '查看本机图片文件:把图片作为图像内容提供给你"看",用于识别截图、分析图表/照片/设计稿/UI 等。' +
          '支持 png/jpg/jpeg/gif/webp/bmp;路径相对当前工作目录解析。需要"看图/识图"时用本工具,' +
          '不要用 read_file(它对图片只返回文本提示)。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '图片文件路径(相对 cwd 或绝对路径)' },
          },
          required: ['path'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const rawPath = String(args.path ?? '');
      if (!rawPath) return 'Error: path is required';
      const abs = resolvePath(ctx, rawPath);
      const mime = imageMimeForPath(abs);
      if (!mime) {
        return `Error: 不支持的图片格式(仅 png/jpg/jpeg/gif/webp/bmp):${rawPath}`;
      }
      let buf: Buffer;
      try {
        buf = await fs.readFile(abs);
      } catch {
        return `Error: file not found: ${rawPath}`;
      }
      if (buf.length > VIEW_IMAGE_MAX_BYTES) {
        return `Error: 图片过大(${(buf.length / 1024 / 1024).toFixed(1)}MB,上限 ${Math.round(VIEW_IMAGE_MAX_BYTES / 1024 / 1024)}MB)。请压缩或裁剪后再查看。`;
      }
      if (!ctx.collectImage) {
        return 'Error: 当前运行环境不支持图像查看(缺少图像回流通道)。';
      }
      ctx.collectImage({ url: `data:${mime};base64,${buf.toString('base64')}`, name: path.basename(abs) });
      return `已加载图片 ${relDisplay(ctx, abs)} (${mime}, ${(buf.length / 1024).toFixed(0)} KB)。` +
        '图像已作为内容提供给你,请直接根据图像本身回答,不要再尝试用 read_file 读取它。';
    },
  },
};

/**
 * host-exec 工具的 ToolProvider 包装(G3)。三重门禁:工具自身 mode:'host'(非 host 模式被滤)、
 * profile.capabilities.hostExec(云端 profile 永不暴露)、loop 的 execMode 能力闸门(agentLoop)。
 * 注册在所有内置 provider 之后——host 模式下按注册序追加在末尾,对齐原「HOST_TOOLS 末尾叠加」行为。
 */
export const hostExecProvider: ToolProvider = {
  id: 'builtin:host-exec',
  tools: () =>
    Object.entries(HOST_TOOLS).map(([name, t]) => ({
      name,
      ...t,
      isEnabledFor: (profile) => profile.capabilities.hostExec,
    })),
};
