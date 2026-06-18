/** Slash 命令元数据（用于 /help 与 Tab 补全）+ 剪贴板 / 文件补全小工具。 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export interface CommandSpec {
  name: string;
  desc: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: '/help', desc: '显示帮助与命令列表' },
  { name: '/new', desc: '开始新会话' },
  { name: '/clear', desc: '清屏（保留会话历史）' },
  { name: '/model', desc: '切换模型：/model <id>' },
  { name: '/sessions', desc: '列出最近会话' },
  { name: '/resume', desc: '恢复会话并续聊：/resume <id|序号>' },
  { name: '/approval', desc: '切换审批档：/approval readonly|auto-edit|full-auto' },
  { name: '/think', desc: '思考强度：/think off|low|medium|high（思考内容默认折叠）' },
  { name: '/loop', desc: '最大循环轮数：/loop <1-200>（默认 90；耗尽会提示）' },
  { name: '/plan', desc: '切换计划模式：只读调研 → exit_plan_mode 提交计划求批准' },
  { name: '/cwd', desc: '查看或切换工作目录：/cwd [path]' },
  { name: '/tools', desc: '列出当前模式可用工具' },
  { name: '/skills', desc: '列出可用技能（含本地/.claude;✓=本会话启用）' },
  { name: '/skill', desc: '启用/停用技能：/skill <id>' },
  { name: '/agents', desc: '列出本地 Normal Agent（自定义人格）' },
  { name: '/agent', desc: '启用某 Normal Agent：/agent <slug>（/agent off 取消）' },
  { name: '/historian', desc: 'Historian 状态/活动；/historian on|off 开关' },
  { name: '/muse', desc: 'Muse 状态/TODO；/muse on|off 开关' },
  { name: '/memory', desc: '查看长期记忆' },
  { name: '/cost', desc: '本会话 token 用量与费用' },
  { name: '/copy', desc: '复制上一条回复到剪贴板' },
  { name: '/retry', desc: '重跑上一条用户消息' },
  { name: '/config', desc: '查看当前设置' },
  { name: '/login', desc: '重新登录 Forsion（提示重启生效）' },
  { name: '/compact', desc: '压缩上下文：总结后精简续接（同会话）' },
  { name: '/exit', desc: '退出 Tangu' },
];

/** 前缀匹配命令（token 形如 "/mod"）。 */
export function matchCommands(token: string): CommandSpec[] {
  const t = token.toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(t));
}

/**
 * 文件路径补全：partial 是 @ 后面的部分（相对 cwd）。返回候选相对路径（目录带尾随 /）。
 * 用于 @file 提及补全。读目录失败返回空。
 */
export function completeFilePath(cwd: string, partial: string): string[] {
  const slash = partial.lastIndexOf('/');
  const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const namePart = slash >= 0 ? partial.slice(slash + 1) : partial;
  const absDir = path.resolve(cwd, dirPart || '.');
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.') && !namePart.startsWith('.')) continue; // 默认不列点文件
    if (!name.toLowerCase().startsWith(namePart.toLowerCase())) continue;
    let isDir = false;
    try {
      isDir = statSync(path.join(absDir, name)).isDirectory();
    } catch {
      /* ignore */
    }
    out.push(dirPart + name + (isDir ? '/' : ''));
    if (out.length >= 20) break;
  }
  return out.sort();
}

/** 用 OSC52 把文本写进系统剪贴板（多数现代终端支持，零依赖）。 */
export function copyToClipboardOSC52(text: string): void {
  const b64 = Buffer.from(text, 'utf-8').toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}
