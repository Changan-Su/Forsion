/**
 * 云端多租户(hostExec=false)的 per-user Normal Agents 存储。
 * 底座 = brain.agentFiles seam(服务端 tangu_agent_files 表,键 user_id+slug+rel_path);文件形状与本地
 * 文件夹版完全一致(config.toml + SOUL.md + Library/avatar.*、哨兵 __meta__/.meta.json),桌面
 * agentFileSync 双向可见。合并/解析全部复用 agentRegistry 的纯函数(buildAgentDef/parse/serialize),
 * 与本地一份语义。仅 routes/agents.ts 的云端分支使用;run 侧水合是既有另一条链路
 * (agentActivation → brain.agents.getAgent),本模块不参与。
 */
import { deps } from '../seams/runtime.js';
import { AgentFileConflictError, type AgentFileContent, type AgentFilesBrain } from '../seams/cloudBrain.js';
import { DEFAULT_AGENT_SLUG } from '../core/tanguHome.js';
import { withKeyLock } from '../core/keyLock.js';
import {
  DEFAULT_AGENTS, builtinAgentDef, buildAgentDef, parseAgentConfig, serializeAgentConfig, isValidSlug,
  AVATAR_MIME_EXT, AVATAR_EXT_MIME, AVATAR_MAX_BYTES, KEEP_APPROVAL_MODE, AgentNotFoundError, AgentExistsError, mergeAgentPatch,
  isRetiredBuiltin, normalizeAgentsMeta, sortAgentDefs, upgradeAriosoPersona,
  type NormalAgentDef, type SaveAgentInput, type AgentsMeta, type AgentPatch,
} from './agentRegistry.js';
import { builtinAgentAvatar } from './builtinAvatars.js';

/** 云端 agents 可用 = 非 host-exec profile 且注入了 agentFiles seam(旧云端/未注入 → 路由回落 404)。 */
export function cloudAgentsEnabled(): boolean {
  const d = deps();
  return !d.profile.capabilities.hostExec && !!d.brain.agentFiles;
}

const files = (): AgentFilesBrain => deps().brain.agentFiles!;
const DEVICE_ID = 'cloud-api';

const putText = (userId: string, slug: string, relPath: string, content: string): Promise<{ mtimeMs: number }> =>
  files().putFile(userId, slug, relPath, {
    content, isBinary: false, size: Buffer.byteLength(content, 'utf8'), mtimeMs: Date.now(), deviceId: DEVICE_ID,
  });

async function readText(userId: string, slug: string, relPath: string): Promise<string | null> {
  const f = await files().getFile(userId, slug, relPath).catch(() => null);
  return f && !f.deleted && !f.isBinary && f.content != null ? f.content : null;
}

/** 云端读一个 agent。文件未命中(从未存在或已墓碑)→ **内置预设兜底**(纯内存虚拟 def):
 *  Picker 选虚拟预设后 PATCH/头像的「读现有」由此命中,显式编辑才物化落库
 *  ——绝不因为「看了一眼列表」就往用户的 Forsion AI Brain 写数据。 */
export async function cloudGetAgent(userId: string, slug: string): Promise<NormalAgentDef | null> {
  if (!slug || !isValidSlug(slug)) return null;
  const cfg = await readText(userId, slug, 'config.toml');
  if (cfg == null) return builtinAgentDef(slug);
  const soul = (await readText(userId, slug, 'SOUL.md')) ?? '';
  try {
    return upgradeAriosoPersona(parseAgentConfig(slug, cfg, soul));
  } catch {
    return null;
  }
}

/** manifest 按 config.toml 分桶:live=未墓碑(真实存在),tombstoned=墓碑过(用户删过 → 虚拟预设不复活)。
 *  哨兵 __user__/__meta__ 排除。 */
async function slugStates(userId: string): Promise<{ live: Set<string>; tombstoned: Set<string> }> {
  const manifest = await files().getManifest(userId);
  const live = new Set<string>();
  const tombstoned = new Set<string>();
  for (const a of manifest) {
    if (a.slug.startsWith('__') || !isValidSlug(a.slug)) continue;
    const cfg = a.files.find((f) => f.relPath === 'config.toml');
    if (!cfg) continue;
    (cfg.deleted ? tombstoned : live).add(a.slug);
  }
  return { live, tombstoned };
}

