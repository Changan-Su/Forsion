/**
 * 服务端工具注册表。Phase A 先放零依赖的纯函数工具（get_datetime / calculator）
 * 证明云端 loop 能调工具；Phase B 追加 web_search / url_fetch / 文件工具 / 沙箱代码执行。
 */
import type { Tool, ToolCall } from '../core/types.js';
import { deps } from '../seams/runtime.js';
import {
  listFiles, readFile, writeFile,
  listFilesLocal, readFileLocal, writeFileLocal,
} from './fileWorkspace.js';
import { installPackages } from '../sandbox/dockerProvider.js';
import { getSessionDir, markSessionDirty, runPythonInSession } from '../sandbox/sessionSandbox.js';
import { executeCustomTool, type LoadedCustomTool } from './customTools.js';
import { HOST_TOOLS } from './hostExec.js';

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const runSearch = (query: string, maxResults: number) => deps().brain.search.runSearch(query, maxResults);
const getSkill = (id: string) => deps().brain.assets.getSkill(id);
const appendMemoryEntry = (userId: string, text: string, opts?: { dedup?: boolean; cap?: number }) =>
  deps().brain.memory.appendMemoryEntry(userId, text, opts);
const appendLogEntry = (userId: string, text: string) => deps().brain.memory.appendLogEntry(userId, text);
const getLog = (userId: string, date?: string) => deps().brain.memory.getLog(userId, date);

export interface ToolContext {
  userId: string;
  sessionId: string;
  appId: string;
  runId?: string;
  signal?: AbortSignal;
  /** 本次 run 的自定义工具（HTTP/JS），按工具名索引。 */
  customTools?: Map<string, LoadedCustomTool>;
  /** 本次 run 启用的技能 id（use_skill 的 allowlist）。 */
  enabledSkillIds?: string[];
  /** 执行形态：'host'=本地直连真实 FS/shell（TUI），缺省/'sandbox'=云沙箱 + 云工作区。 */
  execMode?: 'sandbox' | 'host';
  /** host 模式的工作目录（文件/命令相对此解析）。 */
  cwd?: string;
  /** host 模式的审批档（loop 据此决定哪些破坏性工具执行前需用户批准）。 */
  approvalMode?: 'readonly' | 'auto-edit' | 'full-auto';
}

const USE_SKILL_MAX_CHARS = 120_000;

// 云端纯 Python 沙箱的文档技能「精简速查表」：覆盖 docx/xlsx/pptx/pdf。
// 这些技能的官方正文是给 docx-js/pandoc/OOXML 写的（10万+字），会把模型带成生成超长 verbose 代码、
// 每步 8000+ token、几分钟。这里改喂极简 python 库用法，生成量降一个数量级。按技能 name 匹配。
const CLOUD_SKILL_CHEATSHEETS: Array<{ test: RegExp; title: string; body: string }> = [
  {
    test: /docx|word/i,
    title: 'docx（用 python-docx，云端 Python 沙箱）',
    body: [
      '直接用 python-docx 一步写出 .docx 并 save 到当前目录（会回流工作区）。',
      '不要手搓 OOXML/XML、不要 docx-js/pandoc、不要先写中间文件再转换。',
      '',
      'from docx import Document',
      'from docx.shared import Pt, Inches',
      'doc = Document()',
      "doc.add_heading('标题', level=0)",
      "doc.add_heading('一级标题', level=1)",
      "doc.add_paragraph('正文段落。')",
      "r = doc.add_paragraph().add_run('加粗'); r.bold = True",
      "doc.add_paragraph('项目一', style='List Bullet')",
      "t = doc.add_table(rows=2, cols=3); t.style = 'Table Grid'; t.cell(0,0).text = '表头'",
      "# doc.add_picture('img.png', width=Inches(4)); doc.add_page_break()",
      "doc.save('output.docx')",
      '',
      '按用户要求的篇幅产出，不要无谓加长；一个 run_python 写完整脚本。',
    ].join('\n'),
  },
  {
    test: /xlsx|excel|spreadsheet/i,
    title: 'xlsx（用 openpyxl，云端 Python 沙箱）',
    body: [
      '直接用 openpyxl 写 .xlsx（大数据可用 pandas df.to_excel）。',
      '',
      'from openpyxl import Workbook',
      'from openpyxl.styles import Font',
      "wb = Workbook(); ws = wb.active; ws.title = 'Sheet1'",
      "ws.append(['姓名', '分数']); ws['A1'].font = Font(bold=True)",
      "ws.append(['张三', 95]); ws.column_dimensions['A'].width = 20",
      "wb.save('output.xlsx')",
    ].join('\n'),
  },
  {
    test: /pptx|powerpoint|presentation|ppt/i,
    title: 'pptx（用 python-pptx，云端 Python 沙箱）',
    body: [
      '直接用 python-pptx 写 .pptx。',
      '',
      'from pptx import Presentation',
      'prs = Presentation()',
      's = prs.slides.add_slide(prs.slide_layouts[0])',
      "s.shapes.title.text = '标题'; s.placeholders[1].text = '副标题'",
      's2 = prs.slides.add_slide(prs.slide_layouts[1])',
      "s2.shapes.title.text = '要点'; s2.placeholders[1].text = '第一点\\n第二点'",
      "prs.save('output.pptx')",
    ].join('\n'),
  },
  {
    test: /\bpdf\b/i,
    title: 'pdf（用 reportlab，云端 Python 沙箱）',
    body: [
      '直接用 reportlab 写 .pdf（中文用自带 CID 字体 STSong-Light）。',
      '',
      'from reportlab.lib.pagesizes import A4',
      'from reportlab.lib.styles import getSampleStyleSheet',
      'from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer',
      'from reportlab.pdfbase import pdfmetrics',
      'from reportlab.pdfbase.cidfonts import UnicodeCIDFont',
      "pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))",
      'ss = getSampleStyleSheet()',
      "for n in ('Normal','Title','Heading1'): ss[n].fontName = 'STSong-Light'",
      "doc = SimpleDocTemplate('output.pdf', pagesize=A4)",
      "doc.build([Paragraph('标题', ss['Title']), Spacer(1, 12), Paragraph('正文内容。', ss['Normal'])])",
    ].join('\n'),
  },
];

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: string;
  isError: boolean;
}

