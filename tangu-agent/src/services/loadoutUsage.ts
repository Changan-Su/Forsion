/**
 * 装备用量巡检(10-04,用户定「这部分工作交给 Muse」):最近 N 天里每个 agent 的**常驻**工具各被调了几次、
 * 目录里的技能各被装载了几次 —— 找出「一直挂着、却没人用」的那些,供 agent 自己收起(manage_harness kind:"equip")。
 * 只出报告,什么都不改。
 *
 * 数据源 = agent_run_events 的 tool_call 行(每次调用一行、发布在执行之前:被拒 / 挂起的也在 ——
 * 「模型伸手去拿过」正是收不收的判据),按 run → 会话归到 agent:run 入参里的 agentSlug → 会话存档的 agentSlug → 默认 agent。
 * 只数用户会话(chat_sessions.kind = 'user'):Muse / 自动化 / 委派 / 团队的 run 工具面不同,混进来会把「常驻却没用」算错。
 * 同理只数**本机 work 工具面**的 run(execMode = host,预设不是轻聊天 / Coding,不是群聊主 run):别的工具面里那些工具压根没露过面,
 * 「没调过」不是证据(Codex 10-04:20 次云端轻聊天会把 run_bash 报成「常驻却没用」)。报告里的常驻清单也是按这个工具面合成的。
 * 子代理(delegate)的调用记在父 run 的 subagent 事件里、用的是子代理自己的工具面,不计。
 *
 * ponytail: 两次全表扫 type='tool_call' + created_at 窗口(这张表只有 run_id 一个索引)。本机库到几十万行仍是秒级;
 * 真慢了再加 (type, created_at) 索引或落一张按天汇总表。
 */
import { getDbType, query } from '../core/db.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { deps } from '../seams/runtime.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { getAgent, MUSE_AGENT_SLUG } from '../agents/agentRegistry.js';
import { loadHarness, shelvedOf, equipHistory } from '../agents/harnessStore.js';
import { getToolDefinitions } from '../tools/registry.js';
import { isShelvable } from '../tools/toolRegistry.js';
import type { ToolContext } from '../tools/toolTypes.js';
import { loadSkillLoadout } from './skillLoadout.js';
import { L } from '../tui/i18n.js';

export interface UsageCount { calls: number; last: string }
export interface AgentUsage { runs: number; tools: Map<string, UsageCount>; skills: Map<string, UsageCount> }

/** 少于这么多次 run 的 agent 不下结论:样本太小,「没用过」多半只是「还没轮到」。 */
export const MIN_RUNS = 20;
const MAX_AGENTS = 8;
const MAX_NAMES = 40;
const OUTPUT_CAP = 12_000;
/** 一次巡检每个 agent 最多建议收几个工具 / 几个技能:一次收太多,出了问题分不清是哪一个;剩下的下周还会再列。
 *  上限由报告自己执行(超出的**不列名字**),不靠提示里一句「最多 8 个」—— 10-04 grok 当 Muse 时把 28 个工具
 *  (含 write_file / edit_file)和全部 21 个技能都抄进了建议,接手的 agent 照单全收。 */
export const SUGGEST_MAX = 8;
/** 定义小于这么多字节的工具不建议收:收起后目录里还要留一行(约 100 字节),省不下什么,用到时却多一个来回。 */
const MIN_SHELVE_BYTES = 512;

/** TODO 里的「执行步骤」段:由报告给出、Muse 原样带上。10-04 live 两次实翻都在这一段 ——
 *  Muse 自己写步骤时,一次把「本周期别动」抄了进去(接手的 agent 读完什么都不做),一次只写了「给别的 agent 提名」那一支
 *  (接手的正是被点名的 agent,于是给自己提了名、没收起)。两条分支缺一不可,所以不交给模型现写。 */
export const LOADOUT_APPLY_STEPS =
  'Steps for whoever runs this task: (1) if one of the agents listed above is you, shelve your own items now with manage_harness (action "upsert", kind "equip", exactly the tools and skills listed for you and nothing else, evidence = the counts above); ' +
  '(2) for every other agent listed, call manage_harness with action "propose", agent = its slug, tools and skills = exactly its listed items, evidence = its counts. When Muse runs this task those items are shelved for that agent right away (it can undo them in its notes); when another agent runs it, the suggestion waits in that agent\'s inbox for its next /refine. ' +
  'Shelving only moves a definition to the load-on-demand catalog; nothing is removed.';