export async function cloudListAgents(userId: string): Promise<NormalAgentDef[]> {
  const { live, tombstoned } = await slugStates(userId);
  const defs: NormalAgentDef[] = [];
  for (const slug of live) {
    const d = await cloudGetAgent(userId, slug);
    if (d) defs.push(d);
  }
  // 缺席且没被删过的内置预设 → 合成虚拟条目(零落库;run 侧有同源 builtinAgentDef 兜底,人格照常生效)。
  for (const a of DEFAULT_AGENTS) {
    if (live.has(a.slug) || tombstoned.has(a.slug)) continue;
    const d = builtinAgentDef(a.slug);
    if (d) defs.push(d);
  }
  const meta = await cloudReadAgentsMeta(userId);
  return sortAgentDefs(defs.filter((a) => !isRetiredBuiltin(a)), meta.order);
}

// ── 写路径的串行化与「锁内现读」(与本地 agentRegistry 的 withAgentLock / writeAgentLocked 同口径)──
// 读 existing → 合并 → 落盘 之间全是 await:两次写交错时,后写的一方会用它读到的旧快照盖掉先写的一方(比如用户刚收紧的审批档);
// 删除不入队 = 保存读到 existing 之后被删、保存再把 config.toml 写回来(删了又复活)。所以同一 user+slug 的
// 保存 / 删除 / 头像读-改-写全部排进同一条进程内队(键带 userId:云端是多租户,不同用户的同名 slug 互不相干)。
// 进程外的写者(桌面 agentFileSync、另一个服务实例)进程内锁管不到 → config.toml 落盘带 CAS 票据(baseSeq),
// 锁内现读之后被别人改过/删过就拒写,绝不 LWW 盖回去;旧云端不回 seq → 回退 LWW(与今天一样)。
// SOUL.md 是独立的一行、独立的 seq:config.toml 的 CAS 管不到它。所以 ① 这次保存没改人格(def.soul 与锁内现读的一致)
// → 根本不写 SOUL.md —— 只改名字的 PATCH 不能拿现读的快照去盖另一台设备刚改的人格;② 改了人格 → 带 SOUL.md 自己的
// CAS 票据(soulSeq)写,现读之后被别人改过就报冲突,不覆盖。旧云端(无 seq)改了人格仍是 LWW,只有「没改就不写」那半生效。
// ⚠️ 锁内绝不能再调 cloudSaveAgent / cloudPatchAgent / cloudDeleteAgent / 头像两函数(同键 = 自己等自己,永久挂死)——
//    要写就调 writeLocked。

function withCloudAgentLock<T>(userId: string, slug: string, fn: () => Promise<T>): Promise<T> {
  return withKeyLock(`cloud-agent:${userId}:${slug}`, fn);
}

/** 锁内现读的结果。def=null = 该 slug 此刻不存在(已墓碑,或从未存在且不是内置预设)。
 *  baseSeq = config.toml 落盘用的 CAS 票据:live 行 → 它的 seq;无行/墓碑行 → 0(仅创建/复活);旧云端无 seq → undefined(LWW)。
 *  soulBase = 判「这次保存改没改人格」的基准(比较前两边都 trim,基准再按 buildAgentDef 的长度上限截,见 writeLocked):
 *  config.toml live 且解析成功 → def.soul(即解析 + Arioso 升级后的视图 —— 带着现读人格的保存就是没改,旧 Xyra 原文
 *  也不会因为一次改名被顺手物化);其余(虚拟预设 / 墓碑后重建 / 解析失败)→ SOUL.md 行里的原文,没有 live 文本行就是 ''
 *  (虚拟预设物化时 '' ≠ 预设人格 → 照写)。
 *  soulSeq = SOUL.md 落盘用的 CAS 票据,口径同 baseSeq,只有一处例外:config.toml 无行、SOUL.md 却有 live 行 → 0(见 readForWrite)。 */
