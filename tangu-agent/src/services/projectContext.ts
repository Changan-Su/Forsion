/**
 * 项目上下文(桌面「PROJECT 详情」的数据面):一个本地项目会话的 cwd 上,引擎**实际会读**的项目级内容 ——
 * 指令文件(照 projectDoc 的发现规则)、项目技能(`<cwd>/.tangu/skills`)、已批准的计划、git 现场,
 * 以及**用户侧**的项目默认项。只有引擎能回答「Tangu 到底看没看见我的 AGENTS.md」:桌面自己 stat 一遍等于
 * 再实现一份发现规则,迟早漂移(2026-07 `.forsion`/`.tangu` 双名并存漂了 6 周就是这么来的)。
 *
 * 目录基准是**会话 cwd(= 桌面的 project_path)而不是 git 根**:技能加载器只扫 `currentRunCwd()/.tangu/skills`,
 * 指令文件也是 cwd 层最具体;写到 git 根去,cwd 在子目录时引擎根本读不到(codex 评审指出)。
 *
 * 写路径只有三条,全部落在 `<cwd>/.tangu` 之内(指令文件例外:cwd 层已有别家文件名时就地改那一份):
 *   init(建目录 + 模板)/ 写指令文件 / 建技能。项目目录不可信 —— clone 来的仓可以自带 `.tangu -> ~/.ssh`,
 *   所以每一段路径都 lstat 拒软链,新建用 O_EXCL 独占,改写校验 mtime,打开一律 O_NOFOLLOW。
 *
 * 项目默认项(默认 Agent / Team、模型、思考档、审批档)住**用户家目录** `tanguHome()/project-settings.json`,
 * 按 realpath 索引,不进仓库:模型 id 与审批偏好依赖本机安装与本人意愿,不该由仓库的提交者替别人决定。
 */
import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { tanguHome, WORKSPACE_DIR_NAME } from '../core/tanguHome.js';
import { PROJECT_DOC_FILENAMES, isPlainFileUnder, loadProjectDocSafe } from './projectDoc.js';
import { listProjectSkills } from '../skills/localSkills.js';
import { runGit } from './runtimeContext.js';
import { AVATAR_EXT_MIME, AVATAR_MAX_BYTES } from '../agents/agentRegistry.js';

export interface ProjectSettings {
  /** 新会话预填的 Agent;与 defaultTeam 二选一。 */
  defaultAgent?: string;
  /** 新会话预填的团队(展开成 groupChat + groupAgents + teamRoles + teamDoc,由客户端 / 派遣方完成)。 */
  defaultTeam?: string;
  model?: string;
  thinkingLevel?: string;
  approvalMode?: string;
  /** 项目图标:emoji(任意短文本)或 `icon.<ext>` = 用户导入、存在 `<cwd>/.tangu/` 里的图片(同团队头像的单字段约定)。 */
  icon?: string;
}
export interface ProjectDocInfo {
  /** 「这个项目的指令文件」:cwd 层首个命中的候选名;一个都没有时 = 待创建的 `<cwd>/.tangu/AGENTS.md`。 */
  path: string;
  exists: boolean;
  /** 文件正文;不存在 / 超过 DOC_READ_LIMIT 时 null。 */
  content: string | null;
  mtimeMs: number | null;
  bytes: number;
  tooLarge: boolean;
  /** 引擎本轮实际会拼进系统提示的全部文件(根→cwd),含上面那份。 */
  sources: string[];
  truncated: boolean;
  candidates: string[];
}
export interface ProjectSkillInfo { id: string; name: string; description: string; path: string; legacy: boolean }
export interface ProjectPlanInfo { name: string; path: string; mtimeMs: number; size: number; title: string }
export interface GitCommitInfo { sha: string; short: string; at: number; subject: string }
export interface GitChangeInfo { code: string; path: string }
export interface GitSummary {
  /** 本机找得到 git。false 时其余字段无意义。 */
  available: boolean;
  /** cwd 在某个 git 工作树里。 */
  repo: boolean;
  /** cwd 不是仓库顶层(项目落在更大的仓里)。 */
  nested?: boolean;
  branch?: string;
  detached?: boolean;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: number;
  unstaged?: number;
  untracked?: number;
  /** 前 GIT_CHANGES_SHOWN 条改动;changesTotal 是全量。 */
  changes?: GitChangeInfo[];
  changesTotal?: number;
  commits?: GitCommitInfo[];
  /** origin 的地址,凭据已遮盖;没有 origin 时 null。 */
  remote?: string | null;
}
export interface ProjectContext {
  cwd: string;
  workspaceDir: string;
  workspaceDirName: string;
  doc: ProjectDocInfo;
  skills: ProjectSkillInfo[];
  plans: ProjectPlanInfo[];
  settings: ProjectSettings | null;
  git: GitSummary;
}

