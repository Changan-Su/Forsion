/**
 * Normal Agent CRUD。handler 自带 authMiddleware。
 *   GET    /agent/agents                列出全部 agent 定义
 *   POST   /agent/agents { name, systemPrompt, ... }   新建（slug 由 name 派生或显式给）
 *   PATCH  /agent/agents/:slug          更新(只改提交了的字段;按 slug 串行化、被并发删掉 → 404)
 *   DELETE /agent/agents/:slug          删除
 *
 * 存储按 profile 分流：本地（hostExec=true）= 进程级 ~/.tangu/agents 文件夹（agentRegistry）；
 * 云端多租户（hostExec=false 且注入了 brain.agentFiles）= per-user tangu_agent_files（cloudAgentStore，
 * 定义 CRUD / 头像 / meta 已云端化，web 新会话选 agent 靠它）。memory/log/library/user-profile 仍是
 * 本地文件特性（云端等价物是 brain.memory 另一套语义），云端继续 404。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { listAgents, getAgent, saveAgent, patchAgent, AgentNotFoundError, AgentExistsError, type AgentPatch, deleteAgent, saveAgentAvatar, readAgentAvatar, deleteAgentAvatar, readAgentsMeta, writeAgentsMeta, resolveMemorySlug, listLibraryFiles, readLibraryFile, writeLibraryFile, deleteLibraryFile, MUSE_AGENT_SLUG, slugify, isValidSlug, AGENT_MAX_ITERATIONS_MIN } from '../agents/agentRegistry.js';
import {
  cloudAgentsEnabled, cloudListAgents, cloudGetAgent, cloudSaveAgent, cloudPatchAgent, cloudDeleteAgent,
  cloudSaveAgentAvatar, cloudReadAgentAvatar, cloudDeleteAgentAvatar, cloudReadAgentsMeta, cloudWriteAgentsMeta,
} from '../agents/cloudAgentStore.js';
import path from 'node:path';
import { agentsDir, readUserMd, writeUserMd } from '../core/tanguHome.js';
import { listLoadoutTools } from '../tools/toolRegistry.js';
import { createMemoryRepository, MemoryRepositoryError } from '../services/memoryRepository.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';
import { scheduleAgentFilesSync } from '../services/agentFileSync.js';
import { agentSyncPermission, agentSyncScope, setAgentSyncPermission } from '../services/cloudSyncAccount.js';
import { loadHarness, readJournal, applyHarnessEdit, peekHarnessCandidates } from '../agents/harnessStore.js';
import { renameAgent, AgentRenameError } from '../agents/agentRename.js';

const router = Router();

/** 本地闸门：非 host-exec profile（云端）拒绝。定义 CRUD/头像/meta 在各 handler 里先走
 *  cloudAgentsEnabled() 云端分支,到这说明是旧云端(未注入 agentFiles)或本地深特性 → 404。 */
function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: 'Normal Agents 仅在本地（桌面/TUI）可用' });
    return false;
  }
  return true;
}

router.get('/agent/agents', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (cloudAgentsEnabled()) return void res.json({ agents: await cloudListAgents(req.user!.userId) });
    if (!ensureLocal(res)) return;
    const scope = agentSyncScope(deps().brain.agentFiles, req.user!.userId);
    res.json({ agents: (await listAgents()).map((a) => ({ ...a, cloudSync: agentSyncPermission(a.slug, scope).enabled })) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list agents failed' });
  }
});

/** 工具目录:agent 编辑 UI「工具黑白名单」的可勾选项(=名单能约束的无门禁内置工具)。
 *  纯静态内存注册表,无本地依赖 → 全模式放行。 */
router.get('/agent/tool-catalog', authMiddleware, (_req: AuthRequest, res) => {
  res.json({ tools: listLoadoutTools() });
});

