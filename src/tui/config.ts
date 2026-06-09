/**
 * TUI 配置：在 standalone parseConfig 之上叠加 TUI 专属 flag（cwd / 执行形态 / 审批档 / 预算）。
 * 注意：standalone 的 parseConfig 是手写解析器，会把「布尔 flag」误当成「取值 flag」吃掉下一个参数，
 * 故先把布尔 flag（--host-exec/--sandbox-exec）从 argv 滤掉再交给它，TUI flag 这边自己扫一遍。
 */
import path from 'node:path';
import { parseConfig, type StandaloneConfig } from '../standalone/config.js';
import type { ApprovalMode } from './types.js';

export interface TuiConfig extends StandaloneConfig {
  cwd: string;
  execMode: 'host' | 'sandbox';
  approvalMode: ApprovalMode;
  tokenBudget?: number;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
}

const BOOL_FLAGS = new Set(['--host-exec', '--sandbox-exec']);

export function parseTuiConfig(argv: string[]): TuiConfig {
  const base = parseConfig(argv.filter((a) => !BOOL_FLAGS.has(a)));
  const cfg: TuiConfig = {
    ...base,
    cwd: process.cwd(),
    execMode: 'host', // TUI 默认本地直连（codex/hermes 形）；--sandbox-exec 切回云沙箱
    approvalMode: 'auto-edit',
    thinkingLevel: 'off',
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
      if (v === 'readonly' || v === 'auto-edit' || v === 'full-auto') cfg.approvalMode = v;
    } else if (a === '--token-budget' || a.startsWith('--token-budget=')) {
      const n = Number(readVal());
      if (Number.isFinite(n) && n > 0) cfg.tokenBudget = n;
    } else if (a === '--think' || a.startsWith('--think=')) {
      const v = readVal();
      if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') cfg.thinkingLevel = v;
    }
  }
  cfg.cwd = path.resolve(cfg.cwd || process.cwd());
  return cfg;
}

export const TUI_HELP = `Tangu — 本地 agent（成熟 TUI，hermes/codex 形）

用法:
  tangu login [--cloud-url <forsion>]   浏览器登录（codex 式），token 存 ~/.tangu/auth.json
  tangu login <provider>                用 AI 订阅账号登录当 LLM（如 tangu login xai）
  tangu                                 进入 TUI（登录后免参数；进去用 /model 选模型）
  tangu --model <id>                    直接指定模型进入（登录后免 --token / --cloud-url）

options:
  --model <id>          模型 id（Forsion 托管 id 或 <provider>/<model>），env TANGU_MODEL  [可空，进 TUI 后 /model 选，会记住]
  --cwd <path>          工作目录（host-exec 下文件/命令相对此解析），默认当前目录
  --host-exec           本地直连真实文件系统 + shell（默认）
  --sandbox-exec        改用云沙箱 + 云工作区（run_python 等）
  --approval <mode>     审批档：readonly | auto-edit | full-auto（默认 auto-edit）
  --think <level>       思考强度：off | low | medium | high（默认 off；开启后思考内容默认折叠）
  --token-budget <n>    本回合软 token 预算（超出后收尾停止）
  --cloud-url <url>     Forsion 云端（brain API），env TANGU_CLOUD_URL  [登录后可省]
  --token <token>       forsion_token，env TANGU_TOKEN                  [登录后可省]
  --data-dir <path>     嵌入式 PGlite 落盘目录（默认 ~/.tangu/pgdata，'memory'=内存）
  --db <url>            可选：改用外部 Postgres
  --provider* / --providers-file   直连 LLM provider（同 standalone）
  -h, --help            显示帮助

会话内 /help 查看全部命令。
`;