/** 面板里能编辑的指令文件上限:引擎每轮只拼 32KB,再大也只是被截掉;256KB 之外连编辑器都不该装。 */
export const DOC_READ_LIMIT = 256 * 1024;
export const SKILL_CONTENT_LIMIT = 64 * 1024;
const GIT_UI_TIMEOUT_MS = 3000;
const GIT_CHANGES_SHOWN = 20;
const GIT_COMMITS_SHOWN = 8;
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const APPROVAL = new Set(['readonly', 'auto-edit', 'full-auto', 'custom']);

/** 新项目的指令文件骨架(模型读的,英文)。占位小节留空,让用户 / 「让 Tangu 生成」来填,而不是写一堆通用废话进系统提示。 */
export const PROJECT_DOC_TEMPLATE = `# Project instructions

<!-- Tangu reads this file at the start of every run in this project (together with any AGENTS.md / CLAUDE.md
     between the repository root and the working directory). Keep it short and factual: what the project is,
     how to build, run and test it, where things live, the conventions to follow, and what an agent must never do.
     Delete the sections you do not need. -->

## What this project is

## Build, run and test

## Layout

## Conventions

## Do not
`;

/** 根目录 / 家目录及其祖先绝不能当项目(同 tools/builtin/startProjectSession.ts 的 isForbiddenProjectRoot;那边挂着 agentLoop 的
 *  动态导入链,这里只要三行判断,不值得为它拖进整棵工具树)。 */
export function isForbiddenProjectDir(p: string): boolean {
  const norm = path.resolve(p);
  const home = path.resolve(homedir());
  return norm === path.parse(norm).root || norm === home || home.startsWith(norm + path.sep);
}

/** 信任边界:只接受绝对路径,realpath 后必须是真实存在的目录且不是禁区。返回 canonical 路径(后续一切读写与设置索引都用它)。 */
export async function canonicalProjectPath(cwd: unknown): Promise<string> {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) throw new Error('project path must be absolute');
  const real = await fs.realpath(cwd).catch(() => { throw new Error('project directory does not exist'); });
  if (!(await fs.stat(real)).isDirectory()) throw new Error('project path is not a directory');
  if (isForbiddenProjectDir(real)) throw new Error('this directory cannot be used as a project');
  return real;
}

/** 项目目录不可信:写之前逐段 lstat —— 已存在的中间段必须是真目录,末段(若存在)必须是 wantFile ? 真文件 : 真目录,
 *  任何一段是软链就拒;缺失的段允许(随后由调用方 mkdir / O_EXCL 创建)。 */
export async function assertSafeChain(base: string, rel: string, wantFile: boolean): Promise<void> {
  const segs = rel.split('/').filter(Boolean);
  let cur = base;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    const st = await fs.lstat(cur).catch((e: NodeJS.ErrnoException) => { if (e?.code === 'ENOENT') return null; throw e; });
    if (!st) return; // 从这一段起都不存在,后面的由调用方创建
    const last = i === segs.length - 1;
    const shown = path.relative(base, cur) || cur;
    if (st.isSymbolicLink()) throw new Error(`${shown} is a symbolic link; refusing to write through it`);
    if (last ? !(wantFile ? st.isFile() : st.isDirectory()) : !st.isDirectory()) {
      throw new Error(`${shown} is not a ${last && wantFile ? 'regular file' : 'directory'}`);
    }
  }
}

/** 新建文件:O_EXCL 独占(已存在 → EEXIST,绝不覆盖)+ O_NOFOLLOW(lstat 与 open 之间的窗口交给内核把关;Windows 无此常量退化)。 */
async function writeNew(file: string, text: string | Buffer): Promise<void> {
  const fd = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o644);
  try { await fd.writeFile(text, 'utf8'); } finally { await fd.close(); }
}

