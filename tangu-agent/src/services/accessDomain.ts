/**
 * 分身的权限域(11-09,方案「记忆分层与 Agent 分身」第三步;身份解析见 agents/standIn.ts)。
 *
 * 换个 slug 能隔开的(Agent 记忆召回、跨会话片段、search_sessions / read_session、remember / log、Historian 候选)天然按分身自己的 slug 走;
 * 这里管的是**不按 slug 走**、必须按身份显式挡的那几样,判定全集中在这一个模块:
 *   - 工具面:内置工具只给白名单里的(shell、amadeus_* 读写用户日历 / 笔记、manage_human、电脑历史、活动日志、委派外部引擎、
 *     会话 / 讨论 / 子会话、界面与账号……都不在里面;明天新加的内置工具缺省也不给),插件工具只给注册这个通道的插件的,
 *     MCP、自定义工具一律不给。resolveTools 最前面一道闸,defs / 目录 / load_tools / 执行四处同时生效。
 *   - 文件读写根:只认分身自己的文件夹、这次会话的工作目录(通道配置的工作区)、本体勾给它的那几份 Library 文件(只读);
 *     本体和别的 Agent 的文件夹、human/、引擎 home / Forsion 家目录、笔记库一律拒,哪怕它们恰好在工作目录里面。
 *   - 委派:只能派不点名的子代理(或点名自己);点名别的 Agent 会切到它的记忆域,一律拒;外部引擎不给。
 *   - 画像 / 项目记忆 / human/ 注入 / Dream 进画像:按分身身份判(持久),不按会话此刻连没连通道判。
 */
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentsDir, humanDir, skillsDir, tanguHome } from '../core/tanguHome.js';
import { canonicalFuturePath, pathWithin, withinForsionDomains } from '../sandbox/hostSandboxProtection.js';
import { currentStandIn, type StandInDomain } from '../seams/runContext.js';
import type { NormalAgentDef } from '../agents/agentRegistry.js';

export type { StandInDomain };

/** 这次的分身权限域:ctx 上的优先(排队重放的调用不一定在 run 的异步子树里),其次 run 的 ALS。不是分身 → undefined。 */
export function standInOf(ctx?: { standIn?: StandInDomain } | null): StandInDomain | undefined {
  return ctx?.standIn ?? currentStandIn();
}

/** 本体勾给分身的 Library 文件 → 绝对路径(只认 Library 里面的文件,越界的名字丢掉)。 */
export function grantedLibraryFiles(body: Pick<NormalAgentDef, 'slug' | 'standInLibrary'>): string[] {
  const root = path.join(agentsDir(), body.slug, 'Library'); // = agentRegistry.libDirOf(本模块只引纯路径,不挂注册表那张图)
  return (body.standInLibrary ?? []).map((rel) => path.resolve(root, rel)).filter((abs) => pathWithin(abs, root) && abs !== root);
}

/** 组一个权限域(agentLoop 在读任何上下文之前调;cwd = 这次会话的工作目录)。 */
export function buildStandInDomain(own: Pick<NormalAgentDef, 'slug' | 'standInOf' | 'standInChannel'>, body: NormalAgentDef | null, opts: { cwd?: string; channel?: string; channelOwner?: string | null }): StandInDomain {
  const roots = [path.join(agentsDir(), own.slug)];
  if (opts.cwd) roots.push(path.resolve(opts.cwd));
  return {
    slug: own.slug,
    bodySlug: String(own.standInOf || ''),
    ...(opts.channel || own.standInChannel ? { channel: opts.channel || own.standInChannel } : {}),
    channelOwner: opts.channelOwner ?? null,
    agentMd: !!body?.standInAgentMd,
    library: body ? grantedLibraryFiles(body) : [],
    roots,
  };
}

// ── 工具面 ────────────────────────────────────────────────────────────────

