/**
 * 记忆 / 日志(桌面记忆面板;handler 自带 authMiddleware)。
 * 旧读/追加入口保兼容；本地管理返回版本化快照，Agent 面板的编辑/恢复走 agents.ts。
 *   GET  /agent/memory                → { content, updatedAt }
 *   POST /agent/memory { text, dedup? } → AppendMemoryResult
 *   GET  /agent/log?date=YYYY-MM-DD   → { date, content, updatedAt }
 *   POST /agent/log { text }          → { date, time }
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { syncNow, getSyncStatus } from '../services/memorySyncService.js';
import { runWithAgentSlug } from '../seams/runContext.js';
import { getAgent, listAgents, resolveMemorySlug, isValidSlug } from '../agents/agentRegistry.js';
import { MemoryRepositoryError } from '../services/memoryRepository.js';
import { AGENT_SYNC_SEALED, agentSyncDefault, agentSyncIdentity, agentSyncScope, contentSyncOwnership, setAgentSyncDefault, setContentSyncOwner, setContentSyncOwnership } from '../services/cloudSyncAccount.js';
import { parseRemoteOrigin } from '../services/remoteOrigin.js';
import { mirrorLegacyHuman } from '../agents/humanFolder.js';
import { factWithScope, runTagContext } from '../services/deviceTagContext.js';

const router = Router();
/** 谁管落盘同步的两位记号(contracts/contentSyncOwner.ts;智库同步第 2 步,契约 §3.7 / 实现期修订 H-1 第 5 条)。只给本机宿主用。
 *  PUT 老 body {enabled} = 两位一起(老宿主的 claim,落盘形状与回包 {ok:true} 同第 2 步之前);新 body {human?, agents?} 只改给的那位、回两位,
 *  落了盘就回 200(镜像失败带 mirror:'failed')。GET 回两位当前值,宿主改完读回核对。
 *  POST content-touched:新同步动过盘的通知,只把 human/ 镜像回旧位置(human 归新同步时),不写 owner(老 changed() 每次把 owner 写成 true)。 */
function contentOwnerIdentity(req: AuthRequest, res: import('express').Response) {
  if(!deps().profile.capabilities.hostExec||parseRemoteOrigin(req.headers)){res.status(403).json({detail:'Local content sync only'});return null;}
  const identity=agentSyncIdentity(deps().brain.agentFiles,req.user!.userId);
  if(!identity){res.status(400).json({detail:'Account required'});return null;}
  const expected=req.method==='GET'?req.query.expectedAccount:req.body?.expectedAccount;
  if(expected!==undefined&&expected!==identity.account){res.status(409).json({detail:'account_changed'});return null;}
  return identity;
}
router.put('/agent/sync/content-owner',authMiddleware,async(req:AuthRequest,res)=>{
  const legacy=typeof req.body?.enabled==='boolean';
  const human=req.body?.human,agents=req.body?.agents;
  const patch={...(typeof human==='boolean'?{human}:{}),...(typeof agents==='boolean'?{agents}:{})};
  if(!legacy&&!Object.keys(patch).length)return void res.status(400).json({detail:'Account and enabled required'});
  if(legacy&&Object.keys(patch).length)return void res.status(400).json({detail:'Use either enabled or human/agents'});
  const identity=contentOwnerIdentity(req,res);if(!identity)return;
  // 老 body:和第 2 步之前一样(落盘只有 owner、回 {ok:true};镜像失败照旧报 500,老宿主靠它)
  if(legacy){
    try{setContentSyncOwner(identity.scope,req.body.enabled);await mirrorLegacyHuman();res.json({ok:true});}
    catch(e){res.status(500).json({detail:'Content sync ownership failed'});}
    return;
  }
  // 新 body:那一位一旦落了盘就不报失败(宿主读回核对、按读回的为准);镜像 human/ 失败只记一笔,下次 content-touched / 同步再镜像
  try{setContentSyncOwnership(identity.scope,patch);}
  catch(e){return void res.status(500).json({detail:'Content sync ownership failed'});}
  let mirrored=true;
  try{await mirrorLegacyHuman();}catch(e){mirrored=false;console.warn('[content-owner] human mirror failed after the owner bit was saved:',e instanceof Error?e.message:String(e));}
  let owns;
  try{owns=contentSyncOwnership(identity.scope);}catch(e){return void res.status(500).json({detail:'Content sync ownership unreadable'});}
  res.json({ok:true,...owns,...(mirrored?{}:{mirror:'failed'})});
});
router.get('/agent/sync/content-owner',authMiddleware,async(req:AuthRequest,res)=>{
  const identity=contentOwnerIdentity(req,res);if(!identity)return;
  try{res.json(contentSyncOwnership(identity.scope));}
  catch(e){res.status(500).json({detail:'Content sync ownership unreadable'});}
});
router.post('/agent/sync/content-touched',authMiddleware,async(req:AuthRequest,res)=>{
  const identity=contentOwnerIdentity(req,res);if(!identity)return;
  try{if(contentSyncOwnership(identity.scope).human)await mirrorLegacyHuman();res.json({ok:true});}
  catch(e){res.status(500).json({detail:'Content sync refresh failed'});}
});