/** cwd 层的指令文件:候选名里首个命中的那份(与 projectDocPaths 同一规则),都没有 → 待创建的 `.tangu/AGENTS.md`。 */
export function resolveDocTarget(cwd: string): { path: string; exists: boolean } {
  for (const name of PROJECT_DOC_FILENAMES) {
    if (isPlainFileUnder(cwd, name)) return { path: path.join(cwd, name), exists: true };
  }
  return { path: path.join(cwd, WORKSPACE_DIR_NAME, 'AGENTS.md'), exists: false };
}

async function docInfo(cwd: string): Promise<ProjectDocInfo> {
  const target = resolveDocTarget(cwd);
  const loaded = loadProjectDocSafe(cwd);
  let content: string | null = null;
  let mtimeMs: number | null = null;
  let bytes = 0;
  let tooLarge = false;
  if (target.exists) {
    const st = await fs.stat(target.path);
    mtimeMs = st.mtimeMs;
    bytes = st.size;
    if (st.size > DOC_READ_LIMIT) tooLarge = true;
    else content = await fs.readFile(target.path, 'utf8');
  }
  return {
    path: target.path, exists: target.exists, content, mtimeMs, bytes, tooLarge,
    sources: loaded?.sources ?? [], truncated: loaded?.truncated ?? false, candidates: [...PROJECT_DOC_FILENAMES],
  };
}

/** 计划文件的首个一级标题(只读前 4KB);没有 → 空串,面板退回文件名。 */
async function firstHeading(file: string): Promise<string> {
  let fd: fs.FileHandle | null = null;
  try {
    fd = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const m = /^#\s+(.+)$/m.exec(buf.subarray(0, bytesRead).toString('utf8'));
    return m ? m[1].trim().slice(0, 120) : '';
  } catch {
    return '';
  } finally {
    await fd?.close().catch(() => {});
  }
}

/** `<cwd>/.tangu/plans/*.md`(批准计划时引擎写的),新的在前。 */
export async function listProjectPlans(cwd: string, limit = 30): Promise<ProjectPlanInfo[]> {
  const dir = path.join(cwd, WORKSPACE_DIR_NAME, 'plans');
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const files: Array<Omit<ProjectPlanInfo, 'title'>> = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const p = path.join(dir, name);
    const st = await fs.lstat(p).catch(() => null);
    if (!st?.isFile()) continue;
    files.push({ name, path: p, mtimeMs: st.mtimeMs, size: st.size });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return Promise.all(files.slice(0, limit).map(async (f) => ({ ...f, title: await firstHeading(f.path) })));
}

// ── 项目默认项(用户侧)──────────────────────────────────────────────────────

export const projectSettingsFile = (): string => path.join(tanguHome(), 'project-settings.json');
interface SettingsFile { version: 1; projects: Record<string, ProjectSettings> }

/** 白名单收窄:Agent / Team 二选一(Agent 优先)、模型 id 长度封顶、思考档与审批档只认已知枚举。没有一个有效键 → null(= 删除)。 */
export function sanitizeProjectSettings(input: unknown): ProjectSettings | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : undefined);
  const out: ProjectSettings = {};
  const agent = str(src.defaultAgent, 64);
  const team = str(src.defaultTeam, 64);
  if (agent && SAFE_SLUG.test(agent)) out.defaultAgent = agent;
  else if (team && SAFE_SLUG.test(team)) out.defaultTeam = team;
  const model = str(src.model, 200);
  if (model) out.model = model;
  const thinking = str(src.thinkingLevel, 16);
  if (thinking && THINKING.has(thinking)) out.thinkingLevel = thinking;
  const approval = str(src.approvalMode, 16);
  if (approval && APPROVAL.has(approval)) out.approvalMode = approval;
  const icon = str(src.icon, 32);
  if (icon && !/[\u0000-\u001f]/.test(icon)) out.icon = icon;
  return Object.keys(out).length ? out : null;
}