router.post('/agent/agents', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (!b.name || !b.systemPrompt) return res.status(400).json({ detail: 'name 与 systemPrompt 必填' });
    const uid = req.user!.userId;
    const scope = cloud ? null : agentSyncScope(deps().brain.agentFiles, uid);
    if (!cloud && b.cloudSync && !scope) return res.status(400).json({ detail: 'Sign in to a Forsion account before enabling cloud sync' });
    const getDef = (s: string): Promise<unknown> => (cloud ? cloudGetAgent(uid, s) : getAgent(s));
    // POST=新建语义,但 saveAgent 是按 slug 的 upsert:派生 slug 已存在时若直接传入会**静默覆盖**
    // 既有 agent(中文等非 ASCII 名全部派生为兜底 'agent',极易相撞)→ 这里先唯一化,撞了递增后缀。
    // 想更新请走 PATCH /agent/agents/:slug。
    let slug = typeof b.slug === 'string' && isValidSlug(b.slug) ? b.slug : slugify(String(b.name));
    if (await getDef(slug)) {
      const base = slug.slice(0, 60);
      let n = 2;
      while (await getDef(`${base}-${n}`)) n++;
      slug = `${base}-${n}`;
    }
    // Agent 级轮数下限(与 agentActivation / manage_agent 同口径):低于下限显式 400,别让 buildAgentDef 静默清空。
    if (Number(b.maxIterations) > 0 && Number(b.maxIterations) < AGENT_MAX_ITERATIONS_MIN) return res.status(400).json({ detail: `max_iterations must be at least ${AGENT_MAX_ITERATIONS_MIN}` });
    const input = {
      slug,
      name: String(b.name),
      description: b.description,
      model: b.model,
      tools: Array.isArray(b.tools) ? b.tools : undefined,
      enabledSkillIds: Array.isArray(b.enabledSkillIds) ? b.enabledSkillIds : undefined,
      enabledMcpServers: Array.isArray(b.enabledMcpServers) ? b.enabledMcpServers : undefined,
      thinkingLevel: b.thinkingLevel,
      maxIterations: b.maxIterations,
      approvalMode: b.approvalMode,
      systemPrompt: String(b.systemPrompt),
      soul: b.soul != null ? String(b.soul) : undefined,
      shareDefaultMemory: b.shareDefaultMemory != null ? !!b.shareDefaultMemory : undefined,
      cloudSync: b.cloudSync != null ? !!b.cloudSync : undefined,
      activityAccess: b.activityAccess != null ? !!b.activityAccess : undefined,
      toolsMode: b.toolsMode !== undefined ? b.toolsMode : undefined,
      toolsList: b.toolsList !== undefined ? b.toolsList : undefined,
      createdBy: 'user' as const,
      // 上面的唯一化是锁外预读:查完到落盘之间冒出同 slug 的(连点两次提交 / manage_agent create 同名)→ 锁内现读报错、
      // 什么都不写(回 409),不把刚建好的那个连同它的审批档悄悄盖掉。
      mustNotExist: true,
    };
    const agent = cloud ? await cloudSaveAgent(uid, slug, input) : await saveAgent(input);
    if (!cloud && scope && (b.cloudSync != null || b.shareDefaultMemory != null)) {
      const enabled = b.cloudSync != null ? !!b.cloudSync : agentSyncPermission(slug, scope).enabled;
      setAgentSyncPermission(slug, scope, enabled, agent.shareDefaultMemory === true);
    }
    if (!cloud) agent.cloudSync = agentSyncPermission(slug, scope).enabled;
    res.json({ agent });
  } catch (e: any) {
    if (e instanceof AgentExistsError) return void res.status(409).json({ detail: 'An agent with this slug was just created. Nothing was saved; reload and try again.' });
    res.status(400).json({ detail: e?.message || 'create agent failed' });
  }
});