interface LockedRead { def: NormalAgentDef | null; baseSeq: number | undefined; soulBase: string; soulSeq: number | undefined }

/** 人格长度上限,与 agentRegistry.buildAgentDef 的 `soul.slice(0, 100_000)` 同值(那边没导出,只能抄一份)。
 *  漂移由 cloudAgentStore.locking.test 的 100_050 字用例兜住:上限调高 / 调低,「没改就不写」都会失败。 */
const SOUL_MAX_CHARS = 100_000;

/** 一行的 CAS 票据:无行/墓碑行 → 0(仅创建/复活);live 行 → 它的 seq;旧云端无 seq → undefined(LWW)。 */
const casTicket = (row: AgentFileContent | null): number | undefined =>
  !row || row.deleted ? 0 : typeof row.seq === 'number' && row.seq > 0 ? row.seq : undefined;

/** 云端 agent 写冲突:锁内现读之后,file 被进程外的写者(桌面 agentFileSync / 另一个服务实例)改过或删过。
 *  message 是给调用方 / 模型看的英文原文;路由可按 instanceof + file 映射成 409 与可本地化的错误码。 */
export class CloudAgentConflictError extends Error {
  constructor(readonly slug: string, readonly file: 'config.toml' | 'SOUL.md', message: string) {
    super(message);
    this.name = 'CloudAgentConflictError';
  }
}

/** 写路径专用的现读(调用方持有该 user+slug 的锁)。与 cloudGetAgent 的两处刻意不同:
 *  ① 区分「从未落库」与「已墓碑」—— 前者按内置预设兜底(虚拟预设可编辑、编辑即物化),后者 = 用户删过 = 不存在
 *    (cloudGetAgent 对墓碑也兜底成预设,拿它判 mustExist 就会把删掉的 aria 写回来);
 *  ② 读失败直接抛,不吞成「不存在」—— 吞了就会按新建落盘,审批档落成空(跟随会话),比原来的宽。
 *  ⚠️ 已知残余窗口(CAS 票据表达不了,只能记下):「无行」与「墓碑行」都只能给 baseSeq=0,而服务端对 0 的语义是
 *  「无行插入 / 墓碑复活」(tanguAgentFilesService.putFile)。所以一个**从未物化的虚拟预设**,若在这次现读(无行)
 *  之后、config.toml 落盘之前被**进程外**写者删掉(桌面 agentFileSync / 另一个服务实例落了墓碑),这次写会把它复活。
 *  进程内的删除排在同一条队里,不受影响;live 行的删除走 baseSeq>0,CAS 能拒。要彻底堵住得服务端加一个
 *  「仅在无行时创建」的票据(比如 baseSeq=-1);客户端补一次「写后发现 seq>1 就再墓碑」不做 —— 那是第二次无 CAS 的写,
 *  把罕见的复活换成观察者能拉到的「活→删」翻转。 */
async function readForWrite(userId: string, slug: string): Promise<LockedRead> {
  const cfg = await files().getFile(userId, slug, 'config.toml');
  // SOUL.md 每条分支都读:虚拟预设物化 / 墓碑后重建也要写它,得拿到它真实的票据。
  const soulRow = await files().getFile(userId, slug, 'SOUL.md');
  const soulRaw = soulRow && !soulRow.deleted && !soulRow.isBinary && soulRow.content != null ? soulRow.content : null;
  const soul = { soulBase: soulRaw ?? '', soulSeq: casTicket(soulRow) };
  // config.toml 无行、SOUL.md 却有 live 行:云端自己从不这么落(总是先 config.toml 再 SOUL.md),只能是某台设备推了一半
  // —— 桌面 agentFileSync 一文件一请求,SOUL.md 按目录序排在 config.toml 前,推完它就断网/失败就停在这儿。那是设备上
  // 活着的人格,不是孤儿:SOUL.md 票据给 0(仅创建),这次保存若要写别的人格(虚拟预设物化 / 同名新建)就撞 EXISTS 报冲突,
  // 绝不拿它自己的 seq 把它盖掉(设备回来后按「本地=影子、远端变了」会把盖上去的人格拉回本地)。config.toml 已先落
  // = 部分保存(同 writeLocked 的 SOUL.md 冲突);此后 cloudGetAgent 读得到这份人格,再存就正常。旧云端(无 seq)照旧 LWW。
  if (!cfg) return { def: builtinAgentDef(slug), baseSeq: 0, soulBase: soul.soulBase, soulSeq: soul.soulSeq === undefined ? undefined : 0 };
  if (cfg.deleted) return { def: null, baseSeq: 0, ...soul };
  const baseSeq = typeof cfg.seq === 'number' && cfg.seq > 0 ? cfg.seq : undefined;
  if (cfg.isBinary || cfg.content == null) return { def: null, baseSeq, ...soul };
  try {
    const def = upgradeAriosoPersona(parseAgentConfig(slug, cfg.content, soulRaw ?? ''));
    return { def, baseSeq, soulBase: def.soul || '', soulSeq: soul.soulSeq };
  } catch {
    return { def: null, baseSeq, ...soul }; // 与 cloudGetAgent 同:解析失败按「读不到」
  }
}