async function readSettingsFile(): Promise<SettingsFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(projectSettingsFile(), 'utf8')) as Partial<SettingsFile>;
    if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') {
      return { version: 1, projects: parsed.projects as Record<string, ProjectSettings> };
    }
  } catch { /* 没有文件 / 坏 JSON → 空表;写回时整份重写 */ }
  return { version: 1, projects: {} };
}

/** 该项目的默认项;cwd 先 realpath(索引键),读不到 / 无记录 → null。 */
export async function readProjectSettings(cwd: string): Promise<ProjectSettings | null> {
  const key = await fs.realpath(cwd).catch(() => path.resolve(cwd));
  const file = await readSettingsFile();
  return sanitizeProjectSettings(file.projects[key]);
}

/** 同一把键上的写操作串行化(settings 文件 / 某份指令文件):两个窗口同时保存时,读-改-写不能交错 —— 后写的会把先写的整份盖掉,
 *  指令文件的 mtime 校验也只有在「检查 + 写入」不被别人插队时才守得住 409 的承诺。跨进程(两个引擎)不在此列:一个 home 只有一个引擎。 */
const writeQueues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (writeQueues.get(key) ?? Promise.resolve()).then(task, task);
  const guard: Promise<unknown> = result.catch(() => {}).then(() => { if (writeQueues.get(key) === guard) writeQueues.delete(key); });
  writeQueues.set(key, guard);
  return result;
}

/** 写默认项(整份读改写 + 临时文件 rename 原子落盘,整个 RMW 串行);settings 为 null / 无有效键 = 删除该项目的记录。返回落盘后的值。
 *  icon 不经这里改,一律保留落盘现值(图标只走下面的图标函数):否则另一个窗口拿着旧草稿的整份 PUT 会把刚换 / 刚删的图标写回去(Codex 评审)。 */
export function writeProjectSettings(cwd: string, settings: unknown): Promise<ProjectSettings | null> {
  return updateProjectSettings(cwd, (cur) => ({ ...(settings && typeof settings === 'object' ? settings : {}), icon: cur?.icon }));
}

