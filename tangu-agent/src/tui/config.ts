/**
 * TUI 配置：在 standalone parseConfig 之上叠加 TUI 专属 flag（cwd / 执行形态 / 审批档 / 预算）。
 * 注意：standalone 的 parseConfig 是手写解析器，会把「布尔 flag」误当成「取值 flag」吃掉下一个参数，
 * 故先把布尔 flag（--host-exec/--sandbox-exec）从 argv 滤掉再交给它，TUI flag 这边自己扫一遍。
 */
import path from 'node:path';
import { parseConfig, type StandaloneConfig } from '../standalone/config.js';
import { isThinkingLevel } from '../llm/modelCapabilities.js';
import type { ThinkingLevel } from '../core/types.js';
import type { ApprovalMode } from './types.js';
import { L } from './i18n.js';

export interface TuiConfig extends StandaloneConfig {
  cwd: string;
  execMode: 'host' | 'sandbox';
  approvalMode: ApprovalMode;
  tokenBudget?: number;
  thinkingLevel: ThinkingLevel;
}

const BOOL_FLAGS = new Set(['--host-exec', '--sandbox-exec']);

export function parseTuiConfig(argv: string[]): TuiConfig {
  const base = parseConfig(argv.filter((a) => !BOOL_FLAGS.has(a)));
  const cfg: TuiConfig = {
    ...base,
    cwd: process.cwd(),
    execMode: 'host', // TUI 默认本地直连（codex/hermes 形）；--sandbox-exec 切回云沙箱
    approvalMode: 'auto-edit',
    thinkingLevel: 'medium', // 默认思考·中(与 agentLoop 会话默认一致);--thinking off 可关
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host-exec') {
      cfg.execMode = 'host';
      continue;
    }
    if (a === '--sandbox-exec') {
      cfg.execMode = 'sandbox';
      continue;
    }
    const eq = a.indexOf('=');
    const readVal = (): string => (eq >= 0 ? a.slice(eq + 1) : argv[++i] ?? '');
    if (a === '--cwd' || a.startsWith('--cwd=')) cfg.cwd = readVal();
    else if (a === '--approval' || a.startsWith('--approval=')) {
      const v = readVal();
      if (v === 'readonly' || v === 'auto-edit' || v === 'full-auto' || v === 'custom') cfg.approvalMode = v;
    } else if (a === '--token-budget' || a.startsWith('--token-budget=')) {
      const n = Number(readVal());
      if (Number.isFinite(n) && n > 0) cfg.tokenBudget = n;
    } else if (a === '--think' || a.startsWith('--think=')) {
      const v = readVal();
      if (isThinkingLevel(v)) cfg.thinkingLevel = v;
    }
  }
  cfg.cwd = path.resolve(cfg.cwd || process.cwd());
  return cfg;
}

/**
 * `tangu --help` 的全文,跟随界面语言(同 i18n.ts 的判定:TANGU_LANG → LC_ALL → LC_MESSAGES → LANG → Intl)。
 * 函数而非常量:模块加载时 TANGU_LANG 可能还没从 .env 读进来,调用时再判。两份逐项对齐(单测钉 flag 集合一致)。
 */
export const tuiHelp = (): string =>
  L(
    `Tangu — 本地 agent（成熟 TUI，hermes/codex 形）

用法:
  tangu login [--cloud-url <forsion>]   浏览器登录（codex 式），token 存 ~/.tangu/auth.json
  tangu login <provider>                用 AI 订阅账号登录当 LLM（如 tangu login xai）
  tangu                                 进入 TUI（登录后免参数；进去用 /model 选模型）
  tangu --model <id>                    直接指定模型进入（登录后免 --token / --cloud-url）

选项:
  --model <id>          模型 id（Forsion 托管 id 或 <provider>/<model>），env TANGU_MODEL  [可空，进 TUI 后 /model 选，会记住]
  --cwd <path>          工作目录（host-exec 下文件/命令相对此解析），默认当前目录
  --host-exec           本地直连真实文件系统 + shell（默认）
  --sandbox-exec        改用云沙箱 + 云工作区（run_python 等）
  --approval <mode>     审批档：readonly（询问我批准）| auto-edit（替我批准）| full-auto（完全放行）
                        | custom（自定义：按 config.json 的 approval 规则），默认 auto-edit
  --think <level>       思考强度：off | minimal | low | medium | high | xhigh | max（默认 medium；
                        模型不支持的档位自动降到最近可用档，开启后思考内容默认折叠）
  --token-budget <n>    本回合软 token 预算（超出后收尾停止）
  --cloud-url <url>     Forsion 云端（brain API），env TANGU_CLOUD_URL  [登录后可省]
  --token <token>       forsion_token，env TANGU_TOKEN                  [登录后可省]
  --data-dir <path>     嵌入式 SQLite 落盘文件（默认 ~/.tangu/state.db，'memory'=内存；与 Desktop 共享）
  --db <url>            可选：改用外部 Postgres
  --provider* / --providers-file   直连 LLM provider（同 standalone）
  -h, --help            显示帮助

界面语言跟随系统（LANG 为 zh* 显示中文，其余英文；TANGU_LANG=zh|en 强制指定）。
会话内 /help 查看全部命令，/hotkeys 查看快捷键。
`,
    `Tangu — local agent (full TUI, in the style of hermes/codex)

Usage:
  tangu login [--cloud-url <forsion>]   Sign in in the browser (codex-style); the token is stored in ~/.tangu/auth.json
  tangu login <provider>                Sign in with an AI subscription to use it as the LLM (e.g. tangu login xai)
  tangu                                 Start the TUI (no flags needed once signed in; pick a model with /model)
  tangu --model <id>                    Start with a specific model (no --token / --cloud-url needed once signed in)

Options:
  --model <id>          Model id (a Forsion-hosted id or <provider>/<model>), env TANGU_MODEL  [optional; pick one with /model in the TUI, it is remembered]
  --cwd <path>          Working directory (files and commands resolve against it with host exec); defaults to the current directory
  --host-exec           Work directly on the local file system and shell (default)
  --sandbox-exec        Use the cloud sandbox and cloud workspace instead (run_python, etc.)
  --approval <mode>     Approval mode: readonly (Ask for approval) | auto-edit (Approve for me) | full-auto (Full access)
                        | custom (Custom: the approval rules in config.json); default auto-edit
  --think <level>       Thinking level: off | minimal | low | medium | high | xhigh | max (default medium;
                        levels the model doesn't support fall back to the nearest one; reasoning is folded once done)
  --token-budget <n>    Soft token budget for this turn (wraps up and stops once exceeded)
  --cloud-url <url>     Forsion cloud (brain API), env TANGU_CLOUD_URL  [optional once signed in]
  --token <token>       forsion_token, env TANGU_TOKEN                  [optional once signed in]
  --data-dir <path>     Embedded SQLite file (default ~/.tangu/state.db, 'memory' = in memory; shared with Desktop)
  --db <url>            Optional: use an external Postgres instead
  --provider* / --providers-file   Direct LLM providers (same as standalone)
  -h, --help            Show this help

The interface language follows the system (zh* LANG shows Chinese, anything else English; TANGU_LANG=zh|en forces one).
In a session, /help lists every command and /hotkeys lists the keyboard shortcuts.
`,
  );