router.patch('/agent/agents/:slug', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    const slug = req.params.slug;
    // 预读:不存在 → 404 先于下面的 400 校验(旧行为)。合并**不用**它 —— 见下面的 patchAgent / cloudPatchAgent。
    const cur = cloud ? await cloudGetAgent(req.user!.userId, slug) : await getAgent(slug);
    if (!cur) return res.status(404).json({ detail: 'Agent not found' });
    const b = req.body || {};
    const scope = cloud ? null : agentSyncScope(deps().brain.agentFiles, req.user!.userId);
    if (!cloud && b.cloudSync && !scope) return res.status(400).json({ detail: 'Sign in to a Forsion account before enabling cloud sync' });
    if (Number(b.maxIterations) > 0 && Number(b.maxIterations) < AGENT_MAX_ITERATIONS_MIN) return res.status(400).json({ detail: `max_iterations must be at least ${AGENT_MAX_ITERATIONS_MIN}` });
    // 只放**提交了的**字段(undefined = 未提交 → 保留现值)。「算不算提交」逐字段沿用旧口径:
    // name / description / model / thinkingLevel / approvalMode / systemPrompt / soul 与三个开关按 != null(传 null = 没提交);
    // maxIterations / toolsMode / toolsList 按 !== undefined(null = 显式清除);两份名单 null 或数组才算;
    // 本地 cloudSync 只能经这里打开(旧口径 `!!b.cloudSync || cur.cloudSync`),关同步走同步权限那条。
    const fields: AgentPatch = {
      name: b.name != null ? String(b.name) : undefined,
      description: b.description != null ? b.description : undefined,
      model: b.model != null ? b.model : undefined,
      tools: Array.isArray(b.tools) ? b.tools : undefined,
      enabledSkillIds: b.enabledSkillIds === null || Array.isArray(b.enabledSkillIds) ? b.enabledSkillIds : undefined,
      enabledMcpServers: b.enabledMcpServers === null || Array.isArray(b.enabledMcpServers) ? b.enabledMcpServers : undefined,
      thinkingLevel: b.thinkingLevel != null ? b.thinkingLevel : undefined,
      maxIterations: b.maxIterations,
      // 设置页就是用户改审批档的地方:提交了就照写(可收紧也可放宽,这是用户本人);没提交 → patchAgent 锁内现读现留。
      approvalMode: b.approvalMode != null ? b.approvalMode : undefined,
      systemPrompt: b.systemPrompt != null ? String(b.systemPrompt) : undefined,
      soul: b.soul != null ? String(b.soul) : undefined,
      shareDefaultMemory: b.shareDefaultMemory != null ? !!b.shareDefaultMemory : undefined,
      cloudSync: cloud ? (b.cloudSync != null ? !!b.cloudSync : undefined) : (b.cloudSync ? true : undefined),
      activityAccess: b.activityAccess != null ? !!b.activityAccess : undefined,
      // null=显式清除(saveAgent 收 null → undefined 落盘);缺省保留现值
      toolsMode: b.toolsMode,
      toolsList: b.toolsList,
    };
    // 本地 patchAgent / 云端 cloudPatchAgent 同一口径:在按 slug(云端按 user+slug)串行化的保存里现读 cur、只改提交了的字段、
    // 审批档没提交就 KEEP、恒 mustExist。旧口径用上面锁外预读的 cur 补齐全部未提交字段(含审批档)再整份保存 ——
    // 并发的用户收紧(另一个窗口 / 另一台设备)被这份旧快照盖回去;并发的 DELETE 被这次保存建回来(复活)。
    // 现在被删了 → AgentNotFoundError → 404(云端墓碑过的预设也算删了:预读按预设兜底放行,锁内现读认墓碑)。
    const agent = cloud ? await cloudPatchAgent(req.user!.userId, slug, fields) : await patchAgent(slug, fields);
    if (!cloud && scope && (b.cloudSync != null || b.shareDefaultMemory != null)) {
      const enabled = b.cloudSync != null ? !!b.cloudSync : agentSyncPermission(slug, scope).enabled;
      setAgentSyncPermission(slug, scope, enabled, agent.shareDefaultMemory === true);
    }
    if (!cloud) agent.cloudSync = agentSyncPermission(slug, scope).enabled;
    res.json({ agent });
  } catch (e: any) {
    if (e instanceof AgentNotFoundError) return void res.status(404).json({ detail: 'Agent not found' });
    res.status(400).json({ detail: e?.message || 'update agent failed' });
  }
});

router.delete('/agent/agents/:slug', authMiddleware, async (req: AuthRequest, res) => {
  if (cloudAgentsEnabled()) {
    try {
      return void res.json({ ok: await cloudDeleteAgent(req.user!.userId, req.params.slug) });
    } catch (e: any) {
      return void res.status(500).json({ detail: e?.message || 'delete agent failed' });
    }
  }
  if (!ensureLocal(res)) return;
  try {
    const ok = await deleteAgent(req.params.slug);
    if (!ok && req.params.slug === MUSE_AGENT_SLUG) {
      return res.status(400).json({ detail: 'Muse 正在启用中,请先在 设置·后台智能体 关闭 Muse 再删除' });
    }
    res.json({ ok });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete agent failed' });
  }
});

/** 改 slug(= 文件夹名)。只对本地、用户自建、从未云同步、非插件播种的 agent 开放,拒绝原因见 body.error(agentRename.ts 的 code;桌面 request() 按 error 字段本地化)。 */
router.post('/agent/agents/:slug/rename', authMiddleware, async (req: AuthRequest, res) => {
  if (cloudAgentsEnabled()) return res.status(400).json({ detail: 'Renaming is not available for cloud agents', error: 'cloud_agents' });
  if (!ensureLocal(res)) return;
  try {
    const { agent, warnings } = await renameAgent(req.params.slug, String(req.body?.slug || ''));
    res.json({ agent, warnings });
  } catch (e: any) {
    if (e instanceof AgentRenameError) return res.status(e.status).json({ detail: e.message, error: e.code });
    res.status(500).json({ detail: e?.message || 'rename agent failed' });
  }
});

