/** 从其他 AI 导入(11-03):读这台电脑上别家 Agent 留下的记忆、偏好和技能。只读,不改它们的任何文件。
 *  方案页 docs/ToBeImproved/从其他AI导入记忆与技能方案_2026-11-03。
 *  记忆和偏好切成「片段」交给整理(plan.ts);技能只按文件列,不经模型。网页上的 AI 是用户贴进来的那段,也算一个片段。
 *  TANGU_IMPORT_HOME 给台架 / 测试用:设了就只认它,不再看 CLAUDE_CONFIG_DIR / CODEX_HOME(免得读到真家目录)。 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeMemoryFact } from '../memoryRepository.js';
import { parseFrontmatter } from '../../skills/localSkills.js';

export const IMPORT_TOOLS = ['claude-code', 'codex', 'gemini-cli', 'hermes', 'cursor', 'windsurf'] as const;
export type ImportTool = typeof IMPORT_TOOLS[number] | 'pasted';
export const isImportTool = (v: unknown): v is typeof IMPORT_TOOLS[number] => typeof v === 'string' && (IMPORT_TOOLS as readonly string[]).includes(v);
/** about = 写的是这个人;rules = 人写给 AI 的规矩;project = 某个项目里的;notes = AI 自己的笔记(什么都可能有);mixed = 贴进来的,不知道 */
export type SnippetHint = 'about' | 'rules' | 'project' | 'notes' | 'mixed';
export interface Snippet { fp: string; tool: ImportTool; hint: SnippetHint; text: string; path: string; project?: string }
export interface ImportNotice { tool: ImportTool; kind: 'too-many' | 'persona' | 'truncated'; path: string; count?: number; project?: string }
export interface ExternalSkill { key: string; tool: typeof IMPORT_TOOLS[number]; name: string; description: string; dir: string; files: number; scripts: number; mentionsOther: boolean }
export interface SourceScan { snippets: Snippet[]; skills: ExternalSkill[]; notices: ImportNotice[] }

export const SNIPPET_MAX = 8000;
export const PASTE_MAX = 64 * 1024;
/** 一个项目的记忆文件多过这个数就不逐条拆(本机 Forsion 项目的 Claude Code 记忆有 649 个);第二期改成挂只读资料。 */
export const PROJECT_FILES_MAX = 40;
const SKILL_FILES_MAX = 2000;

const fp = (...parts: string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
const read = (file: string): string | null => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
// 指向目录的软链也算(技能常是软链装进来的)
const isDirEntry = (dir: string, e: Dirent): boolean => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return statSync(join(dir, e.name)).isDirectory(); } catch { return false; } })());
const dirs = (dir: string): string[] => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.') && isDirEntry(dir, e)).map((e) => e.name); } catch { return []; } };
const files = (dir: string, re: RegExp): string[] => { try { return readdirSync(dir).filter((n) => re.test(n)); } catch { return []; } };
const clip = (s: string): string => s.trim().slice(0, SNIPPET_MAX);

function snippet(tool: ImportTool, hint: SnippetHint, path: string, text: string, project?: string): Snippet | null {
  const t = clip(text);
  return t ? { fp: fp(tool, path, normalizeMemoryFact(t)), tool, hint, text: t, path, ...(project ? { project } : {}) } : null;
}

export function importHomes(env = process.env): Record<'home' | 'claude' | 'codex', string> {
  const fixed = env.TANGU_IMPORT_HOME?.trim();
  const home = fixed || homedir();
  return { home, claude: (!fixed && env.CLAUDE_CONFIG_DIR?.trim()) || join(home, '.claude'), codex: (!fixed && env.CODEX_HOME?.trim()) || join(home, '.codex') };
}

