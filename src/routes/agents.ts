/**
 * Normal Agent CRUD（本地 ~/.tangu/agents/<slug>.md）。handler 自带 authMiddleware。
 *   GET    /agent/agents                列出全部本地 agent 定义
 *   POST   /agent/agents { name, systemPrompt, ... }   新建（slug 由 name 派生或显式给）
 *   PATCH  /agent/agents/:slug          更新
 *   DELETE /agent/agents/:slug          删除
 *
 * **本地特性**：仅 standalone/TUI/desktop（profile.capabilities.hostExec=true）暴露；云端多租户
 * 形态(hostExec=false) 一律 404，避免共享进程级 agents 目录跨用户串写。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { listAgents, getAgent, saveAgent, deleteAgent, saveAgentAvatar, readAgentAvatar, deleteAgentAvatar, readAgentsMeta, writeAgentsMeta, resolveMemorySlug, listLibraryFiles, readLibraryFile, writeLibraryFile, deleteLibraryFile, MUSE_AGENT_SLUG, slugify, isValidSlug } from '../agents/agentRegistry.js';
import path from 'node:path';
import { agentsDir, readUserMd, writeUserMd } from '../core/tanguHome.js';
import { createLocalMemoryStore } from '../adapters/standalone/localMemoryBrain.js';

const router = Router();

/** 本地闸门：非 host-exec profile（云端）一律拒绝。 */
function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: 'Normal Agents 仅在本地（桌面/TUI）可用' });
    return false;
  }
  return true;
}

router.get('/agent/agents', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ agents: await listAgents() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list agents failed' });
  }
});

router.post('/agent/agents', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (!b.name || !b.systemPrompt) return res.status(400).json({ detail: 'name 与 systemPrompt 必填' });
    // POST=新建语义,但 saveAgent 是按 slug 的 upsert:派生 slug 已存在时若直接传入会**静默覆盖**
    // 既有 agent(中文等非 ASCII 名全部派生为兜底 'agent',极易相撞)→ 这里先唯一化,撞了递增后缀。
    // 想更新请走 PATCH /agent/agents/:slug。
    let slug = typeof b.slug === 'string' && isValidSlug(b.slug) ? b.slug : slugify(String(b.name));
    if (await getAgent(slug)) {
      const base = slug.slice(0, 60);
      let n = 2;
      while (await getAgent(`${base}-${n}`)) n++;
      slug = `${base}-${n}`;
    }
    const agent = await saveAgent({
      slug,
      name: String(b.name),
      description: b.description,
      model: b.model,
      tools: Array.isArray(b.tools) ? b.tools : undefined,
      thinkingLevel: b.thinkingLevel,
      maxIterations: b.maxIterations,
      approvalMode: b.approvalMode,
      systemPrompt: String(b.systemPrompt),
      soul: b.soul != null ? String(b.soul) : undefined,
      shareDefaultMemory: b.shareDefaultMemory != null ? !!b.shareDefaultMemory : undefined,
      cloudSync: b.cloudSync != null ? !!b.cloudSync : undefined,
      createdBy: 'user',
    });
    res.json({ agent });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'create agent failed' });
  }
});

router.patch('/agent/agents/:slug', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const slug = req.params.slug;
    const cur = await getAgent(slug);
    if (!cur) return res.status(404).json({ detail: 'Agent not found' });
    const b = req.body || {};
    const agent = await saveAgent({
      slug,
      name: b.name != null ? String(b.name) : cur.name,
      description: b.description != null ? b.description : cur.description,
      model: b.model != null ? b.model : cur.model,
      tools: Array.isArray(b.tools) ? b.tools : cur.tools,
      thinkingLevel: b.thinkingLevel != null ? b.thinkingLevel : cur.thinkingLevel,
      maxIterations: b.maxIterations !== undefined ? b.maxIterations : cur.maxIterations,
      approvalMode: b.approvalMode != null ? b.approvalMode : cur.approvalMode,
      systemPrompt: b.systemPrompt != null ? String(b.systemPrompt) : cur.systemPrompt,
      soul: b.soul != null ? String(b.soul) : cur.soul,
      shareDefaultMemory: b.shareDefaultMemory != null ? !!b.shareDefaultMemory : cur.shareDefaultMemory,
      cloudSync: b.cloudSync != null ? !!b.cloudSync : cur.cloudSync,
    });
    res.json({ agent });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'update agent failed' });
  }
});

router.delete('/agent/agents/:slug', authMiddleware, async (req: AuthRequest, res) => {
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

// 头像:base64 上传(≤1MB,写进该 agent 的 Library/ 并由 config.avatar 引用)/ 二进制读取。
router.post('/agent/agents/:slug/avatar', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const b = req.body || {};
    if (!b.data || !b.mimeType) return res.status(400).json({ detail: 'data 与 mimeType 必填' });
    const avatar = await saveAgentAvatar(req.params.slug, String(b.data), String(b.mimeType));
    res.json({ ok: true, avatar });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'upload avatar failed' });
  }
});

router.get('/agent/agents/:slug/avatar', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const av = await readAgentAvatar(req.params.slug);
    if (!av) return res.status(404).json({ detail: 'no avatar' });
    res.setHeader('Content-Type', av.mimeType);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(av.data);
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read avatar failed' });
  }
});

router.delete('/agent/agents/:slug/avatar', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    await deleteAgentAvatar(req.params.slug);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'delete avatar failed' });
  }
});

// 列表顺序 + 默认 agent(.meta.json)。
router.get('/agent/agents-meta', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json(readAgentsMeta());
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read meta failed' });
  }
});

router.put('/agent/agents-meta', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const b = req.body || {};
    res.json(await writeAgentsMeta({ order: b.order, defaultSlug: b.defaultSlug }));
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'update meta failed' });
  }
});

// 某 agent 的 MEMORY/LOG。按 resolveMemorySlug 解析作用域(共用默认的 agent → 读写默认 agent 文件夹,
// 与写入端 agentLoop/subAgent 的 resolveMemorySlug 一致),保证面板看到的就是该 agent 真正读写的那份。
async function storeForAgent(slug: string): Promise<ReturnType<typeof createLocalMemoryStore> | null> {
  const def = await getAgent(slug);
  if (!def) return null;
  return createLocalMemoryStore(path.join(agentsDir(), resolveMemorySlug(def)));
}

router.get('/agent/agents/:slug/memory', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    res.json({ content: store.readMemory() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read memory failed' });
  }
});

router.put('/agent/agents/:slug/memory', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    store.writeMemory(String(req.body?.content ?? ''));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'write memory failed' });
  }
});

router.get('/agent/agents/:slug/logs', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const store = await storeForAgent(req.params.slug);
    if (!store) return res.status(404).json({ detail: 'Agent not found' });
    res.json({ dates: store.listLogDates() });
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
    res.json({ date, content: date ? store.readLog(date) : '' });
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
    store.writeLog(date, String(req.body?.content ?? ''));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'write log failed' });
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