// 头像:base64 上传(≤1MB,写进该 agent 的 Library/ 并由 config.avatar 引用)/ 二进制读取。
router.post('/agent/agents/:slug/avatar', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (!b.data || !b.mimeType) return res.status(400).json({ detail: 'data 与 mimeType 必填' });
    const avatar = cloud
      ? await cloudSaveAgentAvatar(req.user!.userId, req.params.slug, String(b.data), String(b.mimeType))
      : await saveAgentAvatar(req.params.slug, String(b.data), String(b.mimeType));
    res.json({ ok: true, avatar });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'upload avatar failed' });
  }
});

router.get('/agent/agents/:slug/avatar', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    const av = cloud ? await cloudReadAgentAvatar(req.user!.userId, req.params.slug) : await readAgentAvatar(req.params.slug);
    if (!av) return res.status(404).json({ detail: 'no avatar' });
    res.setHeader('Content-Type', av.mimeType);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(av.data);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read avatar failed' });
  }
});

router.delete('/agent/agents/:slug/avatar', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    if (cloud) await cloudDeleteAgentAvatar(req.user!.userId, req.params.slug);
    else await deleteAgentAvatar(req.params.slug);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'delete avatar failed' });
  }
});

// 列表顺序 + 默认 agent(.meta.json;云端=哨兵 __meta__,桌面同步同一份 → 默认 agent 跨端共享)。
router.get('/agent/agents-meta', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    res.json(cloud ? await cloudReadAgentsMeta(req.user!.userId) : readAgentsMeta());
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read meta failed' });
  }
});

router.put('/agent/agents-meta', authMiddleware, async (req: AuthRequest, res) => {
  const cloud = cloudAgentsEnabled();
  if (!cloud && !ensureLocal(res)) return;
  try {
    const b = req.body || {};
    res.json(cloud
      ? await cloudWriteAgentsMeta(req.user!.userId, { order: b.order, defaultSlug: b.defaultSlug })
      : await writeAgentsMeta({ order: b.order, defaultSlug: b.defaultSlug }));
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'update meta failed' });
  }
});

// 某 agent 的 MEMORY/LOG。按 resolveMemorySlug 解析作用域(共用默认的 agent → 读写默认 agent 文件夹,
// 与写入端 agentLoop/subAgent 的 resolveMemorySlug 一致),保证面板看到的就是该 agent 真正读写的那份。
async function storeForAgent(slug: string): Promise<ReturnType<typeof createLocalMemoryStore> | null> {
  if (!isValidSlug(slug)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid agent slug.');
  const def = await getAgent(slug);
  if (!def) return null;
  const memorySlug = resolveMemorySlug(def);
  if (!isValidSlug(memorySlug)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid memory scope.');
  return createLocalMemoryStore(path.join(agentsDir(), resolveMemorySlug(def)));
}

router.get('/agent/agents/:slug/memory', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    res.json(createMemoryRepository(store.baseDir).snapshot());
    // 后台拉一次云端(不阻塞响应):云端 worker 侧写的新记忆迟一拍到位,重开视图即最新。
    scheduleAgentFilesSync(req.user!.userId);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read memory failed' });
  }
});

router.put('/agent/agents/:slug/memory', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    if (typeof req.body?.expectedVersion !== 'string') return res.status(428).json({ detail: 'expectedVersion is required; reload memory before saving.' });
    if (typeof req.body?.content !== 'string') return res.status(400).json({ detail: 'content must be a string' });
    res.json(createMemoryRepository(store.baseDir).commit({ expectedVersion: req.body.expectedVersion, content: req.body.content, source: { kind: 'manual' } }));
  } catch (e: any) {
    res.status(e?.code === 'MEMORY_VERSION_CONFLICT' ? 409 : 400).json({ detail: e?.message || 'write memory failed', code: e?.code });
  }
});

router.get('/agent/agents/:slug/memory/revisions', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    res.json({ revisions: createMemoryRepository(store.baseDir).revisions() });
  } catch (e: any) { res.status(400).json({ detail: e?.message, code: e?.code }); }
});

router.post('/agent/agents/:slug/memory/restore', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    if (typeof req.body?.expectedVersion !== 'string') return res.status(428).json({ detail: 'expectedVersion is required' });
    res.json(createMemoryRepository(store.baseDir).restore(String(req.body?.version ?? ''), req.body.expectedVersion));
  } catch (e: any) { res.status(e?.code === 'MEMORY_VERSION_CONFLICT' ? 409 : 400).json({ detail: e?.message, code: e?.code }); }
});

