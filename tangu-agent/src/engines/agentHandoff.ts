/**
 * 底层第 3 步「交接」:把一个跑在外部引擎上的 Agent(定义里的 engine)交给那个引擎时,Forsion 交过去的东西。
 *
 *  - 工具:这个 Agent 在 Tangu 上能用的那些(按它的工具设置解析),去掉不交的(NOT_HANDED / notHandedReason),
 *    经工具桥(engines/toolServer.ts)交给引擎。审批照这个 Agent 的审批档,卡片由 Forsion 自己画。
 *  - 人设、协作说明、记忆、技能:写进一个「共用指令目录」(AGENTS.md + skills/),经引擎定义的 agentsHomeEnv
 *    交过去(DSH = DSH_AGENTS_HOME;方案目录 evidence/persona-skill.txt 实测进了会话)。
 *
 * 指令目录(prepareAgentsHome)的几条规矩,都是从 DSH 的读法来的(dsh-agent-instructions / dsh-skill-filesystem 的 README 与源码):
 *  - 每场对话一个固定目录:续接时 DSH 会拿当前文件和会话里记的那份对账,路径或内容一变就往会话里补一条「指令变了」。
 *    所以内容只放稳定的东西(人设、常驻记忆、协作说明),不放按这句话召回的记忆、不放时间;内容没变就不重写。
 *  - $DSH_HOME/AGENTS.md(用户自己写给 DSH 的全局指令)和这里的 AGENTS.md 共用一份 65,536 字节的预算,超了先丢更宽的
 *    那份 —— 也就是用户自己的。所以上限按「预算减用户那份」算。
 *  - 换了指令目录,用户自己放在 ~/.agents(或他自己设的 $DSH_AGENTS_HOME)里的东西就不在了:AGENTS.md 只有一个文件名,
 *    用户的内容并进来;skills/ 里的用软链接接进来,和这个 Agent 的技能同名时 Agent 的为准。
 *  - skills/ 里只增删自己建的软链接;真实的文件 / 目录(模型自己写进来的)一律不动。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolDef } from '../tools/toolRegistry.js';
import { isComputerUseTool } from '../tools/toolRegistry.js';
import { tanguHome } from '../core/tanguHome.js';
import { SKILL_TOOL, WAIT_TOOL } from './toolServer.js';

/** 交给引擎的工具桥叫什么(引擎里的工具名是 `mcp__forsion__<工具>`)。 */
export const HANDOFF_SERVER_NAME = 'forsion';

/** 不交的工具和原因。
 *  harness = 引擎自带的(读写文件、跑命令):交过去就是两套打架;loop = 只在 Tangu 自己的循环里有意义;
 *  phone = 手机控制:要手机那端在线配合,交接这条路没验过,先不交;later-run = 会在以后起一轮这个 Agent 自己的 run
 *  (定时、子会话、讨论)—— 那些 run 今天报 agent_engine_elsewhere,排在多 Agent 那一步。
 *  截图类(浏览器、电脑控制、desk_screenshot、view_image、view_video、browser_task)第 2 档起交:图经工具桥回成 MCP image 内容
 *  (toolServer 的 images),DSH 按它选的模型收不收图;跑得久的照旧回取结果的编号。view_image 也交:browser_screenshot 存在
 *  Forsion 自己的目录里(不在引擎的工作区),看它要靠 view_image 把图经桥带回。Computer Use 每次调用先问模型看不看得见。 */
export type NotHandedReason = 'harness' | 'loop' | 'phone' | 'later-run';
export const NOT_HANDED: Readonly<Record<string, NotHandedReason>> = {
  read_file: 'harness', write_file: 'harness', edit_file: 'harness', multi_edit: 'harness', list_dir: 'harness', list_files: 'harness',
  apply_patch: 'harness', move_path: 'harness', copy_path: 'harness', delete_path: 'harness', search_files: 'harness', glob_files: 'harness',
  read_document: 'harness', run_bash: 'harness', run_background: 'harness', list_processes: 'harness', read_process_output: 'harness',
  kill_process: 'harness', write_process_input: 'harness', read_only_code: 'harness', run_python: 'harness', pip_install: 'harness',
  git_status: 'harness', git_commit: 'harness', git_push: 'harness', git_pull: 'harness',
  load_tools: 'loop', use_skill: 'loop', todo_write: 'loop', todo_read: 'loop', exit_plan_mode: 'loop', ask_user: 'loop',
  self_brainstorm: 'loop', read_tool_output: 'loop', manage_harness: 'loop', review_loadout: 'loop', team_say: 'loop',
  session_status: 'loop', session_settings: 'loop', update_session_settings: 'loop',
  manage_automation: 'later-run', manage_schedule: 'later-run', set_next_wake: 'later-run', start_discussion: 'later-run',
  wait_discussion: 'later-run', start_project_session: 'later-run', start_session: 'later-run', hand_off_task: 'later-run',
  send_to_session: 'later-run',
};

