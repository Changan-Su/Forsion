/**
 * 技能 / 工具目录(桌面技能·工具面板;handler 自带 authMiddleware)。
 *   GET /agent/skills → { skills: [{ id, name, description, icon?, category? }] }
 *       brain.assets.listSkills 未实现(旧版云端)/上游 404 → 空列表优雅降级。
 *   GET /agent/tools  → { builtins: [{ name, description, mode }], custom: [{ id, name, description, executor }],
 *                         mcp: [{ server, transport, status, error, tools }] }
 *       builtins = 本 profile 在 sandbox/host 两种形态下可见工具的并集(mode 标注归属);
 *       mcp 仅 standalone/TUI(deps().mcp 装配了才有内容,云端恒 [])。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { resolveTools } from '../tools/toolRegistry.js';
import type { ToolContext } from '../tools/toolTypes.js';

const router = Router();

router.get('/agent/skills', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const listSkills = deps().brain.assets.listSkills;
    let skills: any[] = [];
    if (listSkills) {
      // forUser:进程内实现按其过滤(全局 ∪ 本人上传);httpBrain 由 token 隐含、忽略该字段。
      skills = (await listSkills({ visibleOnly: true, forUser: req.user!.userId }).catch(() => [])) || [];
    }
    res.json({
      skills: skills.map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description || '',
        icon: s.icon || null,
        category: s.category || null,
        // 'local'=磁盘技能(包内置/~/.tangu/skills,localAssets overlay 标注);缺省 cloud
        source: s.source || 'cloud',
      })),
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list skills failed' });
  }
});

// 本地技能上云:把 local:<id> 技能上传为「本人云端技能」(brain.assets.upsertUserSkill,owner 隔离)。
// 之后云端 Tangu(worker/microserver)session 的技能列表即出现该技能,use_skill 可用。
router.post('/agent/skills/upload', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const localId = String(req.body?.localId ?? '').trim();
    if (!localId.startsWith('local:')) return res.status(400).json({ detail: 'localId 须为 local: 前缀的本地技能 id' });
    const upsert = deps().brain.assets.upsertUserSkill;
    if (!upsert) return res.status(501).json({ detail: '当前 brain 不支持用户技能上传' });
    const s = await deps().brain.assets.getSkill(localId);
    if (!s?.content) return res.status(404).json({ detail: `本地技能不存在或无正文: ${localId}` });
    const r = await upsert(req.user!.userId, {
      name: s.name,
      description: s.description || undefined,
      content: s.content,
      category: s.category || undefined,
      icon: s.icon || undefined,
    });
    res.json({ id: r.id, name: s.name });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'upload skill failed' });
  }
});

// 删除本人上传的云端技能。
router.delete('/agent/skills/user/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const del = deps().brain.assets.deleteUserSkill;
    if (!del) return res.status(501).json({ detail: '当前 brain 不支持删除用户技能' });
    const ok = await del(req.user!.userId, String(req.params.id));
    if (!ok) return res.status(404).json({ detail: 'skill not found' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'delete skill failed' });
  }
});

router.get('/agent/tools', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const profile = deps().profile;
    const userId = req.user!.userId;

    // 内置:sandbox 与 host 两形态可见集的并集(host 集仅 hostExec profile 非空)。
    const seen = new Map<string, { name: string; description: string; mode: string }>();
    for (const execMode of ['sandbox', 'host'] as const) {
      const ctx: ToolContext = { userId, sessionId: '__list__', appId: profile.appId, execMode, profile };
      for (const [name, t] of resolveTools(profile, ctx)) {
        if (!seen.has(name)) {
          seen.set(name, { name, description: t.definition.function.description || '', mode: t.mode || 'both' });
        }
      }
    }

    let custom: any[] = [];
    try {
      custom = (await deps().brain.assets.listCustomTools({ appId: profile.appId, visibleOnly: true })) || [];
    } catch {
      custom = [];
    }

    // MCP 分区(仅 standalone/TUI 装配了 deps().mcp;server 状态 + 各 server 工具)
    const mcpManager = deps().mcp;
    const mcp = mcpManager
      ? mcpManager.listStatus().map((s) => ({
          server: s.name,
          transport: s.transport,
          status: s.status,
          error: s.error || null,
          tools: [...mcpManager.toolsForRun([s.name]).values()].map((t) => ({
            name: t.name,
            description: t.definition.function.description || '',
          })),
        }))
      : [];

    res.json({
      builtins: [...seen.values()],
      custom: custom.map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description || '',
        executor: t.executor || 'http',
      })),
      mcp,
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list tools failed' });
  }
});

export default router;