/** 按当前记录改一处(图标上传 / 移除只动 icon 一个键):读当前值与写回在同一个串行段里,不和并发的整份 PUT 交错。 */
export function updateProjectSettings(cwd: string, next: (current: ProjectSettings | null) => unknown): Promise<ProjectSettings | null> {
  return serialized(projectSettingsFile(), async () => {
    const key = await fs.realpath(cwd).catch(() => path.resolve(cwd));
    const file = await readSettingsFile();
    const clean = sanitizeProjectSettings(next(sanitizeProjectSettings(file.projects[key])));
    if (clean) file.projects[key] = clean;
    else delete file.projects[key];
    const target = projectSettingsFile();
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`; // 每笔各写各的临时文件,rename 才是原子点
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, target);
    return clean;
  });
}

// ── 写路径 ─────────────────────────────────────────────────────────────────

/** 初始化项目的 Tangu 目录:`.tangu/` + `.tangu/skills/`,cwd 层没有任何指令文件时再放一份 AGENTS.md 骨架。幂等,绝不覆盖已有内容。 */
export async function initProjectWorkspace(cwd: string): Promise<{ createdDir: boolean; createdDoc: boolean }> {
  await assertSafeChain(cwd, `${WORKSPACE_DIR_NAME}/skills`, false);
  const wsDir = path.join(cwd, WORKSPACE_DIR_NAME);
  const existed = await fs.lstat(wsDir).then(() => true).catch(() => false);
  await fs.mkdir(path.join(wsDir, 'skills'), { recursive: true });
  const target = resolveDocTarget(cwd);
  let createdDoc = false;
  if (!target.exists) {
    await assertSafeChain(cwd, path.relative(cwd, target.path).split(path.sep).join('/'), true);
    await writeNew(target.path, PROJECT_DOC_TEMPLATE);
    createdDoc = true;
  }
  return { createdDir: !existed, createdDoc };
}

/** 写「这个项目的指令文件」(路径由服务端算,客户端不传):已有的那份校验 mtime 后改写,没有就在 `.tangu/` 下新建。
 *  conflict:true = 文件在读出之后被别处改过,没有写入 —— 调用方拿最新 mtime 重新决定。 */
export async function writeProjectDoc(cwd: string, content: string, expectedMtimeMs?: number | null): Promise<{ path: string; mtimeMs: number; conflict?: true }> {
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (Buffer.byteLength(content, 'utf8') > DOC_READ_LIMIT) throw new Error(`instruction file must stay under ${DOC_READ_LIMIT} bytes`);
  // 同一份文件的「校验 mtime + 写入」串行:两个窗口几乎同时保存时,后到的那笔看到的是前一笔写完后的 mtime → 老实拿 409,而不是两笔都过、后写盖前写。
  return serialized(`doc:${path.resolve(cwd)}`, async () => {
    const target = resolveDocTarget(cwd);
    const rel = path.relative(cwd, target.path).split(path.sep).join('/');
    await assertSafeChain(cwd, rel, true);
    if (target.exists) {
      const before = await fs.lstat(target.path);
      if (expectedMtimeMs != null && Math.abs(before.mtimeMs - expectedMtimeMs) > 1) return { path: target.path, mtimeMs: before.mtimeMs, conflict: true as const };
      const fd = await fs.open(target.path, fsConstants.O_WRONLY | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0));
      try { await fd.writeFile(content, 'utf8'); } finally { await fd.close(); }
    } else {
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      await writeNew(target.path, content);
    }
    const after = await fs.stat(target.path);
    return { path: target.path, mtimeMs: after.mtimeMs };
  });
}

const oneLine = (v: unknown, max: number): string => String(v ?? '').replace(/[\r\n\t\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** 在 `.tangu/skills/<slug>/SKILL.md` 建一个项目技能(frontmatter 只写 name / description;已有同名文件夹里的 SKILL.md → 拒,不覆盖)。 */
export async function createProjectSkill(cwd: string, input: { slug?: unknown; name?: unknown; description?: unknown; content?: unknown }): Promise<ProjectSkillInfo> {
  const slug = String(input.slug ?? '').trim();
  if (!SAFE_SLUG.test(slug)) throw new Error('skill folder name must be lowercase letters, digits and hyphens');
  const name = oneLine(input.name, 120) || slug;
  const description = oneLine(input.description, 300);
  const body = String(input.content ?? '').trim();
  if (!body) throw new Error('skill instructions are required');
  if (Buffer.byteLength(body, 'utf8') > SKILL_CONTENT_LIMIT) throw new Error(`skill instructions must stay under ${SKILL_CONTENT_LIMIT} bytes`);
  await assertSafeChain(cwd, `${WORKSPACE_DIR_NAME}/skills/${slug}/SKILL.md`, true);
  const dir = path.join(cwd, WORKSPACE_DIR_NAME, 'skills', slug);
  await fs.mkdir(dir, { recursive: true });
  // 值一律 JSON 双引号串(合法 YAML 标量),parseFrontmatter 会剥掉引号;冒号 / 井号在裸值里会被别的解析器读歪。
  await writeNew(path.join(dir, 'SKILL.md'), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`);
  return { id: `local:${slug}`, name, description, path: dir, legacy: false };
}

// ── 项目图标 ───────────────────────────────────────────────────────────────
// 指针(settings.icon)住用户侧,图片住项目的 `.tangu/`(用户拍板:导入的图标文件放项目自己的目录里)。

export const PROJECT_ICON_FILE = /^icon\.(png|jpe?g|gif|webp)$/i;

/** 按文件头认图片类型,不信客户端报的 mime(标错的导入会存成一张打不开的图标)。 */
function sniffImage(buf: Buffer): string | null {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** 删 `.tangu/<name>`,只认 icon.<ext> 名。`.tangu` 是软链 → 拒;rm 碰到软链只删链本身。 */
async function removeIconFile(cwd: string, name: string | undefined): Promise<void> {
  if (!name || !PROJECT_ICON_FILE.test(name)) return;
  await assertSafeChain(cwd, WORKSPACE_DIR_NAME, false);
  await fs.rm(path.join(cwd, WORKSPACE_DIR_NAME, name), { force: true });
}

const iconQueue = (cwd: string): string => `icon:${path.resolve(cwd)}`;

/** 导入图片:`<cwd>/.tangu/icon.<ext>`(按文件头认 png/jpeg/gif/webp,≤1MB),settings.icon 指过去,再删**上一张**。
 *  只删自己指向过的那张:`.tangu/` 里别的 icon.*(比如队友提交进仓的)不碰;同名那张就是图标槽位,覆盖。返回落盘后的默认项。 */
export function saveProjectIcon(cwd: string, base64: string): Promise<ProjectSettings | null> {
  const raw = base64.trimStart().startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) return Promise.reject(new Error('empty image'));
  if (buf.length > AVATAR_MAX_BYTES) return Promise.reject(new Error('image too large (max 1MB)'));
  const ext = sniffImage(buf);
  if (!ext) return Promise.reject(new Error('unsupported image type (png/jpeg/gif/webp only)'));
  const filename = `icon.${ext}`;
  // 同一项目的图标写串行:删同名 + O_EXCL 新建之间不能被另一笔插队(否则后者 EEXIST),「上一张」也要读到前一笔落盘后的值
  return serialized(iconQueue(cwd), async () => {
    const prev = (await readProjectSettings(cwd))?.icon;
    await assertSafeChain(cwd, `${WORKSPACE_DIR_NAME}/${filename}`, true);
    await fs.mkdir(path.join(cwd, WORKSPACE_DIR_NAME), { recursive: true });
    await fs.rm(path.join(cwd, WORKSPACE_DIR_NAME, filename), { force: true });
    await writeNew(path.join(cwd, WORKSPACE_DIR_NAME, filename), buf);
    const saved = await updateProjectSettings(cwd, (cur) => ({ ...cur, icon: filename }));
    if (prev !== filename) await removeIconFile(cwd, prev);
    return saved;
  });
}

/** 设 emoji 图标;原来指向的图片随之删掉(图片住在项目目录里,不留孤儿文件)。 */
export function setProjectIconEmoji(cwd: string, emoji: unknown): Promise<ProjectSettings | null> {
  const text = typeof emoji === 'string' ? emoji.trim() : '';
  if (!text || text.length > 32 || /[\u0000-\u001f]/.test(text) || PROJECT_ICON_FILE.test(text)) return Promise.reject(new Error('invalid emoji icon'));
  return serialized(iconQueue(cwd), async () => {
    const prev = (await readProjectSettings(cwd))?.icon;
    const saved = await updateProjectSettings(cwd, (cur) => ({ ...cur, icon: text }));
    await removeIconFile(cwd, prev);
    return saved;
  });
}

/** 移除图标(emoji 或图片):清 settings.icon,指向过的图片一并删掉。 */
export function deleteProjectIcon(cwd: string): Promise<ProjectSettings | null> {
  return serialized(iconQueue(cwd), async () => {
    const prev = (await readProjectSettings(cwd))?.icon;
    const saved = await updateProjectSettings(cwd, (cur) => ({ ...cur, icon: undefined }));
    await removeIconFile(cwd, prev);
    return saved;
  });
}

/** 读图标图片:只在用户自己的 settings.icon 指向 `icon.<ext>` 时才出这一个固定名文件;逐段拒软链 + O_NOFOLLOW + 大小封顶。 */
export async function readProjectIcon(cwd: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const icon = (await readProjectSettings(cwd))?.icon;
  if (!icon || !PROJECT_ICON_FILE.test(icon)) return null;
  const rel = `${WORKSPACE_DIR_NAME}/${icon}`;
  try { await assertSafeChain(cwd, rel, true); } catch { return null; }
  const fd = await fs.open(path.join(cwd, rel), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!fd) return null;
  try {
    const st = await fd.stat();
    if (!st.isFile() || st.size > AVATAR_MAX_BYTES) return null;
    return { data: await fd.readFile(), mimeType: AVATAR_EXT_MIME[icon.split('.').pop()!.toLowerCase()] || 'application/octet-stream' };
  } finally { await fd.close(); }
}

// ── git ────────────────────────────────────────────────────────────────────

/** 遮盖远端地址里的凭据:`https://user:token@host/...` → `https://host/...`(面板要显示、日志会记,token 不能露)。 */
export function maskRemoteUrl(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i, '$1');
}