export function notHandedReason(t: Pick<ToolDef, 'name'> & { capabilities?: ToolDef['capabilities'] }): NotHandedReason | undefined {
  const r = NOT_HANDED[t.name];
  if (r) return r;
  if (t.name.startsWith('phone_')) return 'phone';
  // 和取结果那个工具同名的(插件 / MCP 工具恰好叫这个)交不过去:桥上这个名字归取结果用
  if (t.name === WAIT_TOOL || t.name === SKILL_TOOL) return 'loop';
  return undefined;
}

/** 这个 Agent 在 Tangu 上能用的工具里,交给引擎的那些(保持解析顺序)。 */
export function handedToolNames(tools: ReadonlyMap<string, ToolDef>): string[] {
  return [...tools.values()].filter((t) => !notHandedReason(t)).map((t) => t.name);
}

// ── 指令文件 ──────────────────────────────────────────────────────────────

/** DSH 给「用户全局」这条链的预算(dsh-base 里 dsh-agent-instructions 的 maxBytes)。 */
export const INSTRUCTIONS_CHAIN_BYTES = 65_536;
/** 留给标题、换行和 DSH 自己包的那几行。 */
const CHAIN_MARGIN_BYTES = 2_048;
/** 自己这份的上限:就算用户那份是空的,也别把整条链吃满。 */
export const INSTRUCTIONS_MAX_BYTES = 48 * 1024;

export interface InstructionSection { key: string; text: string }

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 按 UTF-8 字节截断,不切坏多字节字符。 */
function cutBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (bytes(s.slice(0, mid)) <= max) lo = mid; else hi = mid - 1; }
  return s.slice(0, lo);
}

/**
 * 按顺序拼各段(顺序即优先级),放不下的那一段截断、之后的整段略去,并写明略去了什么。纯函数,只看输入。
 * 返回的文本在输入不变时逐字节相同(续接时 DSH 拿它对账)。
 */
export function renderAgentInstructions(header: string, sections: InstructionSection[], maxBytes: number): { text: string; truncated: string[]; omitted: string[] } {
  const parts: string[] = [header.trim()];
  const truncated: string[] = [];
  const omitted: string[] = [];
  let used = bytes(parts[0]);
  const NOTE_RESERVE = 512;
  let full = false;
  for (const s of sections) {
    const body = s.text.trim();
    if (!body) continue;
    if (full) { omitted.push(s.key); continue; }
    const need = bytes(body) + 2;
    if (used + need <= maxBytes - NOTE_RESERVE) { parts.push(body); used += need; continue; }
    const room = maxBytes - NOTE_RESERVE - used - 2;
    if (room > 1024) {
      const cut = cutBytes(body, room - 80);
      parts.push(`${cut}\n\n[Truncated by Forsion to fit the harness's instruction budget.]`);
      used += bytes(parts[parts.length - 1]) + 2;
      truncated.push(s.key);
    } else omitted.push(s.key);
    full = true;
  }
  if (omitted.length) parts.push(`[Left out by Forsion to fit the harness's instruction budget: ${omitted.join(', ')}.]`);
  return { text: parts.join('\n\n') + '\n', truncated, omitted };
}

/** 用户自己的共用指令根:他设了 $DSH_AGENTS_HOME 就是那里,否则 ~/.agents(与 DSH 的 resolveAgentsHome 同口径)。
 *  在 Forsion 自己的进程里读 —— 交给引擎子进程的那个变量是我们改过的。 */
