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

import { runWithAgentSlug } from '../seams/runContext.js';
import { isValidSlug } from '../agents/agentRegistry.js';
import { listSharedAgentSkills } from '../skills/localSkills.js';
import {
  SkillCatalogError, listSkillCatalog, getSkillCatalogDetail, createCatalogSkill,
  updateCatalogSkill, setCatalogSkillDisabled, deleteCatalogSkill, copyCatalogSkill,
  importCatalogSkill,
} from '../skills/catalog.js';

const router = Router();

function localSkillsOnly(res: any): boolean {
  if (deps().profile.capabilities.hostExec) return true;
  res.status(404).json({ detail: 'Local skill management is available on this device only' });
  return false;
}
const agentSlugArg = (req: AuthRequest): string | undefined =>
  typeof req.query.agentSlug === 'string' ? req.query.agentSlug
  : typeof req.body?.agentSlug === 'string' ? req.body.agentSlug : undefined;
function catalogError(res: any, e: unknown): void {
  res.status(e instanceof SkillCatalogError ? e.status : 500).json({ detail: e instanceof Error ? e.message : String(e) });
}

/** 每份技能独立列出，包含真实范围、路径、只读来源、当前 Agent 的覆盖/停用状态。 */
router.get('/agent/skills/catalog', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try { res.json({ skills: await listSkillCatalog(agentSlugArg(req)) }); }
  catch (e) { catalogError(res, e); }
});
router.get('/agent/skills/catalog/:key', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try { res.json({ skill: await getSkillCatalogDetail(req.params.key, agentSlugArg(req)) }); }
  catch (e) { catalogError(res, e); }
});
router.post('/agent/skills/catalog', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try { res.status(201).json({ skill: await createCatalogSkill(req.body || {}) }); }
  catch (e) { catalogError(res, e); }
});
router.post('/agent/skills/catalog/import', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try { res.status(201).json({ skill: await importCatalogSkill(req.body || {}) }); }
  catch (e) { catalogError(res, e); }
});
router.patch('/agent/skills/catalog/:key', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try { res.json({ skill: await updateCatalogSkill(req.params.key, req.body || {}, agentSlugArg(req)) }); }
  catch (e) { catalogError(res, e); }
});
router.put('/agent/skills/catalog/:key/disabled', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try {
    if (typeof req.body?.disabled !== 'boolean') return res.status(400).json({ detail: 'disabled must be a boolean' });
    await setCatalogSkillDisabled(req.params.key, req.body.disabled, agentSlugArg(req));
    res.json({ ok: true });
  } catch (e) { catalogError(res, e); }
});
router.delete('/agent/skills/catalog/:key', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try { res.json({ ok: true, ...await deleteCatalogSkill(req.params.key, agentSlugArg(req)) }); }
  catch (e) { catalogError(res, e); }
});
router.post('/agent/skills/catalog/:key/copy', authMiddleware, async (req: AuthRequest, res) => {
  if (!localSkillsOnly(res)) return;
  try {
    const sourceAgentSlug = typeof req.body?.sourceAgentSlug === 'string' ? req.body.sourceAgentSlug : agentSlugArg(req);
    res.status(201).json({ skill: await copyCatalogSkill(req.params.key, req.body || {}, sourceAgentSlug) });
  }
  catch (e) { catalogError(res, e); }
});

/** GET /agent/skills 每条的对外形状(单独导出好单测:桌面「自建」徽标只认这里透传的 origin)。 */
export function skillSummary(s: any): { id: string; name: string; description: string; icon: string | null; category: string | null; source: string; origin: 'agent' | null; builtin: boolean; shared: boolean } {
  return {
    id: s.id,
    name: s.name,
    description: s.description || '',
    icon: s.icon || null,
    category: s.category || null,
    // 'local'=磁盘技能(包内置/~/.tangu/skills,localAssets overlay 标注);缺省 cloud
    source: s.source || 'cloud',
    // 'agent'=manage_skill 自建(SKILL.md frontmatter origin,localSkills 只在用户级/agent 级根认它);其余 null。客户端据此打「自建」徽标。
    origin: s.origin === 'agent' ? 'agent' : null,
    // agent 级技能 frontmatter `shared: true`:借给别的 agent(桌面详情页打「共享」徽标)。
    shared: s.shared === true,
    // 随包内置(含家目录里没被改过的镜像;用户改过的副本升格为 user 层,不算)。桌面详情页据此把内置技能收进折叠组。
    // category 不能当判据:内置技能的 frontmatter 各写各的分类(写作 / Forsion / 开发流程…)。
    builtin: s.is_builtin === true,
  };
}

router.get('/agent/skills', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const listSkills = deps().brain.assets.listSkills;
    const slug = typeof req.query.agentSlug === 'string' && isValidSlug(req.query.agentSlug) ? req.query.agentSlug : null;
    let skills: any[] = [];
    if (listSkills) {
      // forUser:进程内实现按其过滤(全局 ∪ 本人上传);httpBrain 由 token 隐含、忽略该字段。
      const load = () => listSkills({ visibleOnly: true, forUser: req.user!.userId });
      skills = (await (slug ? runWithAgentSlug(slug, load, slug) : load()).catch(() => [])) || [];
    }
    // Agent 档案的「自选技能」也要看得到自动模式会借用的共享池，否则从自动切到自选时
    // `local:@owner/name` 消失，保存白名单会悄悄卸掉这些技能。无 agentSlug 的全局目录保持原形。
    const shared = slug && deps().profile.capabilities.hostExec
      ? await listSharedAgentSkills(slug).catch(() => []) : [];
    const visible = new Map<string, any>();
    for (const skill of [...skills, ...shared]) if (!visible.has(skill.id)) visible.set(skill.id, skill);
    res.json({ skills: [...visible.values()].map(skillSummary) });
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
    // 走 profileStore(appId 可指定):清单反映 admin 覆盖(tool_builtins 白名单等)后的**生效集**,
    // 与 run 的 resolveProfile 同源——admin 面板/Tangu Manager 看到的即真实可用工具。
    const appIdQ = typeof req.query.appId === 'string' && req.query.appId ? req.query.appId : undefined;
    const profile = deps().profileStore.resolve(appIdQ ?? null) ?? deps().profile;
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
    // 与 run 同闸(agentLoop / subAgent 按 profile.features.customTools 决定是否装载):关掉的 app 清单也不列,免得「列表有、run 不装」。
    if (profile.features.customTools) {
      try {
        custom = (await deps().brain.assets.listCustomTools({ appId: profile.appId, visibleOnly: true })) || [];
      } catch {
        custom = [];
      }
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