/** CAS 冲突(httpBrain 抛 AgentFileConflictError;服务端进程内 seam 抛 status=409 + body 的 AgentFileCasConflict)。
 *  gone = 服务端此刻已无 live 行(被删了)。非冲突错误 → null。 */
function casConflictOf(e: unknown): { gone: boolean } | null {
  if (e instanceof AgentFileConflictError) return { gone: e.info.deleted || e.info.seq === 0 };
  const x = e as { status?: unknown; body?: { deleted?: unknown; seq?: unknown } } | null;
  if (x && x.status === 409 && x.body && typeof x.body === 'object') return { gone: !!x.body.deleted || Number(x.body.seq) === 0 };
  return null;
}

/** 锁内落盘(调用方持有锁、cur 是锁内现读的)。mustExist / mustNotExist 语义与本地 writeAgentLocked 一致(报错类型与原文也一致:
 *  不在 → AgentNotFoundError,路由据此回 404;已占 → AgentExistsError,POST 路由据此回 409 —— 别换成普通 Error,
 *  路由按 instanceof 分流,普通 Error 会落成 400 并把给模型看的原文回给用户)。 */
async function writeLocked(userId: string, slug: string, cur: LockedRead, input: SaveAgentInput): Promise<NormalAgentDef> {
  if (input.mustExist && !cur.def) throw new AgentNotFoundError(slug);
  if (input.mustNotExist && cur.def) throw new AgentExistsError(slug);
  const def = buildAgentDef(slug, cur.def, input);
  const content = serializeAgentConfig(def);
  try {
    await files().putFile(userId, slug, 'config.toml', {
      content, isBinary: false, size: Buffer.byteLength(content, 'utf8'), mtimeMs: Date.now(), deviceId: DEVICE_ID,
      ...(cur.baseSeq !== undefined ? { baseSeq: cur.baseSeq } : {}),
    });
  } catch (e) {
    const c = casConflictOf(e);
    if (!c) throw e;
    // 现读之后被进程外的写者改过/删过:什么都不写(SOUL.md 也不动),让调用方重来 —— 绝不把旧快照(含更宽的审批档)盖回去。
    if (c.gone) throw new AgentNotFoundError(slug);
    throw new CloudAgentConflictError(slug, 'config.toml', `agent changed concurrently: ${slug} (another device or request saved it first). Nothing was saved; reload and try again.`);
  }
  // 人格没改 → 不碰 SOUL.md(改名 / 审批档 / 头像这类保存,绝不拿现读的旧人格去盖另一台设备刚落的新人格)。
  // 基准按 buildAgentDef 同一个上限截了再比:没改的超长人格经 buildAgentDef 已被截短,拿全文比永远「改了」→ 每次改名/换头像
  // 都悄悄把用户没动过的人格截短。代价:把超长人格恰好删到前 SOUL_MAX_CHARS 字的那一次编辑会被当成「没改」(与截短结果同文)。
  const soul = def.soul || '';
  const stored = cur.soulBase.trim();
  if (soul.trim() === stored.slice(0, SOUL_MAX_CHARS).trim()) {
    // 回包给存着的那份:否则超长人格的 PATCH 回包比下一次 GET 短(看起来像被截了,实际没动)。
    return soul.trim() === stored ? def : { ...def, soul: stored };
  }
  // 改了人格 → 带 SOUL.md 自己的票据写。config.toml 排在前面、已落盘:这里冲突 = 部分保存,报错原文如实说明哪半没存。
  try {
    await files().putFile(userId, slug, 'SOUL.md', {
      content: soul, isBinary: false, size: Buffer.byteLength(soul, 'utf8'), mtimeMs: Date.now(), deviceId: DEVICE_ID,
      ...(cur.soulSeq !== undefined ? { baseSeq: cur.soulSeq } : {}),
    });
  } catch (e) {
    if (!casConflictOf(e)) throw e;
    throw new CloudAgentConflictError(slug, 'SOUL.md', `agent persona (SOUL.md) changed concurrently: ${slug} (another device or request saved it first). The other settings were saved; SOUL.md was not written and keeps the other writer's version. Reload and try again.`);
  }
  return def;
}