export function userAgentsHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = typeof env.DSH_AGENTS_HOME === 'string' ? env.DSH_AGENTS_HOME.trim() : '';
  const home = (typeof env.HOME === 'string' && env.HOME.trim()) || os.homedir();
  const raw = set || path.join(home, '.agents');
  return path.resolve(raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw);
}

/** 用户写给 DSH 的全局指令($DSH_HOME/AGENTS.md)占了多少字节;读不到当 0。 */
export function dshHomeInstructionsBytes(env: NodeJS.ProcessEnv = process.env): number {
  const home = (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim()) || path.join((typeof env.HOME === 'string' && env.HOME.trim()) || os.homedir(), '.dsh');
  try { return statSync(path.join(home, 'AGENTS.md')).size; } catch { return 0; }
}

/** 指令文件至少要有这么多字节才交得过去(放得下开头说明、人设和桥的用法);再少就明确失败。 */
export const INSTRUCTIONS_MIN_BYTES = 4_096;

/** 自己这份 AGENTS.md 能用多少字节:整条链的预算减去用户那份,再留余量;封顶 INSTRUCTIONS_MAX_BYTES。
 *  不设下限:超了整条链,DSH 会先丢范围更大的那份 —— 也就是用户自己的 $DSH_HOME/AGENTS.md。不够 INSTRUCTIONS_MIN_BYTES 由调用方报错。 */
export function instructionsBudget(userDshHomeBytes: number): number {
  return Math.min(INSTRUCTIONS_MAX_BYTES, INSTRUCTIONS_CHAIN_BYTES - userDshHomeBytes - CHAIN_MARGIN_BYTES);
}

/** 每场对话一个指令目录(固定路径,续接时 DSH 对账用)。id 是普通的字母数字串(会话 id 是 UUID)就原样用,
 *  否则用整串的哈希 —— 换字符会让不同的 id 撞到同一个目录,`.` / `..` 还会指到上级。 */
export function agentsHomeDir(engineId: string, sessionId: string): string {
  const safe = (s: string): string => (/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s) ? s : `h-${createHash('sha256').update(s).digest('hex').slice(0, 32)}`);
  return path.join(tanguHome(), 'engines', safe(engineId), 'agents', safe(sessionId));
}

export interface SkillLink { name: string; target: string }

/** 链接名:技能 id 的最后一段(`local:foo` → foo),只留安全字符;重名的加序号。 */
export function skillLinkName(id: string, taken: Set<string>): string {
  const last = id.replace(/^local:/, '').split(/[/:]/).filter(Boolean).pop() || 'skill';
  const base = last.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 64) || 'skill';
  let name = base, n = 2;
  while (taken.has(name)) name = `${base}-${n++}`;
  taken.add(name);
  return name;
}

/** 用户共用根下 skills/ 里的技能文件夹(真目录或指向目录的软链接,里面要有 SKILL.md)。 */
export function userSkillDirs(root: string): SkillLink[] {
  const dir = path.join(root, 'skills');
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: SkillLink[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const target = path.join(dir, name);
    try { if (statSync(target).isDirectory() && existsSync(path.join(target, 'SKILL.md'))) out.push({ name, target }); } catch { /* 坏链接跳过 */ }
  }
  return out;
}

/** 记着 Forsion 自己建过哪些链接(名字 → 目标):只增删记在这里、且仍指向记下目标的,别人放进来的链接不动。 */
const LINKS_FILE = '.forsion-links.json';

/**
 * 写指令目录:AGENTS.md(内容变了才重写,原子替换)+ skills/ 软链接(只增删自己建的)。返回目录路径。
 * 软链接在 Windows 上用 junction(不要管理员权限)。
 */
