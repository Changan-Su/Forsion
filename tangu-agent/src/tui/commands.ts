/** Slash 命令元数据（用于 /help 与 Tab 补全）+ 剪贴板 / 文件补全小工具。 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandsFor, canonicalCommandName } from '../core/commandCatalog.js';
import { listCustomCommands } from '../services/customCommands.js';

export interface CommandSpec {
  name: string;
  desc: string;
}

/**
 * TUI 露出的命令。名字/描述来自 core/commandCatalog(与 Desktop 同一张表),
 * 这里只按 surface 过滤 + 拼上参数提示。加命令改 catalog,别改这里。
 */
export const COMMANDS: CommandSpec[] = commandsFor('tui').map((c) => ({
  name: c.name,
  desc: c.arg ? `${c.zh}：${c.name} ${c.arg}` : c.zh,
}));

/**
 * 前缀匹配命令（token 形如 "/mod"）。内置命令在前、用户自定义命令（~/.tangu/commands/*.md）在后。
 * 别名（/effort → /think）也参与匹配，命中后按正名展示。
 */
export function matchCommands(token: string): CommandSpec[] {
  const t = token.toLowerCase();
  const builtin = COMMANDS.filter((c) => c.name.startsWith(t) || canonicalCommandName(t) === c.name);
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