/** 分身能用的内置工具(白名单,缺省拒):文件工具另受下面的读写根约束;记忆 / 日志 / 会话 / 日程 / 工作笔记都是分身自己的。 */
export const STANDIN_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  // 文件(读写根见 standInReadDenied / standInWriteDenied)
  'read_file', 'list_dir', 'glob_files', 'search_files', 'write_file', 'edit_file', 'multi_edit', 'apply_patch',
  'view_image', 'read_document', 'move_path', 'copy_path', 'delete_path',
  // 网页、生成与小工具(view_video / transcribe_audio 不过读根闸,第一期不给:Codex 评审 #3)
  'web_search', 'web_fetch', 'generate_image', 'edit_image', 'calculator', 'get_datetime',
  // 自己的记忆 / 日志 / 会话 / 日程 / 工作笔记 / 技能
  'remember', 'log_event', 'read_log', 'search_sessions', 'read_session', 'manage_harness', 'manage_schedule', 'use_skill', 'load_tools',
  // 对话本身
  'ask_user', 'todo_read', 'todo_write', 'exit_plan_mode', 'session_status', 'delegate',
  // 往通道里发文件 / 图(发的文件同样过读根)
  'channel_send_file', 'channel_send_image',
]);

/** 这件工具分身能不能看见 / 调用。isBuiltin = 引擎全局 provider(含插件的);fromPlugin + ownerPlugin = 插件 provider 与它的插件 id。 */
export function standInToolDenied(dom: StandInDomain | undefined, name: string, src: { isBuiltin: boolean; fromPlugin: boolean; ownerPlugin?: string }): boolean {
  if (!dom) return false;
  if (src.fromPlugin) return !(dom.channelOwner && src.ownerPlugin === dom.channelOwner);
  if (!src.isBuiltin) return true; // app / 自定义工具
  return !STANDIN_BUILTIN_TOOLS.has(name);
}

/** 委派闸:分身只能派不点名的子代理(或点名自己);点名别的 Agent 会切到它的记忆域 —— 一律拒。外部引擎(本机 CLI 全权)也不给。 */
export function standInDelegateDenied(dom: StandInDomain | undefined, args: { agentSlug?: unknown; engine?: unknown }): string | null {
  if (!dom) return null;
  const target = typeof args.agentSlug === 'string' ? args.agentSlug.trim() : '';
  if (target && target !== dom.slug) {
    return `Error: you are a stand-in answering in a conversation other people can read, so you cannot delegate to "${target}" (another agent's memory and files are outside what you may use here). Delegate without agentSlug, or do the work yourself.`;
  }
  if (typeof args.engine === 'string' && args.engine.trim()) return 'Error: external engines are not available to a stand-in. Delegate without engine, or do the work yourself.';
  return null;
}

/** 管自己东西的工具也有点名别人的参数(Codex 评审 #1):日程只管自己的;工作笔记的 propose 是往别的 Agent 的候选箱里写,不给。 */
export function standInManageDenied(dom: StandInDomain | undefined, tool: 'manage_schedule' | 'manage_harness', args: { agent?: unknown; action?: unknown }): string | null {
  if (!dom) return null;
  if (tool === 'manage_schedule') {
    const target = typeof args.agent === 'string' ? args.agent.trim() : '';
    return target && target !== dom.slug ? 'Error: a stand-in can only manage its own schedule (omit the agent parameter).' : null;
  }
  return String(args.action || '') === 'propose' ? 'Error: a stand-in cannot propose notes to other agents.' : null;
}

// ── 文件读写根 ──────────────────────────────────────────────────────────────

const real = (p: string): string => { try { return canonicalFuturePath(path.resolve(p)); } catch { return path.resolve(p); } };
/** 字面与真实路径两种形态(软链进来同样认得)。 */
const forms = (abs: string): string[] => [...new Set([path.resolve(abs), real(abs)])];
/** 拒绝用:字面或真实路径任一落在根里(字面 / 真实两种根)就算 —— 宁可多拒。 */
const within = (abs: string, root: string): boolean => { const r = [path.resolve(root), real(root)]; return forms(abs).some((f) => r.some((x) => pathWithin(f, x))); };
/** 放行用:只认真实目标落在真实根里(Codex 评审 #2:自己文件夹里一条指向本体的软链,字面在里面、真实在外面,不能凭字面放行)。 */
const inside = (abs: string, root: string): boolean => pathWithin(real(abs), real(root));