/** upsert 一个 agent。读-合并-写整段在该 user+slug 的锁内;input.mustExist / mustNotExist / approvalMode=KEEP_APPROVAL_MODE
 *  都按锁内现读判定(与本地 saveAgent 同口径)。 */
export async function cloudSaveAgent(userId: string, slug: string, input: SaveAgentInput): Promise<NormalAgentDef> {
  if (!isValidSlug(slug)) throw new Error('invalid slug');
  return withCloudAgentLock(userId, slug, async () => writeLocked(userId, slug, await readForWrite(userId, slug), input));
}

/** 改已有 agent(PATCH 语义),本地 patchAgent 的云端版(同一份 mergeAgentPatch,合并规则不漂移):
 *  没提交的字段(undefined)一律取**锁内现读**的值 —— 不能由调用方在锁外先读好 cur 再 mergeAgentPatch 传进来
 *  (那份快照到落盘之间用户收紧的审批档 / 并发的删除都会被盖掉、写回)。
 *  - 审批档没提交 → KEEP_APPROVAL_MODE(锁内现读现留);显式传才改(含 '' = 跟随会话,那是用户本人的选择)。
 *  - 恒 mustExist:锁内读不到(已墓碑 / 从未存在且非内置预设)→ AgentNotFoundError,绝不悄悄新建;
 *    从未物化的虚拟预设算存在(编辑即物化,同 cloudGetAgent 的兜底)。
 *  - fields 可以是函数:拿锁内现读的 cur 做守卫,抛错 = 什么都不写。 */
export async function cloudPatchAgent(
  userId: string, slug: string, fields: AgentPatch | ((cur: NormalAgentDef) => AgentPatch),
): Promise<NormalAgentDef> {
  if (!isValidSlug(slug)) throw new AgentNotFoundError(slug);
  return withCloudAgentLock(userId, slug, async () => {
    const cur = await readForWrite(userId, slug);
    if (!cur.def) throw new AgentNotFoundError(slug);
    const patch = typeof fields === 'function' ? fields(cur.def) : fields;
    return writeLocked(userId, slug, cur, {
      ...mergeAgentPatch(cur.def, patch),
      approvalMode: patch.approvalMode !== undefined ? patch.approvalMode : KEEP_APPROVAL_MODE,
      mustExist: true,
      mustNotExist: false,
    });
  });
}

/** 墓碑该 agent 的全部文件(含 MEMORY/LOG/Library)。默认 agent 禁删,与本地一致;muse 的
 *  「启用中禁删」是本地 special 配置语义,云端不适用。与保存同队:排在前面的保存先落盘再删,
 *  排在后面的 mustExist 写 / 头像操作会看到它已不在。 */