/** 同一段的中文版:这段话最后落在用户收件箱的卡片上(用户可见产物 → 跟界面语言,同条目名的 L());
 *  工具名 / 参数名不译。10-04 真实用量跑里 Muse 自己翻译时把「收起 / 装备」译成了「暂存 / 设备」。 */
export const LOADOUT_APPLY_STEPS_ZH =
  '执行步骤:(1) 上面列出的 agent 里如果有你自己,现在就用 manage_harness 把你名下的收起(action "upsert"、kind "equip",tools 和 skills 只填你名下列出的那几项,evidence 写上面的次数);' +
  '(2) 其余每个被列出的 agent,用 manage_harness 的 action "propose"(agent = 它的 slug,tools 和 skills 只填它名下列出的那几项,evidence 写它的次数)。由 Muse 执行时,这几项会直接替它收起(它可以在自己的工作笔记里撤销);由别的 agent 执行时,只给它留一条候选,等它下次复盘(/refine)时自己决定。' +
  '收起只是把定义挪进按需目录,需要时照常可用,不会删除任何东西。';

/** Muse 代收的节奏:六天内算同一周(巡检每周一次,留一天余量)。 */
const WEEK_MS = 6 * 86_400_000;

/** 'YYYY-MM-DD HH:MM:SS'(UTC)—— 与 SQLite 的 CURRENT_TIMESTAMP 同格式,两种方言都能按它比(同 museTodo 的窗口算法)。 */
const cutoffOf = (days: number, now = Date.now()): string => new Date(now - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

/** 最近 days 天、该用户的用户会话里:每个 agent 跑了几次、各工具被调几次、各技能被装载几次。 */
export async function collectLoadoutUsage(userId: string, days: number, now = Date.now()): Promise<Map<string, AgentUsage>> {
  const sqlite = getDbType() === 'sqlite';
  // 取 JSON 列里的一个字段成文本。SQLite 对坏 JSON 的 json_extract 会抛错 → json_valid 先挡;PG 这几列本就是 JSONB。
  const field = (col: string, ...keys: string[]): string => sqlite
    ? `CASE WHEN json_valid(${col}) THEN json_extract(${col}, '$.${keys.join('.')}') END`
    : `${col}${keys.slice(0, -1).map((k) => `->'${k}'`).join('')}->>'${keys.at(-1)}'`;
  // 归属:run 入参里的 agentSlug → 会话存档的 → 默认 agent(占位符)
  const slug = `COALESCE(NULLIF(${field('r.input', 'agentConfig', 'agentSlug')}, ''), NULLIF(${field('s.agent_config', 'agentSlug')}, ''), ?)`;
  const name = field('e.payload', 'name');
  const args = field('e.payload', 'arguments');
  // run 入参优先(那一刻生效的值),没写再看会话存档;两处都没有 execMode 的 run 不算(引擎会把它当沙箱跑)
  const execMode = `COALESCE(NULLIF(${field('r.input', 'agentConfig', 'execMode')}, ''), NULLIF(${field('s.agent_config', 'execMode')}, ''), '')`;
  // 预设是会话事实(落在会话存档里),run 入参只在存档还没有时兜底
  const preset = `COALESCE(NULLIF(${field('s.agent_config', 'preset')}, ''), NULLIF(${field('r.input', 'agentConfig', 'preset')}, ''), 'work')`;
  // JSON 布尔:SQLite 取出来是 1 / 0,PG 的 ->> 是 'true' / 'false'
  const notGroup = (col: string, ...keys: string[]): string => `COALESCE(CAST(${field(col, ...keys)} AS TEXT), '') NOT IN ('1', 'true')`;
  const scope = `r.user_id = ? AND COALESCE(s.kind, 'user') = 'user' AND ${execMode} = 'host' AND ${preset} NOT IN ('chat', 'coding')`
    + ` AND ${notGroup('r.input', 'agentConfig', 'groupChat')} AND ${notGroup('s.agent_config', 'groupChat')}`;
  const events = `FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id JOIN chat_sessions s ON s.id = r.session_id
    WHERE e.type = 'tool_call' AND ${scope} AND e.created_at >= ?`;
  const cutoff = cutoffOf(days, now);
  const base = [DEFAULT_AGENT_SLUG, userId, cutoff];

  const out = new Map<string, AgentUsage>();
  const of = (s: unknown): AgentUsage => {
    const key = String(s || DEFAULT_AGENT_SLUG);
    let u = out.get(key);
    if (!u) out.set(key, (u = { runs: 0, tools: new Map(), skills: new Map() }));
    return u;
  };
  const runs = await query<any[]>(
    `SELECT ${slug} AS slug, COUNT(*) AS n FROM agent_runs r JOIN chat_sessions s ON s.id = r.session_id WHERE ${scope} AND r.created_at >= ? GROUP BY 1`, base);
  for (const r of runs || []) of(r.slug).runs = Number(r.n) || 0;
  const tools = await query<any[]>(`SELECT ${slug} AS slug, ${name} AS name, COUNT(*) AS n, MAX(e.created_at) AS last ${events} GROUP BY 1, 2`, base);
  for (const r of tools || []) if (r.name) of(r.slug).tools.set(String(r.name), { calls: Number(r.n) || 0, last: tsText(r.last) });
  // 技能 id 在 arguments(JSON 串里的 JSON 串)里:只取 use_skill 那几行,到 JS 里拆
  const loads = await query<any[]>(`SELECT ${slug} AS slug, ${args} AS args, e.created_at AS at ${events} AND ${name} = 'use_skill'`, base);
  for (const r of loads || []) {
    let id = '';
    try { id = String(JSON.parse(String(r.args || '{}'))?.skill_id || ''); } catch { /* 坏参数的调用不算装载 */ }
    if (!id) continue;
    const m = of(r.slug).skills;
    const cur = m.get(id) ?? { calls: 0, last: '' };
    const at = tsText(r.at);
    m.set(id, { calls: cur.calls + 1, last: at > cur.last ? at : cur.last });
  }
  return out;
}

/** PG 的时间列回来是 Date,SQLite 是 'YYYY-MM-DD HH:MM:SS' 文本:统一成后者的形状再比 / 再截日期。 */
const tsText = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : String(v || ''));
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const day = (ts: string): string => ts.slice(0, 10);
const cut = (list: string[]): string => (list.length > MAX_NAMES ? `${list.slice(0, MAX_NAMES).join(', ')}, … (+${list.length - MAX_NAMES} more)` : list.join(', '));