export interface ToolImpl {
  definition: Tool;
  execute: (args: Record<string, any>, ctx: ToolContext) => Promise<string> | string;
  /** 工具可见性域：'sandbox'=仅云沙箱模式，'host'=仅本地直连模式，缺省='both'=两者皆可。 */
  mode?: 'sandbox' | 'host' | 'both';
}

// ── 大工具输出落盘：超过 INLINE_LIMIT 的输出写进会话工作区 /.agent/outputs/，上下文只回
//    「预览（头+尾）+ 路径」，模型用 read_file 按需取全文。避免丢数据 + 上下文膨胀。──
const INLINE_LIMIT = 8000; // 与 agentLoop.trimStaleToolMessages 的 8000 对齐：落盘后的预览永不再被截
const PREVIEW_HEAD = 2000;
const PREVIEW_TAIL = 1000; // 尾部留住 traceback / exit_code 行
let outputSeq = 0;

/** 超限则把全文落盘到会话工作区，返回预览+路径；否则原样返回。FS 故障降级为纯截断（不硬失败）。 */
async function persistLargeOutput(
  ctx: ToolContext,
  label: string,
  fullText: string,
): Promise<{ preview: string; path: string | null }> {
  if (fullText.length <= INLINE_LIMIT) return { preview: fullText, path: null };
  let dir: string;
  try {
    dir = await getSessionDir(ctx);
  } catch {
    return { preview: fullText.slice(0, INLINE_LIMIT * 2), path: null };
  }
  const sub = `/.agent/outputs/${label}-${ctx.runId || 'run'}-${++outputSeq}.txt`;
  try {
    await writeFileLocal(dir, sub, fullText);
    markSessionDirty(ctx); // run 末 snapshot 回流 Penzor
  } catch {
    return { preview: fullText.slice(0, INLINE_LIMIT * 2), path: null };
  }
  const omitted = Math.max(0, fullText.length - PREVIEW_HEAD - PREVIEW_TAIL);
  const preview =
    fullText.slice(0, PREVIEW_HEAD) + `\n…[省略 ${omitted} 字符]…\n` + fullText.slice(-PREVIEW_TAIL);
  return { preview, path: sub };
}

/** 把（可能很大的）工具输出整理成回给模型的字符串：小则原样，大则预览+落盘路径提示。 */
async function formatToolOutput(ctx: ToolContext, label: string, fullText: string): Promise<string> {
  const { preview, path } = await persistLargeOutput(ctx, label, fullText);
  if (!path) return preview;
  return `${preview}\n\n[完整输出已存到 ${path} — 用 read_file 配 offset/limit 读取更多]`;
}

