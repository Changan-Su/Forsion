/** Slash 命令元数据（用于 /help 与 Tab 补全）+ 剪贴板 / 文件补全小工具。 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandsFor, canonicalCommandName } from '../core/commandCatalog.js';
import { listCustomCommands } from '../services/customCommands.js';
import { L } from './i18n.js';

export interface CommandSpec {
  name: string;
  desc: string;
}

// catalog 的参数提示是中文写的(且 catalog 须逐字节同步 desktop,不能在那边改)→ 英文界面在这里换词。
const ARG_WORDS: Array<[RegExp, string]> = [[/序号/g, '#'], [/标题/g, 'title'], [/关注点/g, 'focus'], [/档位/g, 'level'], [/名称/g, 'name'], [/问题/g, 'question'], [/命令/g, 'command']];
function argHint(arg: string): string {
  return L(arg, ARG_WORDS.reduce((s, [re, en]) => s.replace(re, en), arg));
}

// catalog 的参数提示按通道口径写(通道回复是带序号的纯文本列表);TUI 的选择器不显示序号,照抄就是误导。
const TUI_ARG_OVERRIDES: Record<string, string> = { '/model': '[名称|=id]' };

/**
 * TUI 露出的命令。名字/描述来自 core/commandCatalog(与 Desktop 同一张表),
 * 这里只按 surface 过滤 + 拼上参数提示(描述按界面语言取 zh / en)。加命令改 catalog,别改这里。
 * 函数而非模块常量:文案在调用时按当前语言求值,不在 import 时定格(CLAUDE.md 双语规则)。
 */
export function tuiCommands(): CommandSpec[] {
  return commandsFor('tui').map((c) => {
    const desc = L(c.zh, c.en);
    const arg = TUI_ARG_OVERRIDES[c.name] ?? c.arg;
    return { name: c.name, desc: arg ? `${desc}${L('：', ': ')}${c.name} ${argHint(arg)}` : desc };
  });
}

/** /hotkeys 与文档共用的快捷键表(改键先改这里,再同步 docs/reference/cli.md)。 */
export function hotkeyLines(): Array<[string, string]> {
  return [
    ['Enter', L('发送；运行中 = 插话（在下一步注入当前运行）', 'Send; while running = steer (injected into the run at its next step)')],
    ['Alt+Enter', L('换行', 'New line')],
    ['Tab', L('补全 /命令 与 @文件', 'Complete /commands and @files')],
    ['Shift+Tab', L('循环切换思考档（只在当前模型支持的档里转）', 'Cycle the thinking level (only levels the current model supports)')],
    ['Ctrl+P', L('打开模型选择器', 'Open the model picker')],
    ['↑ / ↓', L('翻输入历史（跨会话保存；以空格开头的输入不记）', 'Browse input history (kept across sessions; lines starting with a space are not saved)')],
    ['← / →', L('移动光标', 'Move the cursor')],
    ['Ctrl+A / Ctrl+E', L('跳到行首 / 行尾', 'Jump to line start / end')],
    ['Ctrl+U', L('删除到行首', 'Delete to line start')],
    ['Esc', L('运行中 = 中止；空闲时清空输入', 'While running = abort; when idle clears the input')],
    ['Ctrl+C', L('运行中 = 中止；空闲时退出', 'While running = abort; when idle quits')],
    [L('选择器', 'Pickers'), L('↑↓ 或 Ctrl+N/Ctrl+P 移动 · PgUp/PgDn 翻页 · Enter 选择 · Esc 取消 · 直接打字过滤', '↑↓ or Ctrl+N/Ctrl+P move · PgUp/PgDn page · Enter select · Esc cancel · type to filter')],
    [L('审批弹窗', 'Approval prompt'), L('a 同意 · A 本会话总允许 · e 编辑命令 · n/Esc 拒绝', 'a approve · A always allow this session · e edit the command · n/Esc reject')],
  ];
}

/**
 * 前缀匹配命令（token 形如 "/mod"）。内置命令在前、用户自定义命令（~/.tangu/commands/*.md）在后。
 * 别名（/effort → /think）也参与匹配，命中后按正名展示。
 */
export function matchCommands(token: string): CommandSpec[] {
  const t = token.toLowerCase();
  const builtin = tuiCommands().filter((c) => c.name.startsWith(t) || canonicalCommandName(t) === c.name);
  const custom = listCustomCommands()
    .filter((c) => `/${c.name}`.startsWith(t))
    .map((c) => ({ name: `/${c.name}`, desc: c.argHint ? `${c.description}：/${c.name} ${c.argHint}` : c.description }));
  return [...builtin, ...custom];
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