/** 一个 agent 在「普通本机会话」里常驻的工具(每次请求都带完整定义的那些)及各自定义的字节数。
 *  不带 muse / automation 旗标(那两种 run 全量可见),也不带它自己已收起的 —— 已收起的另列。
 *  仅 GUI 客户端才有的工具(界面命令、画图卡片等)不在这个合成工具面里:它们的门禁要发起端能力,这里没有。 */
async function residentTools(ctx: ToolContext, slug: string, def: { toolsMode?: 'allow' | 'deny'; toolsList?: string[] }, skillIds: string[]): Promise<Array<{ name: string; bytes: number }>> {
  const face = {
    userId: ctx.userId, sessionId: '', appId: ctx.appId, execMode: 'host' as const, profile: ctx.profile ?? deps().profile,
    agentSlug: slug, toolsMode: def.toolsMode, toolsList: def.toolsList, enabledSkillIds: skillIds, unlockTools: () => {},
  };
  return getToolDefinitions(face as ToolContext).map((t) => ({ name: t.function.name, bytes: Buffer.byteLength(JSON.stringify(t)) }));
}

/** 一个 agent 这次建议收起什么。名单在这里定死(没调过的里挑定义最大的几个,太小的不值得收,各封顶 SUGGEST_MAX):
 *  报告照它写,Muse 代为收起时也只认它 —— 没进这份名单的名字,谁也建议不了、收不了。 */