/** 笔记库根(同 tools/builtin/amadeus.ts amadeusVaultPath 的解析顺序;这里不引那个模块,免得文件策略挂上整张工具图)。 */
function vaultRoot(): string {
  const env = process.env.FORSION_AMADEUS_VAULT?.trim();
  if (env) return env;
  const cfg = process.env.FORSION_AMADEUS_CONFIG?.trim();
  if (cfg) {
    try { const v = JSON.parse(readFileSync(cfg, 'utf8'))?.lastVault; if (typeof v === 'string' && v.trim()) return v.trim(); } catch { /* 回落缺省 */ }
  }
  return path.join(os.homedir(), 'Forsion', 'Amadeus');
}
/** 包内置技能(dist/services/../../skills = 包根 skills/,同 skills/localSkills.builtinSkillsDir)。 */
const packageSkills = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const packageAgentSkills = (slug: string): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-skills', slug);

/** 技能是人设的一部分(跟着本体):全局技能、包内置技能、本体自己的技能目录可读(只读,写还要过 standInWriteDenied)。 */
function skillRoot(abs: string, dom: StandInDomain): boolean {
  return [skillsDir(), packageSkills(), packageAgentSkills(dom.bodySlug), path.join(agentsDir(), dom.bodySlug, 'skills')].some((r) => inside(abs, r));
}

/** 分身读这个路径:null = 可以;否则是给模型的拒绝原因(英文)。 */
export function standInReadDenied(dom: StandInDomain | undefined, abs: string): string | null {
  if (!dom) return null;
  const own = path.join(agentsDir(), dom.slug);
  if (inside(abs, own)) return null;
  if (dom.library.some((f) => real(f) === real(abs))) return null;
  if (skillRoot(abs, dom)) return null;
  const denied = `Access denied: ${abs} is outside what this stand-in can read. You are answering in a conversation other people can read, so you only have your own folder (${own}), the working directory and the files the user shared with you.`;
  // 本体 / 别的 Agent、human/、引擎 home、Forsion 家目录、笔记库:哪怕在工作目录里面也不给
  if (within(abs, agentsDir()) || within(abs, humanDir()) || within(abs, tanguHome()) || withinForsionDomains(abs) || within(abs, vaultRoot())) return denied;
  if (dom.roots.some((r) => inside(abs, r))) return null;
  return denied;
}

/** 分身写这个路径:null = 可以(之后照常过 fsPolicy 的其余判定);否则是硬拒原因。只认自己的文件夹和工作目录,勾给它的 Library 文件只读。 */
export function standInWriteDenied(dom: StandInDomain | undefined, abs: string): string | null {
  if (!dom) return null;
  const own = path.join(agentsDir(), dom.slug);
  if (inside(abs, own)) return null;
  const denied = `Access denied: a stand-in can only write inside its own folder (${own}) and the working directory; ${abs} is outside them.`;
  if (within(abs, agentsDir()) || within(abs, humanDir()) || within(abs, tanguHome()) || withinForsionDomains(abs) || within(abs, vaultRoot())) return denied;
  if (dom.roots.some((r) => inside(abs, r))) return null;
  return denied;
}

/** 搜索 / 列举的起点:起点本身读不了,或者起点底下包着读不了的那几片(本体与别的 Agent、human/、引擎 home、Forsion 家目录、笔记库),整次拒 ——
 *  搜索结果不逐条过读根,只能在起点上把住。 */
export function standInSearchDenied(dom: StandInDomain | undefined, baseDir: string): string | null {
  if (!dom) return null;
  const direct = standInReadDenied(dom, baseDir);
  if (direct) return direct;
  const own = path.join(agentsDir(), dom.slug);
  if (inside(baseDir, own)) return null; // 自己的文件夹(含底下)随便搜;方向别写反:起点是自己文件夹的祖先时不算(Codex 评审 #5)
  const guarded = [agentsDir(), humanDir(), tanguHome(), vaultRoot()];
  if (guarded.some((g) => within(g, baseDir))) return `Access denied: searching ${baseDir} would reach folders this stand-in cannot read (other agents, the user's own files or notes). Search a narrower folder inside the working directory.`;
  return null;
}