/** Claude Code 的项目目录名是路径编码过的(不可逆),真实工作目录取会话记录里的 cwd。 */
function claudeProjectCwd(projectDir: string): string | undefined {
  const logs = files(projectDir, /\.jsonl$/).map((n) => join(projectDir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of logs.slice(0, 3)) {
    const head = (read(file) ?? '').slice(0, 64 * 1024);
    const m = head.match(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (m) try { return JSON.parse(m[1]); } catch { /* 下一份 */ }
  }
  return undefined;
}

function scanClaude(root: string, out: SourceScan): void {
  const rules = read(join(root, 'CLAUDE.md'));
  if (rules) push(out, snippet('claude-code', 'rules', join(root, 'CLAUDE.md'), rules));
  const projects = join(root, 'projects');
  for (const key of dirs(projects)) {
    const memDir = join(projects, key, 'memory');
    const notes = files(memDir, /\.md$/).filter((n) => n !== 'MEMORY.md'); // MEMORY.md 只是索引
    if (!notes.length) continue;
    const cwd = claudeProjectCwd(join(projects, key));
    if (notes.length > PROJECT_FILES_MAX) { out.notices.push({ tool: 'claude-code', kind: 'too-many', path: memDir, count: notes.length, ...(cwd ? { project: cwd } : {}) }); continue; }
    for (const name of notes) {
      const raw = read(join(memDir, name)); if (!raw) continue;
      const { meta, body } = parseFrontmatter(raw);
      // 新版把 type 放在 metadata: 下面(parseFrontmatter 跳过嵌套),两种都认
      const type = (meta.type || raw.match(/^---[\s\S]*?^\s+type:\s*(\w+)/m)?.[1] || '').toLowerCase();
      const text = body.trim() || meta.description || '';
      // 关于这个人的,在哪个项目里记的都一样;其余三类(feedback / project / reference)只在那个项目成立,找不到路径就不导
      if (type === 'user') push(out, snippet('claude-code', 'about', join(memDir, name), text));
      else if (cwd) push(out, snippet('claude-code', 'project', join(memDir, name), text, cwd));
    }
  }
}

function scanCodex(root: string, out: SourceScan): void {
  const rules = read(join(root, 'AGENTS.md'));
  if (rules) push(out, snippet('codex', 'rules', join(root, 'AGENTS.md'), rules));
  const memFile = join(root, 'memories', 'MEMORY.md');
  const mem = read(memFile);
  if (!mem) return;
  // 一组 = 一个「# 标题」块;applies_to: cwd=… 的那组只在那个项目成立
  for (const block of mem.split(/^(?=# )/m)) {
    const cwd = block.match(/applies_to:\s*cwd=([^;\s]+)/)?.[1];
    push(out, snippet('codex', cwd ? 'project' : 'notes', memFile, block, cwd));
  }
}

function scanGemini(home: string, out: SourceScan): void {
  const file = join(home, '.gemini', 'GEMINI.md');
  const raw = read(file); if (!raw) return;
  // save_memory 往「## Gemini Added Memories」那一节追加;其余是人写的规矩
  const m = raw.match(/^##\s+Gemini Added Memories\s*$([\s\S]*?)(?=^#{1,2}\s|(?![\s\S]))/m);
  if (m) push(out, snippet('gemini-cli', 'about', file, m[1]));
  push(out, snippet('gemini-cli', 'rules', file, m ? raw.replace(m[0], '') : raw));
}

function scanHermes(home: string, out: SourceScan): void {
  const dir = join(home, '.hermes', 'memories');
  for (const [name, hint] of [['USER.md', 'about'], ['MEMORY.md', 'notes']] as const) {
    for (const entry of (read(join(dir, name)) ?? '').split(/\n§\n/)) push(out, snippet('hermes', hint, join(dir, name), entry));
  }
  const soul = join(home, '.hermes', 'SOUL.md');
  if (read(soul)?.trim()) out.notices.push({ tool: 'hermes', kind: 'persona', path: soul }); // 人设 → 第二期新建 Agent
}

function push(out: SourceScan, s: Snippet | null): void {
  if (s && !out.snippets.some((x) => x.fp === s.fp)) out.snippets.push(s);
}

// ── 技能 ──
const SKILL_ROOTS = (h: ReturnType<typeof importHomes>): Array<[typeof IMPORT_TOOLS[number], string]> => [
  ['claude-code', join(h.claude, 'skills')], ['codex', join(h.codex, 'skills')], ['gemini-cli', join(h.home, '.gemini', 'skills')],
  ['hermes', join(h.home, '.hermes', 'skills')], ['cursor', join(h.home, '.cursor', 'skills')], ['windsurf', join(h.home, '.codeium', 'windsurf', 'skills')],
];
/** 正文里点名了别家才有的工具 / 路径:导进来可能要改(正文不动,只提醒)。 */
const OTHER_AGENT = /\b(?:Task|AskUserQuestion|TodoWrite|TodoRead|ExitPlanMode|NotebookEdit|SlashCommand)\(|\bmcp__\w+|~\/\.(?:claude|codex|gemini|hermes|cursor)\/|\$\{?CLAUDE_|CLAUDE_PLUGIN_ROOT/;
const SCRIPT = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd)$/i;

function countFiles(dir: string): { files: number; scripts: number } {
  let filesN = 0, scripts = 0;
  const walk = (d: string): void => {
    let list; try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (filesN > SKILL_FILES_MAX) return;
      if (e.isDirectory()) walk(join(d, e.name));
      else { filesN++; if (SCRIPT.test(e.name)) scripts++; }
    }
  };
  walk(dir);
  return { files: filesN, scripts };
}

function skillAt(tool: typeof IMPORT_TOOLS[number], dir: string, name: string): ExternalSkill | null {
  const raw = read(join(dir, 'SKILL.md')); if (raw === null) return null;
  const { meta } = parseFrontmatter(raw);
  return { key: `${tool}:${name}`, tool, name, description: (meta.description || '').replace(/\s+/g, ' ').slice(0, 300), dir, ...countFiles(dir), mentionsOther: OTHER_AGENT.test(raw) };
}

function scanSkills(h: ReturnType<typeof importHomes>, only: ReadonlySet<string>): ExternalSkill[] {
  const out: ExternalSkill[] = [];
  for (const [tool, root] of SKILL_ROOTS(h)) {
    if (!only.has(tool)) continue;
    for (const name of dirs(root)) {
      const s = skillAt(tool, join(root, name), name);
      if (s) { out.push(s); continue; }
      if (tool === 'hermes') for (const inner of dirs(join(root, name))) { const x = skillAt(tool, join(root, name, inner), inner); if (x) out.push(x); } // <分类>/<名>
    }
  }
  return out;
}

export function scanSources(tools: ReadonlySet<string> = new Set(IMPORT_TOOLS), env = process.env): SourceScan {
  const h = importHomes(env);
  const out: SourceScan = { snippets: [], skills: [], notices: [] };
  if (tools.has('claude-code')) scanClaude(h.claude, out);
  if (tools.has('codex')) scanCodex(h.codex, out);
  if (tools.has('gemini-cli')) scanGemini(h.home, out);
  if (tools.has('hermes')) scanHermes(h.home, out);
  out.skills = scanSkills(h, tools);
  return out;
}

/** 贴进来的那段:超过 64 KB 只要完整的行,其余在单上说。 */
export function pastedSnippets(text: unknown, notices: ImportNotice[]): Snippet[] {
  if (typeof text !== 'string' || !text.trim()) return [];
  let t = text.replace(/\r\n/g, '\n');
  if (t.length > PASTE_MAX) { t = t.slice(0, Math.max(0, t.lastIndexOf('\n', PASTE_MAX))); notices.push({ tool: 'pasted', kind: 'truncated', path: '' }); }
  // 按行切成不超过 SNIPPET_MAX 的几块,每块一个片段(一行本身超长的硬切)
  const parts: string[] = []; let cur = '';
  for (const line of t.split('\n').flatMap((l) => l.match(new RegExp(`[\\s\\S]{1,${SNIPPET_MAX - 1}}`, 'g')) ?? [''])) {
    if (cur && cur.length + line.length + 1 > SNIPPET_MAX) { parts.push(cur); cur = ''; }
    cur += `${line}\n`;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p, i) => snippet('pasted', 'mixed', `pasted#${i + 1}`, p)).filter((s): s is Snippet => !!s);
}

export const skillFingerprint = (s: ExternalSkill): string => fp(s.key, String(statSafe(join(s.dir, 'SKILL.md'))));
const statSafe = (f: string): number => { try { return statSync(f).mtimeMs; } catch { return 0; } };
export const hasSkillMd = (dir: string): boolean => existsSync(join(dir, 'SKILL.md'));