async function pickLoadout(ctx: ToolContext, slug: string, def: { toolsMode?: 'allow' | 'deny'; toolsList?: string[]; enabledSkillIds?: string[] }, u: AgentUsage) {
  const shelved = shelvedOf(await loadHarness(slug).catch(() => []));
  const skills = await runWithAgentSlug(slug, () => loadSkillLoadout(ctx.userId, ctx.appId, {
    execMode: 'host', enabledSkillIds: def.enabledSkillIds, skillsConfigured: Array.isArray(def.enabledSkillIds),
  }), slug).catch(() => null);
  const resident = (await residentTools(ctx, slug, def, skills?.enabledSkillIds ?? [])).filter((t) => !shelved.tools.has(t.name));
  const calls = (n: string): number => u.tools.get(n)?.calls ?? 0;
  const open = resident.filter((t) => isShelvable(t.name));
  const never = open.filter((t) => calls(t.name) === 0).sort((a, b) => b.bytes - a.bytes);
  const rare = open.filter((t) => calls(t.name) > 0 && calls(t.name) <= 2).sort((a, b) => b.bytes - a.bytes);
  const used = open.filter((t) => calls(t.name) > 2).sort((a, b) => calls(b.name) - calls(a.name));
  const total = resident.reduce((n, t) => n + t.bytes, 0);
  // 对方拿回来过的不再建议;Muse 这一周已经代收的算进本周的量(SUGGEST_MAX 是一周一批的量,不是一次调用的量)。
  const hist = await equipHistory(slug, WEEK_MS).catch(() => ({ restored: { tools: new Set<string>(), skills: new Set<string>() }, museRecent: { tools: 0, skills: 0 } }));
  const pick = never.filter((t) => t.bytes >= MIN_SHELVE_BYTES && !hist.restored.tools.has(t.name)).slice(0, Math.max(0, SUGGEST_MAX - hist.museRecent.tools));
  const listedSkills = (skills?.catalog ?? []).filter((s) => !shelved.skills.has(s.id));
  const idleSkills = listedSkills.filter((s) => !u.skills.has(s.id)).sort((a, b) => b.bytes - a.bytes);
  const pickSkills = idleSkills.filter((s) => !hist.restored.skills.has(s.id)).slice(0, Math.max(0, SUGGEST_MAX - hist.museRecent.skills));
  return { shelved, skills, resident, calls, never, rare, used, total, pick, pickSkills, listedSkills, idleSkills };
}

/** 此刻对这个 agent 的建议(名字清单 + 依据)。数据不够(少于 MIN_RUNS 次)或 agent 不存在 → null。
 *  Muse 在用户点了「交给 Muse」之后代为收起时用它把关:请求的名字只留下这里也有的。 */
export async function suggestedLoadout(ctx: ToolContext, slug: string, days = 30): Promise<{ runs: number; days: number; tools: string[]; skills: string[] } | null> {
  const span = Math.min(Math.max(7, Math.floor(Number(days) || 30)), 90);
  const u = (await collectLoadoutUsage(ctx.userId, span)).get(slug);
  const def = slug === MUSE_AGENT_SLUG ? null : await getAgent(slug);
  if (!u || !def || u.runs < MIN_RUNS) return null;
  const { pick, pickSkills } = await pickLoadout(ctx, slug, def, u);
  return { runs: u.runs, days: span, tools: pick.map((t) => t.name), skills: pickSkills.map((s) => s.id) };
}

