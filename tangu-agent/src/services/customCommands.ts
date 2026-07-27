/**
 * 用户自定义 slash 命令 —— `~/.tangu/commands/*.md`,每个文件即一条 `/<文件名>`。
 *
 * 这是 Tangu 此前完全没有、而 Codex(`~/.codex/prompts/`)/ Claude Code(`.claude/commands/`)/ PI
 * 都有的一类:把常用提示词沉淀成命令,免得每次重打。刻意做成**纯提示词展开**——命令执行 = 把展开后的
 * 文本当普通用户消息发出去,不引入新的执行语义、不碰审批闸门。
 *
 * 文件格式(可选 YAML frontmatter + 正文):
 *   ---
 *   description: 复盘今天的提交
 *   argument-hint: <分支名>
 *   ---
 *   审查 $1 分支上今天的提交,重点看 $ARGUMENTS。
 *
 * 占位符:`$ARGUMENTS` = 整串参数;`$1`..`$9` = 空白分割的第 n 个。都不出现时参数追加到正文末尾
 * (否则 `/cmd 参数` 的参数会被静默吞掉——那是最容易踩的坑)。
 */
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tanguHome } from '../core/tanguHome.js';

export const commandsDir = (): string => path.join(tanguHome(), 'commands');

export interface CustomCommand {
  /** 不含斜杠的命令名(= 文件名去掉 .md,小写)。 */
  name: string;
  description: string;
  argHint?: string;
  /** 展开用的正文(已剥掉 frontmatter)。 */
  body: string;
  file: string;
}

/** 极简 frontmatter 解析:只认 `key: value` 单行,够用且不引 YAML 依赖。 */
export function parseCommandFile(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    meta[line.slice(0, i).trim().toLowerCase()] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

/** 命令名合法性:只收小写字母/数字/连字符,挡住路径穿越与奇怪文件名。 */
function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(name);
}

/**
 * TUI 的 Tab 补全每次按键都调 listCustomCommands —— 不缓存就是「每敲一个字符 readdir + 读全部文件」。
 * 3 秒 TTL:改完 .md 最多 3 秒后生效,对手改文件的场景完全够,又不至于把补全拖慢。
 * ponytail: TTL 缓存足够;真要即时生效再上 fs.watch。
 */
let cache: { at: number; items: CustomCommand[] } | null = null;
const CACHE_TTL_MS = 3000;

/** 丢弃缓存(写入命令文件后调,免得等 TTL)。 */
export function invalidateCustomCommands(): void {
  cache = null;
}

/** 列出全部自定义命令。目录不存在 / 读失败 → 空数组(这是可选功能,绝不能拖垮输入框)。 */
export function listCustomCommands(): CustomCommand[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.items;
  const items = readCustomCommands();
  cache = { at: now, items };
  return items;
}

function readCustomCommands(): CustomCommand[] {
  const dir = commandsDir();
  let files: string[];
  try {
    if (!existsSync(dir)) return [];
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const f of files) {
    const name = f.slice(0, -3).toLowerCase();
    if (!validName(name)) continue;
    try {
      const { meta, body } = parseCommandFile(readFileSync(path.join(dir, f), 'utf8'));
      if (!body) continue;
      out.push({
        name,
        description: meta.description || body.split(/\r?\n/)[0].slice(0, 80),
        argHint: meta['argument-hint'] || meta.arg || undefined,
        body,
        file: path.join(dir, f),
      });
    } catch {
      /* 单个文件坏了不影响其余 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getCustomCommand(name: string): CustomCommand | null {
  const n = name.replace(/^\//, '').toLowerCase();
  return listCustomCommands().find((c) => c.name === n) ?? null;
}

/**
 * 把命令正文展开成要发送的消息。
 * `$ARGUMENTS` / `$1..$9` 全部替换;正文里一个占位符都没有时,参数追加到末尾(而不是丢掉)。
 */
export function expandCustomCommand(cmd: CustomCommand, args: string): string {
  const trimmed = args.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  // `(?!\d)` 而不是 `\b`:`\b` 在 `a$3b` 里不成立(3 与 b 都是词字符)会漏替换,
  // 而这里要挡的只是「$10 别被当成 $1 后面跟个 0」。
  const POSITIONAL = /\$([1-9])(?!\d)/g;
  const hasPlaceholder = /\$ARGUMENTS/.test(cmd.body) || POSITIONAL.test(cmd.body);
  POSITIONAL.lastIndex = 0; // /g 正则的 test 会推进 lastIndex,复用前必须归零
  let out = cmd.body
    .replace(/\$ARGUMENTS/g, trimmed)
    .replace(POSITIONAL, (_, d: string) => parts[Number(d) - 1] ?? '');
  if (!hasPlaceholder && trimmed) out = `${out}\n\n${trimmed}`;
  return out.trim();
}

/** 首启播种一个示例命令(像 skills 那样可见可改);已存在或写失败都静默跳过。 */
export function seedExampleCommand(): void {
  const dir = commandsDir();
  try {
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const sample = `---
description: 复盘一段代码并列出可改进点
argument-hint: <文件或目录>
---
请审查 $ARGUMENTS，按「必须改 / 建议改 / 可以不改」三档列出问题，每条给出理由和最小改法。
`;
  try {
    writeFileSync(path.join(dir, 'review.md'), sample, 'utf8');
  } catch {
    /* best-effort */
  }
}