async function inRequestedMemoryScope<T>(req: AuthRequest, fn: () => Promise<T>): Promise<T> {
  const requested = req.body?.slug ?? req.query.slug;
  if (requested === undefined || requested === '') return fn();
  if (typeof requested !== 'string' || !isValidSlug(requested)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid agent slug.');
  if (!deps().profile.capabilities.hostExec) throw new MemoryRepositoryError('MEMORY_UNSUPPORTED', 'This memory backend does not support per-agent memory.');
  const def = await getAgent(requested);
  if (!def) throw new MemoryRepositoryError('MEMORY_NOT_FOUND', 'Agent not found.');
  const scope = resolveMemorySlug(def);
  if (!isValidSlug(scope)) throw new MemoryRepositoryError('MEMORY_UNSAFE_PATH', 'Invalid memory scope.');
  return runWithAgentSlug(scope, fn);
}
function statusFor(e: any): number {
  if (e?.code === 'MEMORY_NOT_FOUND') return 404;
  if (e?.code === 'MEMORY_VERSION_CONFLICT' || e?.code === 'MEMORY_BUSY') return 409;
  if (e?.code === 'MEMORY_UNSAFE_PATH' || e?.code === 'MEMORY_INVALID' || e?.code === 'MEMORY_UNSUPPORTED') return 400;
  return 500;
}

router.get('/agent/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json(await inRequestedMemoryScope(req, () => deps().brain.memory.getMemorySnapshot?.(req.user!.userId) ?? deps().brain.memory.getMemory(req.user!.userId)));
  } catch (e: any) {
    res.status(statusFor(e)).json({ detail: e?.message || 'get memory failed', code: e?.code });
  }
});

router.post('/agent/memory', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const raw = String(req.body?.text ?? '').trim();
    if (!raw) return res.status(400).json({ detail: 'text is required' });
    // 适用范围(11-06):本机才有「这台电脑 / 这个系统」;云端给了非 all 的 → 400
    const text = factWithScope(raw, req.body?.appliesTo, runTagContext(!!deps().profile.capabilities.hostExec));
    if (text === null) return res.status(400).json({ detail: 'Invalid appliesTo', code: 'MEMORY_INVALID' });
    const append = () => deps().brain.memory.appendMemoryEntry(req.user!.userId, text, { dedup: req.body?.dedup !== false });
    res.json(await inRequestedMemoryScope(req, append));
  } catch (e: any) {
    res.status(statusFor(e)).json({ detail: e?.message || 'append memory failed', code: e?.code });
  }
});

router.get('/agent/log', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const date = req.query.date ? String(req.query.date) : undefined;
    res.json(await inRequestedMemoryScope(req, () => deps().brain.memory.getLog(req.user!.userId, date)));
  } catch (e: any) {
    res.status(statusFor(e)).json({ detail: e?.message || 'get log failed', code: e?.code });
  }
});

router.post('/agent/log', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const raw = String(req.body?.text ?? '').trim();
    if (!raw) return res.status(400).json({ detail: 'text is required' });
    // 适用范围(11-06):本机才有「这台电脑 / 这个系统」;云端给了非 all 的 → 400
    const text = factWithScope(raw, req.body?.appliesTo, runTagContext(!!deps().profile.capabilities.hostExec));
    if (text === null) return res.status(400).json({ detail: 'Invalid appliesTo', code: 'MEMORY_INVALID' });
    res.json(await inRequestedMemoryScope(req, () => deps().brain.memory.appendLogEntry(req.user!.userId, text)));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'append log failed' });
  }
});

// ── 本地 ↔ Forsion Brain 同步(手动「立即同步」/ 桌面端按开关定时调用)──
router.post('/agent/sync', authMiddleware, async (req: AuthRequest, res) => {
  try {
    res.json(await syncNow(req.user!.userId));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'sync failed' });
  }
});

router.get('/agent/sync/status', authMiddleware, (req: AuthRequest, res) => {
  res.json(getSyncStatus(req.user!.userId));
});

// 账号级「Agents 与记忆」总闸(蓬洲云「同步」页 / 首登卡片 / 引导):enabled = null 表示这个账号在这台电脑上还没点过。
// sealed = Agents 同步先封着(AGENT_SYNC_SEALED):enabled 照实返回存着的值(human/ 的同意靠它),界面据 sealed 锁住开关。
router.get('/agent/sync/default', authMiddleware, async (req: AuthRequest, res) => {
  if (!deps().profile.capabilities.hostExec) return void res.json({ enabled: null, agents: 0, available: false, sealed: AGENT_SYNC_SEALED });
  const scope = agentSyncScope(deps().brain.agentFiles, req.user!.userId);
  res.json({ enabled: agentSyncDefault(scope), agents: (await listAgents().catch(() => [])).length, available: !!scope, sealed: AGENT_SYNC_SEALED });
});
router.put('/agent/sync/default', authMiddleware, (req: AuthRequest, res) => {
  if (!deps().profile.capabilities.hostExec) return void res.status(404).json({ detail: 'Agent sync is only available on desktop.' });
  // 封着:存着的总闸一个字不改(放开后原样恢复),不顺手发同步
  if (AGENT_SYNC_SEALED) return void res.status(409).json({ detail: 'agent_sync_sealed' });
  if (typeof req.body?.enabled !== 'boolean') return void res.status(400).json({ detail: 'enabled must be a boolean' });
  const uid = req.user!.userId;
  const scope = agentSyncScope(deps().brain.agentFiles, uid);
  if (!scope) return void res.status(409).json({ detail: 'Sign in to Forsion first.' });
  setAgentSyncDefault(scope, req.body.enabled);
  if (req.body.enabled) void syncNow(uid).catch(() => {}); // 打开就先同步一次,不等下次聊天
  res.json({ enabled: req.body.enabled });
});

export default router;