const TOOLS: Record<string, ToolImpl> = {
  get_datetime: {
    definition: {
      type: 'function',
      function: {
        name: 'get_datetime',
        description: '获取当前日期与时间（服务器时区）。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    execute: () => {
      const now = new Date();
      return JSON.stringify({ iso: now.toISOString(), local: now.toString() });
    },
  },

  remember: {
    definition: {
      type: 'function',
      function: {
        name: 'remember',
        description:
          '把一条关于用户的稳定、长期有用的事实/偏好写入长期记忆（跨会话保留，会注入到后续对话）。' +
          '仅用于持久信息（如长期偏好、背景设定、称呼），不要记录一次性任务细节或临时上下文。重复内容会被自动忽略。',
        parameters: {
          type: 'object',
          properties: { fact: { type: 'string', description: '要长期记住的一句话事实/偏好' } },
          required: ['fact'],
        },
      },
    },
    execute: async (args, ctx) => {
      const fact = String(args.fact ?? '').trim();
      if (!fact) return 'Error: fact is required';
      const r = await appendMemoryEntry(ctx.userId, fact, { dedup: true });
      if (r.appended) return '已记入长期记忆。';
      if (r.reason === 'duplicate') return '已存在相同记忆，无需重复记录。';
      if (r.reason === 'full') return '长期记忆已接近上限，本条未写入。可提醒用户在账户中心整理记忆。';
      return 'Error: fact is required';
    },
  },

  log_event: {
    definition: {
      type: 'function',
      function: {
        name: 'log_event',
        description:
          '把本次交互中值得留痕的事件/进展追加到用户「今天」的活动日志（按日期归档，用户可在账户中心查看）。' +
          '用于记录已完成的事、得出的结论、产出的文件等；不要记录琐碎闲聊。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '要记入今天日志的一句话事件/进展' } },
          required: ['text'],
        },
      },
    },
    execute: async (args, ctx) => {
      const text = String(args.text ?? '').trim();
      if (!text) return 'Error: text is required';
      const r = await appendLogEntry(ctx.userId, text);
      return `已记入 ${r.date} 日志（${r.time}）。`;
    },
  },

  read_log: {
    definition: {
      type: 'function',
      function: {
        name: 'read_log',
        description: '读取用户某一天的活动日志（markdown）。日期格式 YYYY-MM-DD，缺省读今天。',
        parameters: {
          type: 'object',
          properties: { date: { type: 'string', description: '日期 YYYY-MM-DD，缺省今天' } },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      const date = String(args.date ?? '').trim() || undefined;
      const r = await getLog(ctx.userId, date);
      return r.content?.trim() ? r.content : `（${r.date} 暂无日志）`;
    },
  },

  calculator: {
    definition: {
      type: 'function',
      function: {
        name: 'calculator',
        description: '计算一个算术表达式，支持 + - * / % ( ) 与小数。',
        parameters: {
          type: 'object',
          properties: { expression: { type: 'string', description: '算术表达式，如 (3+4)*2' } },
          required: ['expression'],
        },
      },
    },
    execute: (args) => {
      const expr = String(args.expression ?? '');
      // 只允许数字、运算符、括号、空白、小数点与指数记号，杜绝代码注入。
      if (!/^[0-9+\-*/%(). \t eE]+$/.test(expr)) {
        return 'Error: expression contains invalid characters';
      }
      try {
        // eslint-disable-next-line no-new-func
        const val = Function(`"use strict"; return (${expr});`)();
        return String(val);
      } catch (e: any) {
        return `Error: ${e?.message || 'invalid expression'}`;
      }
    },
  },

  web_search: {
    definition: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '联网搜索，返回相关网页摘要。用于查实时/外部信息。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索关键词' },
            max_results: { type: 'number', description: '返回结果数，默认 5' },
          },
          required: ['query'],
        },
      },
    },
    execute: async (args, ctx) => {
      const r: any = await runSearch(String(args.query ?? ''), Number(args.max_results) || 5);
      // runSearch 返回 { provider, text, results }：落可读 text（而非盲 JSON dump）；超限则落盘+预览。
      const text = typeof r === 'string' ? r : (r?.text || JSON.stringify(r));
      return formatToolOutput(ctx, 'web_search', String(text));
    },
  },

  list_files: {
    mode: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: '列出 agent 工作区某目录下的文件与子目录。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: "目录路径，根为 '/'" } },
          required: [],
        },
      },
    },
    execute: async (args, ctx) => {
      const p = String(args.path ?? '/');
      const dir = await getSessionDir(ctx).catch(() => null);
      return dir ? listFilesLocal(dir, p) : listFiles(ctx.userId, ctx.appId, ctx.sessionId, p);
    },
  },

  read_file: {
    mode: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取 agent 工作区某文件的文本内容。大文件可用 offset/limit 按行分页读取。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，如 /notes/a.txt' },
            offset: { type: 'number', description: '起始行（从 0 计），默认 0' },
            limit: { type: 'number', description: '最多返回的行数（默认读尽，受上限封顶）' },
          },
          required: ['path'],
        },
      },
    },
    execute: async (args, ctx) => {
      const p = String(args.path ?? '');
      const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) >= 0 ? Number(args.offset) : undefined;
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : undefined;
      const dir = await getSessionDir(ctx).catch(() => null);
      return dir
        ? readFileLocal(dir, p, offset, limit)
        : readFile(ctx.userId, ctx.appId, ctx.sessionId, p, offset, limit);
    },
  },

  write_file: {
    mode: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: '在 agent 工作区写入/覆盖一个文本文件（中间目录自动创建）。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '文件路径，如 /out/result.py' },
            content: { type: 'string', description: '文件文本内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    execute: async (args, ctx) => {
      const p = String(args.path ?? '');
      const content = String(args.content ?? '');
      const dir = await getSessionDir(ctx).catch(() => null);
      if (dir) {
        const r = await writeFileLocal(dir, p, content);
        markSessionDirty(ctx); // 标脏 → run 末 snapshot 选择性回写
        return r;
      }
      return writeFile(ctx.userId, ctx.appId, ctx.sessionId, p, content);
    },
  },

  use_skill: {
    definition: {
      type: 'function',
      function: {
        name: 'use_skill',
        description:
          '按需加载某个可用技能的完整说明书（SKILL.md）。当任务匹配 system prompt 列出的某技能时，' +
          '先用它的 id 调用本工具拿到完整指令，再据此执行。',
        parameters: {
          type: 'object',
          properties: { skill_id: { type: 'string', description: '技能 id（见 Available Skills 列表）' } },
          required: ['skill_id'],
        },
      },
    },
    execute: async (args, ctx) => {
      const id = String(args.skill_id ?? '').trim();
      if (!id) return 'Error: skill_id is required';
      if (!ctx.enabledSkillIds || !ctx.enabledSkillIds.includes(id)) {
        return `Skill "${id}" is not available in this session.`;
      }
      const s = await getSkill(id);
      if (!s) return `Skill "${id}" not found.`;
      // 文档类技能：云端 Python 沙箱用精简 python 库速查表替代官方 docx-js/OOXML 长正文（生成量降一个数量级）。
      const cheat = CLOUD_SKILL_CHEATSHEETS.find((c) => c.test.test(String(s.name || '')));
      if (cheat) return `# Skill: ${cheat.title}\n\n${cheat.body}`;
      const body = (s.content && String(s.content).trim()) || (s.description && String(s.description).trim()) || '';
      if (!body) return `Skill "${s.name}" has no instructions.`;
      const head = `# Skill: ${s.name}\n\n`;
      return head + body.slice(0, USE_SKILL_MAX_CHARS) + (body.length > USE_SKILL_MAX_CHARS ? '\n\n…(truncated)' : '');
    },
  },

  pip_install: {
    mode: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'pip_install',
        description:
          '为云端沙箱按需安装缺失的 Python 包（仅二进制 wheel）。装好后 run_python 即可 import；' +
          '常用库（python-docx/openpyxl/python-pptx/reportlab/pandas/numpy/matplotlib/Pillow 等）已预装，无需安装。' +
          '安装是全局缓存的，同一个包只需装一次。',
        parameters: {
          type: 'object',
          properties: {
            packages: {
              type: 'array',
              items: { type: 'string' },
              description: '包名列表，可带版本，如 ["openpyxl", "tqdm==4.66.5"]',
            },
          },
          required: ['packages'],
        },
      },
    },
    execute: async (args, ctx) => {
      const raw = args.packages;
      const pkgs = Array.isArray(raw) ? raw.map((p) => String(p)) : raw ? [String(raw)] : [];
      const res = await installPackages(pkgs, { signal: ctx.signal, runId: ctx.runId });
      let out = '';
      if (res.stdout) out += `${res.stdout}\n`;
      if (res.stderr) out += `${res.stderr}\n`;
      out += `exit_code: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}`;
      if (res.exitCode === 0) out = `安装成功，可在 run_python 中 import。\n` + out;
      return out.trim();
    },
  },

  run_python: {
    mode: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'run_python',
        description:
          '在隔离的云端沙箱里执行 Python 3.12 代码（无网络），返回 stdout/stderr。' +
          '执行前把本会话工作区同步进 /workspace（当前目录），执行后新增/修改的文件自动回写工作区——可直接读写已有文件。' +
          '\n⚠️ 文件只有保存在工作区里才会被保留：用**相对路径**（即当前目录 /workspace，等价 /mnt/data）保存产物。' +
          '不要写到 /tmp、HOME(~/...) 或其他绝对路径——那些目录不会回流，文件会丢失。' +
          '\n沙箱是纯 Python（没有 node / pandoc / libreoffice），生成文档请直接用预装库：' +
          'Word→python-docx，Excel→openpyxl/XlsxWriter，PPT→python-pptx，PDF→reportlab/pypdf/pdfplumber，' +
          '数据→pandas/numpy，绘图→matplotlib，图片→Pillow。' +
          '若 import 报 ModuleNotFoundError，先调用 pip_install 安装缺失的包再重试。',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: '要执行的 Python 代码' } },
          required: ['code'],
        },
      },
    },
    execute: async (args, ctx) => {
      const code = String(args.code ?? '');
      // 会话级持久 kernel：import/变量跨调用保留；工作区已 hydrate 在本地，run 末统一 snapshot。
      const res = await runPythonInSession(ctx, code, { signal: ctx.signal, runId: ctx.runId });
      let out = '';
      if (res.stdout) out += `stdout:\n${res.stdout}\n`;
      if (res.stderr) out += `stderr:\n${res.stderr}\n`;
      out += `exit_code: ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}${res.aborted ? ' (aborted)' : ''}`;
      out = out.trim() || '(no output)';
      // 超大输出（dump 大表/长日志）落盘到工作区，上下文只回预览+路径；exit_code 在末行→预览尾部必含。
      return formatToolOutput(ctx, 'run_python', out);
    },
  },
};

