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
import { listAgents, getAgent, saveAgent, deleteAgent } from '../agents/agentRegistry.js';

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
    const agent = await saveAgent({
      slug: typeof b.slug === 'string' ? b.slug : undefined,
      name: String(b.name),
      description: b.description,
      model: b.model,
      tools: Array.isArray(b.tools) ? b.tools : undefined,
      thinkingLevel: b.thinkingLevel,
      maxIterations: b.maxIterations,
      approvalMode: b.approvalMode,
      systemPrompt: String(b.systemPrompt),
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
    res.json({ ok });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete agent failed' });
  }
});

export default router;