export async function cloudDeleteAgent(userId: string, slug: string): Promise<boolean> {
  if (!isValidSlug(slug) || slug === DEFAULT_AGENT_SLUG) return false;
  return withCloudAgentLock(userId, slug, async () => {
    const manifest = await files().getManifest(userId);
    const entry = manifest.find((a) => a.slug === slug);
    const t = Date.now();
    if (entry) {
      for (const f of entry.files) {
        if (f.deleted) continue;
        await files().deleteFile(userId, slug, f.relPath, t, DEVICE_ID).catch(() => { /* 单文件失败不中断 */ });
      }
      return true;
    }
    // 从未物化的虚拟预设:也要「删得掉」——落一个 config.toml 墓碑(deleteFile 对不存在行是 upsert),
    // 列表按 tombstoned 不再合成;Brain 数据页按「有未墓碑文件才显示」滤掉孤儿墓碑,不会出现空壳。
    if (DEFAULT_AGENTS.some((a) => a.slug === slug)) {
      await files().deleteFile(userId, slug, 'config.toml', t, DEVICE_ID).catch(() => { /* ignore */ });
    }
    return true;
  });
}

// ── 头像:Library/avatar.<ext> + config.avatar 引用,校验规则与本地 saveAgentAvatar 一致 ──

/** 只改头像时写回的其余字段:全部取**锁内现读**的 cur(buildAgentDef 对 description / model / tools 等是整量覆盖,
 *  省略 = 清空,所以得显式带上);审批档用 KEEP_APPROVAL_MODE —— 头像操作永远不写审批档(本地 keepAgentFields 同款)。 */
const keepAgentFields = (cur: NormalAgentDef): SaveAgentInput => ({
  slug: cur.slug, name: cur.name, description: cur.description, model: cur.model, tools: cur.tools,
  thinkingLevel: cur.thinkingLevel, maxIterations: cur.maxIterations, approvalMode: KEEP_APPROVAL_MODE,
  systemPrompt: cur.systemPrompt, soul: cur.soul, createdBy: cur.createdBy,
});

const avatarRel = (avatar: string): string => (avatar.includes('/') ? avatar : `Library/${avatar}`);

/** 写头像进 Library/avatar.<ext> 并更新 config.avatar。
 *  锁**跨过上传**持有(与本地 saveAgentAvatar 同):锁键是 user+slug,只挡同一个 agent 的其它写,不串行无关请求;
 *  反过来「先上传、再进锁读-改-写」有真实竞态 —— 排在中间的 cloudDeleteAgentAvatar 会把刚传的同名文件墓碑掉,
 *  随后 config 又指向它(头像引用一个死文件)。上传期间进程外的写者(桌面同步/别的实例)仍可能改档或删 agent,
 *  所以上传完**再现读一次**才落 config(审批档取这次现读,CAS 兜住现读到落盘的窗口);旧头像在 config 写成**之后**才墓碑,
 *  config 没写成就不会留下「引用一个已墓碑文件」的配置。 */
export async function cloudSaveAgentAvatar(userId: string, slug: string, base64: string, mimeType: string): Promise<string> {
  const ext = AVATAR_MIME_EXT[String(mimeType).toLowerCase()];
  if (!ext) throw new Error('unsupported image type (png/jpeg/gif/webp only)');
  const raw = base64.includes(',') && base64.trimStart().startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new Error('empty image');
  if (buf.length > AVATAR_MAX_BYTES) throw new Error('image too large (max 1MB)');
  if (!isValidSlug(slug)) throw new Error('agent not found');
  const filename = `avatar.${ext}`;
  const rel = `Library/${filename}`;
  return withCloudAgentLock(userId, slug, async () => {
    // 预检:已删 / 不存在就别白传 1MB。
    if (!(await readForWrite(userId, slug)).def) throw new Error('agent not found');
    await files().putFile(userId, slug, rel, {
      contentBase64: buf.toString('base64'), isBinary: true, size: buf.length, mtimeMs: Date.now(), deviceId: DEVICE_ID,
    });
    let cur: NormalAgentDef;
    try {
      const fresh = await readForWrite(userId, slug); // 上传期间可能被进程外的写者改档/删掉 → 落 config 前再现读
      if (!fresh.def) throw new Error('agent not found');
      cur = fresh.def;
      await writeLocked(userId, slug, fresh, { ...keepAgentFields(cur), avatar: filename, mustExist: true });
    } catch (e) {
      // 上传期间 agent 被删了(config.toml 已墓碑):收走刚传的头像,别在删掉的 slug 下留一个活文件(Brain 数据页会显示成空壳)。
      // 只在确认已墓碑时收(本地同款「config.toml 不在才删自己写的文件」);读不到就宁留孤儿,不删可能在用的文件。
      const cfg = await files().getFile(userId, slug, 'config.toml').catch(() => null);
      if (cfg?.deleted) await files().deleteFile(userId, slug, rel, Date.now(), DEVICE_ID).catch(() => { /* ignore */ });
      throw e;
    }
    // 旧头像扩展名不同 → 墓碑,避免 avatar.png / avatar.webp 堆积(config 已改指新文件之后才删)。
    if (cur.avatar && cur.avatar !== filename) {
      await files().deleteFile(userId, slug, avatarRel(cur.avatar), Date.now(), DEVICE_ID).catch(() => { /* ignore */ });
    }
    return filename;
  });
}