export function writeAgentsHome(dir: string, instructions: string, skills: SkillLink[]): { dir: string; wrote: boolean } {
  mkdirSync(path.join(dir, 'skills'), { recursive: true });
  const file = path.join(dir, 'AGENTS.md');
  let wrote = false;
  let current: string | null = null;
  try { current = readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== instructions) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, instructions, 'utf8');
    renameSync(tmp, file);
    wrote = true;
  }
  const want = new Map(skills.map((s) => [s.name, path.resolve(s.target)]));
  const skillsDir = path.join(dir, 'skills');
  const ledgerFile = path.join(dir, LINKS_FILE);
  // 读不出(坏了)≠ 没建过:那就一个都不删,只补缺的(宁可留一条多余的链接,不删别人的)
  let ledger: Record<string, string> = {}; let ledgerOk = true;
  try { const raw = JSON.parse(readFileSync(ledgerFile, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) ledger = raw; else ledgerOk = false; }
  catch (e: any) { if (e?.code !== 'ENOENT') ledgerOk = false; }
  const owned: Record<string, string> = {};
  for (const name of readdirSync(skillsDir)) {
    const p = path.join(skillsDir, name);
    let link = false;
    try { link = lstatSync(p).isSymbolicLink(); } catch { continue; }
    let target = '';
    if (link) { try { target = path.resolve(skillsDir, readlinkSync(p)); } catch { /* 读不出:不是我们认得的 */ } }
    const ours = link && ledgerOk && typeof ledger[name] === 'string' && path.resolve(ledger[name]) === target;
    if (!ours) { want.delete(name); continue; } // 真文件 / 真目录 / 别人放的链接:不动,也不拿同名链接盖它
    if (want.get(name) === target) { want.delete(name); owned[name] = target; continue; }
    rmSync(p, { force: true });
  }
  for (const [name, target] of want) {
    try { symlinkSync(target, path.join(skillsDir, name), process.platform === 'win32' ? 'junction' : 'dir'); owned[name] = target; }
    catch (e: any) { console.warn(`[engine-handoff] skill link ${name} → ${target} failed:`, e?.message || e); }
  }
  if (ledgerOk) {
    const next = JSON.stringify(owned, null, 2);
    let prev = ''; try { prev = readFileSync(ledgerFile, 'utf8'); } catch { /* 第一次 */ }
    if (prev !== next) { const tmp = `${ledgerFile}.${process.pid}.${Date.now()}.tmp`; writeFileSync(tmp, next, 'utf8'); renameSync(tmp, ledgerFile); }
  }
  return { dir, wrote };
}

/** 交给引擎的工具说明段。引擎拿到的工具名是 `mcp__<桥名>__<工具>`;提示里按原名提到的 Forsion 工具都按这个对应。 */
export function bridgeGuidance(serverName: string, budgetSeconds: number, handed: readonly string[], skillsVia: 'folder' | 'tool' = 'folder'): string {
  const p = `mcp__${serverName}__`;
  return '## Forsion tools\n'
    + `Forsion, the app you are running in, gives you its own tools through an MCP server named "${serverName}". They appear to you as \`${p}<name>\`. `
    + `When these instructions mention a Forsion tool by its plain name (for example remember, log_event, manage_human), use \`${p}<that name>\`.\n`
    + '- Use them for Forsion\'s own data and features: this agent\'s long-term memory and logs, the user\'s notes and calendars, cards and HTML cards in the chat, images, the user\'s Forsion account, and so on. Keep reading and writing files and running commands with your own tools.\n'
    + '- Every Forsion tool call is checked against this agent\'s approval mode in Forsion; the user may have to approve it there.\n'
    + `- A call that takes longer than about ${budgetSeconds} seconds (waiting for the user's approval, or a long job such as delegating or making an image) answers with a pending ticket. `
    + `Then call \`${p}${WAIT_TOOL}\` with the exact arguments it gives, again until the result arrives. Never repeat the original call, and never end your turn while a ticket is pending.\n`
    + '- Some Forsion tools return screenshots or other images (browser and computer control, desk_screenshot, view_video). '
    + 'If such an image reaches you only as a note that it is unavailable, the model you are running on cannot see images: do not click or type based on a screen you cannot see; tell the user they need a model that can see images for this. '
    + 'To look at an image file (for example one browser_screenshot saved), use view_image.\n'
    + '- Not available in this harness yet: phone control, scheduling and automations, and Tangu\'s own loop tools (its todo list, plan mode, load_tools, use_skill). '
    + (skillsVia === 'tool' ? `Load your skills with \`${p}${SKILL_TOOL}\` instead (they are listed under "Your skills").` : 'Your skills are in your skills folder instead.')
    + (handed.length ? '' : '\n- No Forsion tools are enabled for this agent right now.');
}