router.post('/agent/agents/:slug/memory/entries', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    const { action, id, fact, expectedVersion } = req.body ?? {};
    if (!['add', 'update', 'forget'].includes(action)) return res.status(400).json({ detail: 'Invalid action' });
    if (typeof expectedVersion !== 'string') return res.status(428).json({ detail: 'expectedVersion is required' });
    res.json(createMemoryRepository(store.baseDir).mutate({ action, id, fact, expectedVersion, source: { kind: 'manual' } }));
  } catch (e: any) { res.status(e?.code === 'MEMORY_VERSION_CONFLICT' ? 409 : 400).json({ detail: e?.message, code: e?.code }); }
});

router.get('/agent/agents/:slug/logs', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    res.json({ dates: store.listLogDates() });
    scheduleAgentFilesSync(req.user!.userId); // 同 memory:后台拉云端新日志

  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list logs failed' });
  }
});

router.get('/agent/agents/:slug/log', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    const date = String(req.query.date || '');
    res.json(date ? { date, ...store.readLogSnapshot!(date) } : { date, content: '', version: null });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read log failed' });
  }
});

// 覆写某日日志正文(设置面板可编辑)。ponytail: 直写本地 LOG/<date>.md;cloudSync agent 下次同步走块合并
router.put('/agent/agents/:slug/log', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    const date = String(req.query.date || '');
    if (!date) return res.status(400).json({ detail: 'date 必填' });
    if (typeof req.body?.expectedVersion !== 'string') return res.status(428).json({ detail: 'expectedVersion is required; reload the log before saving.' });
    store.writeLog(date, String(req.body?.content ?? ''), req.body.expectedVersion);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(e?.code === 'MEMORY_VERSION_CONFLICT' ? 409 : 400).json({ detail: e?.message || 'write log failed', code: e?.code });
  }
});

// ── Library 文件:列表 / 读 / 写 / 删(用 agent 自身 slug,非 resolveMemorySlug)。──
router.get('/agent/agents/:slug/library', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!(await getAgent(req.params.slug))) return res.status(404).json({ detail: 'Agent not found' });
    res.json({ files: await listLibraryFiles(req.params.slug) });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list library failed' });
  }
});

router.get('/agent/agents/:slug/library/file', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const f = await readLibraryFile(req.params.slug, String(req.query.name || ''));
    if (!f) return res.status(404).json({ detail: 'file not found' });
    res.json(f);
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'read library file failed' });
  }
});

router.post('/agent/agents/:slug/library/file', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!(await getAgent(req.params.slug))) return res.status(404).json({ detail: 'Agent not found' });
    const b = req.body || {};
    const r = await writeLibraryFile(req.params.slug, String(b.name || ''), { content: b.content, dataBase64: b.dataBase64, isBinary: !!b.isBinary });
    res.json({ ok: true, name: r.name });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'write library file failed' });
  }
});

router.delete('/agent/agents/:slug/library/file', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    await deleteLibraryFile(req.params.slug, String(req.query.name || ''));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'delete library file failed' });
  }
});

// ── 工作笔记进化史(P2):当前 HARNESS 条目 + 本机编辑史(journal 是 dot-file 不同步,设备本地视角)。
router.get('/agent/agents/:slug/harness', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!(await getAgent(req.params.slug))) return res.status(404).json({ detail: 'Agent not found' });
    // journal 只回尾部 200 行:文件按次追加无上限,整份回传/渲染会随年头无界增长(Codex 评审 Minor)。
    // candidates = Historian 自动档提名的待复盘候选(收件箱原始行,只读不消费;/refine 才取走)——面板上要能看见「有东西等着复盘」。
    const slug = req.params.slug;
    const [entries, journal, candidates] = await Promise.all([loadHarness(slug), readJournal(slug), peekHarnessCandidates(slug).catch(() => [])]);
    res.json({ entries, journal: journal.slice(-200), candidates });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read harness failed' });
  }
});

// 条目级回滚(恢复该条上一次改动前的状态;走 applyHarnessEdit 唯一写点,journal 照常留快照)。
router.post('/agent/agents/:slug/harness/rollback', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    if (!(await getAgent(req.params.slug))) return res.status(404).json({ detail: 'Agent not found' });
    const { entry } = await applyHarnessEdit(req.params.slug, { action: 'rollback', id: String(req.body?.id || '') });
    res.json({ ok: true, entry });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'rollback failed' }); // 「没有可回滚历史/会超上限」等业务错误原样回给 UI
  }
});

// 全局用户画像 USER.md。
router.get('/agent/user-profile', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ content: readUserMd() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read user profile failed' });
  }
});

router.put('/agent/user-profile', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    writeUserMd(String(req.body?.content ?? ''));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'write user profile failed' });
  }
});

export default router;