/** `git status --porcelain` 一行 → 改动项;XY 两位状态码原样给面板(它自己决定怎么标)。 */
export function parseStatusLine(line: string): GitChangeInfo | null {
  if (line.length < 4) return null;
  return { code: line.slice(0, 2), path: line.slice(3) };
}

/** 只读 git 现场(全部命令经 runGit 的固定安全前缀;非零退出按「没有」处理,不抛):
 *  分支 / 上游领先落后 / 改动计数与前 20 项 / 最近提交 / 远端。无 git → available:false;非仓库 → repo:false。 */
export async function gitSummary(cwd: string): Promise<GitSummary> {
  const g = (args: string[]) => runGit(cwd, args, undefined, GIT_UI_TIMEOUT_MS);
  const inside = await g(['rev-parse', '--is-inside-work-tree']);
  if (inside.reason === 'spawn-error') return { available: false, repo: false };
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { available: true, repo: false };
  const [branchR, topR, upstreamR, statusR, logR, remoteR] = await Promise.all([
    g(['rev-parse', '--abbrev-ref', 'HEAD']),
    g(['rev-parse', '--show-toplevel']),
    g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']),
    g(['status', '--porcelain', '--untracked-files=normal']),
    g(['log', `-${GIT_COMMITS_SHOWN}`, '--format=%h%x1f%H%x1f%ct%x1f%s']),
    g(['remote', 'get-url', 'origin']),
  ]);
  const commits: GitCommitInfo[] = logR.code === 0
    ? logR.stdout.split('\n').filter(Boolean).map((line) => {
        const [short, sha, ct, ...rest] = line.split('\x1f');
        return { short, sha, at: Number(ct) * 1000, subject: rest.join('\x1f').trim() };
      }).filter((c) => c.sha && Number.isFinite(c.at))
    : [];
  const rawBranch = branchR.code === 0 ? branchR.stdout.trim() : '';
  const detached = rawBranch === 'HEAD';
  const branch = detached ? (commits[0]?.short || 'HEAD') : rawBranch;
  const top = topR.code === 0 ? await fs.realpath(topR.stdout.trim()).catch(() => topR.stdout.trim()) : '';
  const real = await fs.realpath(cwd).catch(() => cwd);
  const upstream = upstreamR.code === 0 ? upstreamR.stdout.trim() : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await g(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const m = counts.code === 0 ? /^(\d+)\s+(\d+)/.exec(counts.stdout.trim()) : null;
    if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
  }
  const lines = statusR.code === 0 ? statusR.stdout.split('\n').filter(Boolean) : [];
  const changes = lines.map(parseStatusLine).filter((c): c is GitChangeInfo => !!c);
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const c of changes) {
    if (c.code === '??') { untracked++; continue; }
    if (c.code === '!!') continue;
    if (c.code[0] !== ' ') staged++;
    if (c.code[1] !== ' ') unstaged++;
  }
  return {
    available: true, repo: true, nested: !!top && top !== real, branch, detached, upstream, ahead, behind,
    staged, unstaged, untracked, changes: changes.slice(0, GIT_CHANGES_SHOWN), changesTotal: changes.length, commits,
    remote: remoteR.code === 0 ? maskRemoteUrl(remoteR.stdout) : null,
  };
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

async function projectSkills(cwd: string): Promise<ProjectSkillInfo[]> {
  const found = await listProjectSkills(cwd).catch(() => []);
  return found.map(({ skill, dir, legacy }) => ({ id: skill.id, name: skill.name, description: skill.description || '', path: dir, legacy }));
}

/** 面板一次拉全:各段并行,任何一段失败都不拖垮其余(git 缺席就是 available:false,技能读不了就是空表)。 */
export async function projectContext(cwd: string): Promise<ProjectContext> {
  const canonical = await canonicalProjectPath(cwd);
  const [doc, skills, plans, settings, git] = await Promise.all([
    docInfo(canonical),
    projectSkills(canonical),
    listProjectPlans(canonical).catch(() => []),
    readProjectSettings(canonical).catch(() => null),
    gitSummary(canonical).catch((): GitSummary => ({ available: false, repo: false })),
  ]);
  return { cwd: canonical, workspaceDir: path.join(canonical, WORKSPACE_DIR_NAME), workspaceDirName: WORKSPACE_DIR_NAME, doc, skills, plans, settings, git };
}
