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
const READ_DOC_MAX_BYTES = 50 * 1024 * 1024; // ponytail: 文本型 PDF 足够;真要超大文档再调

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

/** cat -n 风格按行分页(host read_file):每行前缀「右对齐行号 + Tab」(1-based),带 [lines a-b of N] 头。
 *  行号给模型定位坐标、并逼它精确复制缩进,从而命中 edit_file/multi_edit 的唯一 old_string —— 这是模型
 *  敢做「局部编辑」而非「整文件覆写」的关键。offset 仍是 0-based 入参(向后兼容),显示行号一律 1-based。 */
export function paginate(text: string, offset?: number, limit?: number): string {
  const lines = text.split('\n');
  const total = lines.length;
  const start = Math.min(Math.max(0, offset ?? 0), total);
  const cappedLimit = Math.min(limit ?? READ_MAX_LINES, READ_MAX_LINES);
  const end = Math.min(start + cappedLimit, total);
  let body = lines.slice(start, end).map((l, i) => String(start + i + 1).padStart(6) + '\t' + l).join('\n');
  let trimmed = false;
  if (body.length > READ_MAX_CHARS) { body = body.slice(0, READ_MAX_CHARS); trimmed = true; }
  const more = trimmed ? '\n…[truncated; narrow your limit]'
    : end < total ? `\n…[${total - end} more line(s) below; read with offset:${end}]` : '';
  return `[lines ${start + 1}-${end} of ${total}]\n` + body + more;
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
          'Run a single shell command (/bin/sh -c) on the user\'s machine, with the current session cwd as working directory; returns stdout/stderr/exit_code. ' +
          'Use for running builds/tests, listing directories, git operations, etc. Destructive commands may require user approval.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run' },
            timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
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
        description: 'Read the text content of a file on the machine (path resolved relative to the current working directory). For large files, paginate by line with offset/limit. ' +
          'Output is cat -n style: every line is prefixed with its line number and a tab. When you later feed text to edit_file/multi_edit, strip that "<number>\\t" prefix — old_string must match the file\'s RAW text, not the numbered view.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
            offset: { type: 'number', description: 'Starting line (0-based), default 0' },
            limit: { type: 'number', description: 'Maximum number of lines to return (default reads to the end, capped by an upper limit)' },
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
        description: 'Write/overwrite a text file on the machine (intermediate directories are created automatically, path relative to the current working directory). ' +
          'Use this ONLY to create a new file or when replacing essentially all of an existing one. To change part of an existing file, use edit_file / multi_edit / apply_patch and touch only the affected lines — do NOT re-read a file and re-emit the whole thing just to make a small change.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
            content: { type: 'string', description: 'File text content' },
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
          'Make an exact string replacement in a file on the machine: replace the single occurrence of old_string with new_string (indentation/whitespace must match exactly). ' +
          'old_string must appear **exactly once** in the file, otherwise it errors — this keeps changes safe and controlled. ' +
          'Prefer this over rewriting a whole file: to change part of an existing file, edit only the affected lines. ' +
          'old_string matches the RAW file text — do NOT include the leading "<number>\\t" prefix that read_file shows. To create a new file, use write_file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
            old_string: { type: 'string', description: 'The original text to replace (must match uniquely)' },
            new_string: { type: 'string', description: 'The new text to replace it with' },
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
        description: 'List the files and subdirectories under a directory on the machine (path relative to the current working directory, defaults to listing cwd itself).',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Directory path (relative to cwd or absolute), defaults to the current directory' } },
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
          'Make multiple exact replacements in a single file on the machine (atomic: writes only if all match, leaves the file untouched if any fails). ' +
          'Each edit\'s old_string must appear exactly once in the text after the preceding edits have been applied in order (matching the RAW text — do NOT include read_file\'s "<number>\\t" line prefix). ' +
          'Use this to change several regions of an existing file in one shot instead of rewriting the whole file; it is safer and saves turns versus firing off several edit_file calls.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
            edits: {
              type: 'array',
              description: 'List of replacements to apply in order',
              items: {
                type: 'object',
                properties: {
                  old_string: { type: 'string', description: 'The original text to replace (must match uniquely)' },
                  new_string: { type: 'string', description: 'The new text to replace it with' },
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
          'View an image file on the machine: provides the image as visual content for you to "see", for recognizing screenshots, analyzing charts/photos/design mockups/UI, etc. ' +
          'Supports png/jpg/jpeg/gif/webp/bmp; path resolved relative to the current working directory. Use this tool when you need to "look at / read an image"; ' +
          'do not use read_file (it only returns a text hint for images).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Image file path (relative to cwd or absolute)' },
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

  // 文档阅读器：把 PDF（及装了 LibreOffice/ImageMagick 时的 docx/xlsx/pptx）抽成 markdown，
  // 让 agent 真正"读到"内容。read_file 读这类二进制只会吐乱码。引擎用 LiteParse（纯 JS，
  // PDF 走内置 PDFium 无需外部二进制；OCR 默认关，省去 tesseract 模型下载与扫描件的慢）。
  read_document: {
    mode: 'host',
    capabilities: { sideEffect: 'read', parallel: true, defaultTimeoutMs: 120_000 },
    definition: {
      type: 'function',
      function: {
        name: 'read_document',
        description:
          'Extract the text/markdown content of a document so you can actually read it — use this instead of read_file for binary documents (read_file would return garbled bytes). ' +
          'PDF works out of the box; docx/xlsx/pptx need LibreOffice installed on the machine. Path resolved relative to the current working directory. ' +
          'Text-based PDFs need no OCR; for scanned/image-only PDFs set ocr:true (slower, fetches a small OCR model on first use).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Document file path (relative to cwd or absolute), e.g. report.pdf' },
            ocr: { type: 'boolean', description: 'Enable OCR for scanned/image-only PDFs (default false; off is faster and lighter)' },
          },
          required: ['path'],
        },
      },
    },
    execute: async (args, ctx): Promise<string> => {
      const rawPath = String(args.path ?? '');
      if (!rawPath) return 'Error: path is required';
      const abs = resolvePath(ctx, rawPath);
      if (imageMimeForPath(abs)) {
        return `「${relDisplay(ctx, abs)}」是图片,请用 view_image 查看;read_document 用于 PDF/Office 文档。`;
      }
      let size: number;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        return `Error: file not found: ${rawPath}`;
      }
      if (size > READ_DOC_MAX_BYTES) {
        return `Error: 文档过大(${(size / 1024 / 1024).toFixed(1)}MB,上限 ${Math.round(READ_DOC_MAX_BYTES / 1024 / 1024)}MB)。`;
      }
      let LiteParse: any;
      try {
        ({ LiteParse } = await import('@llamaindex/liteparse'));
      } catch {
        return 'Error: 未安装文档解析依赖 @llamaindex/liteparse。请在 Tangu-Agent 包内 `npm i @llamaindex/liteparse` 后重启。';
      }
      try {
        const parser = new LiteParse({ outputFormat: 'markdown', ocrEnabled: args.ocr === true });
        const result = await parser.parse(abs);
        const md = String(typeof result === 'string' ? result : result?.text ?? result?.markdown ?? '').trim();
        if (!md) {
          return `解析成功但未提取到文本:${relDisplay(ctx, abs)} 可能是扫描件/图片型 PDF。` +
            (args.ocr === true ? '(已开启 OCR 仍为空)' : ' 重试时设 ocr:true 走 OCR。');
        }
        return `# ${path.basename(abs)}\n\n` + truncateOutput(md);
      } catch (e: any) {
        return `Error: 文档解析失败(${e?.message || e})。docx/xlsx/pptx 需本机装有 LibreOffice。`;
      }
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