export async function cloudReadAgentAvatar(userId: string, slug: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const cur = await cloudGetAgent(userId, slug);
  if (!cur?.avatar) return null;
  const rel = cur.avatar.includes('/') ? cur.avatar : `Library/${cur.avatar}`;
  const f = await files().getFile(userId, slug, rel).catch(() => null);
  // 虚拟内置头像零落库;显式删除后的墓碑或空 avatar 不回退。
  if (!f && cur.avatar === 'avatar.jpg') return builtinAgentAvatar(slug);
  if (!f || f.deleted || !f.isBinary || !f.contentBase64) return null;
  const ext = (cur.avatar.split('.').pop() || '').toLowerCase();
  return { data: Buffer.from(f.contentBase64, 'base64'), mimeType: AVATAR_EXT_MIME[ext] || 'application/octet-stream' };
}

/** 删除头像:清空 config.avatar(其余字段取锁内现读、审批档 KEEP),config 写成之后再墓碑头像文件。 */
export async function cloudDeleteAgentAvatar(userId: string, slug: string): Promise<boolean> {
  if (!isValidSlug(slug)) throw new Error('agent not found');
  return withCloudAgentLock(userId, slug, async () => {
    const cur = await readForWrite(userId, slug);
    if (!cur.def) throw new Error('agent not found');
    const old = cur.def.avatar;
    await writeLocked(userId, slug, cur, { ...keepAgentFields(cur.def), avatar: '', mustExist: true });
    if (old) await files().deleteFile(userId, slug, avatarRel(old), Date.now(), DEVICE_ID).catch(() => { /* ignore */ });
    return true;
  });
}

// ── 全局 meta(列表顺序 + 默认 agent):哨兵 __meta__/.meta.json。桌面 agentFileSync 同步同一份
//   → defaultSlug / 顺序跨端共享,LWW 由 putFile 的 mtimeMs 守卫。──

export async function cloudReadAgentsMeta(userId: string): Promise<AgentsMeta> {
  try {
    const raw = await readText(userId, '__meta__', '.meta.json');
    if (raw == null) return { order: [], defaultSlug: DEFAULT_AGENT_SLUG };
    const m = JSON.parse(raw);
    return normalizeAgentsMeta(m);
  } catch {
    return { order: [], defaultSlug: DEFAULT_AGENT_SLUG };
  }
}

export async function cloudWriteAgentsMeta(userId: string, patch: Partial<AgentsMeta>): Promise<AgentsMeta> {
  const cur = await cloudReadAgentsMeta(userId);
  const next = normalizeAgentsMeta({
    order: Array.isArray(patch.order) ? patch.order.filter((s) => typeof s === 'string' && isValidSlug(s)) : cur.order,
    defaultSlug: patch.defaultSlug != null && isValidSlug(patch.defaultSlug) ? patch.defaultSlug : cur.defaultSlug,
  });
  await putText(userId, '__meta__', '.meta.json', JSON.stringify(next, null, 2));
  return next;
}