/** 报告正文(英文:模型读)。只读;每个结论都带次数,数据不够就明说不够。 */
export async function buildLoadoutReview(ctx: ToolContext, opts: { days?: number; agent?: string } = {}): Promise<string> {
  const days = Math.min(Math.max(7, Math.floor(Number(opts.days) || 30)), 90);
  const usage = await collectLoadoutUsage(ctx.userId, days);
  const only = String(opts.agent || '').trim();
  const slugs = [...usage.entries()]
    .filter(([slug, u]) => u.runs > 0 && slug !== MUSE_AGENT_SLUG && (!only || slug === only))
    .sort((a, b) => b[1].runs - a[1].runs)
    .map(([slug]) => slug);
  if (!slugs.length) return `No user-session runs${only ? ` for agent "${only}"` : ''} in the last ${days} days: not enough data for a loadout review. Do not recommend anything.`;

  const blocks: string[] = [];
  let judged = 0;
  for (const slug of slugs.slice(0, MAX_AGENTS)) {
    const u = usage.get(slug)!;
    const def = await getAgent(slug);
    if (!def) continue; // 已删除的 agent / 不是文件夹 agent 的归属名
    if (u.runs < MIN_RUNS) {
      blocks.push(`## ${slug} — ${u.runs} runs\nToo few runs to judge (fewer than ${MIN_RUNS}). Do not recommend shelving anything for this agent.`);
      continue;
    }
    judged++;
    const { shelved, skills, resident, calls, never, rare, used, total, pick, pickSkills, listedSkills, idleSkills } = await pickLoadout(ctx, slug, def, u);
    const lines = [`## ${slug} — ${u.runs} runs; ${resident.length} always-loaded tools, ${kb(total)} of definitions on every request`];
    const held = never.length - pick.length;
    lines.push(pick.length
      ? `Suggested tools to shelve this time (${pick.length}, ${kb(pick.reduce((n, t) => n + t.bytes, 0))}, each never called): ${pick.map((t) => `${t.name} (${kb(t.bytes)})`).join(', ')}`
      : 'Suggested tools to shelve this time: none');
    if (held > 0) lines.push(`Not suggested this time: ${held} more never-called tool(s), small (under ${kb(MIN_SHELVE_BYTES)}, not worth a catalog line), left for the next review, or brought back by the agent after an earlier shelving.`);
    if (rare.length) lines.push(`Not suggested — called 1-2 times: ${cut(rare.map((t) => `${t.name} ×${calls(t.name)} (last ${day(u.tools.get(t.name)!.last)})`))}`);
    if (used.length) lines.push(`Not suggested — in use: ${cut(used.map((t) => `${t.name} ×${calls(t.name)}`))}`);
    if (shelved.tools.size) lines.push(`Already shelved for this agent: ${cut([...shelved.tools].map((n) => `${n}${calls(n) ? ` ×${calls(n)} since` : ''}`))}`);
    if (skills?.catalog.length) {
      const listed = listedSkills, idle = idleSkills;
      const loaded = listed.filter((s) => u.skills.has(s.id)).sort((a, b) => u.skills.get(b.id)!.calls - u.skills.get(a.id)!.calls);
      lines.push(pickSkills.length
        ? `Suggested skills to shelve this time (${pickSkills.length} of ${idle.length} never loaded, ${listed.length} listed; ${kb(pickSkills.reduce((n, s) => n + s.bytes, 0))} of catalog lines): ${pickSkills.map((s) => s.id).join(', ')}`
        : `Suggested skills to shelve this time: none (${listed.length} listed)`);
      if (loaded.length) lines.push(`Not suggested — skills loaded: ${cut(loaded.map((s) => `${s.id} ×${u.skills.get(s.id)!.calls}`))}`);
      if (shelved.skills.size) lines.push(`Skills already shelved: ${cut([...shelved.skills])}`);
    }
    blocks.push(lines.join('\n'));
  }
  const head =
    `Loadout usage over the last ${days} days (the user's own local work sessions only; chat-preset, coding-preset, cloud, team, sub-agent, Muse and automation runs are not counted; GUI-only tools are not listed). This is a report: nothing has been changed.\n` +
    'An always-loaded tool costs its full definition on every request. Shelving (manage_harness, kind "equip") only moves a definition to the load-on-demand catalog; the tool still works.\n' +
    (judged
      ? `${judged} agent(s) have enough runs to judge. The "Suggested … this time" lines are the whole suggestion for this review (at most ${SUGGEST_MAX} tools and ${SUGGEST_MAX} skills per agent): pass them on exactly, add nothing. Everything else stays as it is.`
      : `No agent has enough runs (${MIN_RUNS}+) to judge: do not recommend anything.`);
  const body = [head, ...blocks].join('\n\n');
  const text = body.length > OUTPUT_CAP ? `${body.slice(0, OUTPUT_CAP)}\n… (report truncated; pass agent to see one agent in full)` : body;
  // 步骤段放在截断之后:报告再长它也在
  // 产品用词随报告给出(种子 prompt 保持纯英文):Muse 用中文写建议时自己翻,会翻出「暂存 / 设备」这类不是界面用语的词
  return judged ? `${text}\n\nIf you turn this into a todo, end its detail with this paragraph, kept intact (if you write in another language, translate the prose and keep tool and parameter names exactly; in Chinese use the product's own words: 收起 for shelve, 装备 for equipment, 按需目录 for the load-on-demand catalog):\n${L(LOADOUT_APPLY_STEPS_ZH, LOADOUT_APPLY_STEPS)}` : text;
}