/**
 * 按 ctx.execMode 算出本次可见的内置工具集（参考 hermes_vs_openhanako §3.2/§4.2 的「运行时门禁」）：
 *   - host 模式：隐藏 mode==='sandbox' 的工具（run_python/pip_install/云工作区文件工具），
 *     改挂 HOST_TOOLS（run_bash + 真实 FS read/write/edit/list_dir）。
 *   - 非 host（缺省 sandbox）：原样返回 TOOLS——**与改造前行为完全一致**（HOST_TOOLS 不出现）。
 * 中性工具（mode 缺省=both，如 get_datetime/web_search/use_skill）两模式都在。
 */
function visibleTools(ctx: ToolContext): Record<string, ToolImpl> {
  const host = ctx.execMode === 'host';
  const out: Record<string, ToolImpl> = {};
  for (const [name, t] of Object.entries(TOOLS)) {
    const m = t.mode || 'both';
    if (host && m === 'sandbox') continue;
    if (!host && m === 'host') continue;
    out[name] = t;
  }
  if (host) {
    for (const [name, t] of Object.entries(HOST_TOOLS)) out[name] = t; // host 工具覆盖同名（read_file/write_file/...）
  }
  return out;
}

/** 返回喂给 LLM 的工具定义（OpenAI function 格式）：按模式过滤的内置 + 本 run 的自定义工具（按名去重，内置优先）。 */
export function getToolDefinitions(ctx: ToolContext): Tool[] {
  const hasSkills = !!(ctx.enabledSkillIds && ctx.enabledSkillIds.length);
  const tools = visibleTools(ctx);
  const defs = Object.entries(tools)
    .filter(([name]) => name !== 'use_skill' || hasSkills) // 无启用技能时不暴露 use_skill
    .map(([, t]) => t.definition);
  if (ctx.customTools && ctx.customTools.size) {
    const builtinNames = new Set(Object.keys(tools));
    for (const t of ctx.customTools.values()) {
      if (builtinNames.has(t.name)) continue; // 内置同名优先
      defs.push(t.definition);
    }
  }
  return defs;
}

/** 执行一个工具调用。先查（按模式过滤的）内置，再查本 run 的自定义工具；未知工具返回 isError。 */
export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const name = call.function.name;
  let args: Record<string, any> = {};
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    args = {};
  }

  const impl = visibleTools(ctx)[name];
  if (impl) {
    try {
      const result = await impl.execute(args, ctx);
      return { toolCallId: call.id, name, result: String(result), isError: false };
    } catch (e: any) {
      return { toolCallId: call.id, name, result: `Error: ${e?.message || e}`, isError: true };
    }
  }

  const custom = ctx.customTools?.get(name);
  if (custom) {
    try {
      const result = await executeCustomTool(custom, args, ctx);
      const isError = typeof result === 'string' && result.startsWith('Error:');
      return { toolCallId: call.id, name, result: String(result), isError };
    } catch (e: any) {
      return { toolCallId: call.id, name, result: `Error: ${e?.message || e}`, isError: true };
    }
  }

  return { toolCallId: call.id, name, result: `Tool "${name}" is not available.`, isError: true };
}
