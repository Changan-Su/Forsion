/**
 * agent-core admin 路由。挂在 manifest.adminMountPath（/api/admin/agent-core），
 * mount 自动叠加 authMiddleware + adminMiddleware，这里只写业务。
 * 供后台「内容与服务 → Tangu Agent」：
 *   GET  /sessions               按 session 聚合的运行概览（在飞优先）
 *   GET  /sessions/:sid          某 session 详情（汇总 + 其下各 run）
 *   POST /sessions/:sid/abort    终止该 session 全部在飞 run
 *   POST /runs/:id/abort         终止单个 run
 *   GET  /stats                  概览统计（按 session）
 *   GET  /resources              活跃沙箱容器真实 CPU/内存（docker stats 快照，尽力而为）
 *   GET  /runs                   扁平 run 列表（兼容/调试）
 */
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { query } from '../core/db.js';
import { abortRun } from '../services/agentLoop.js';
import { getRun, listSteps } from '../services/runStore.js';
import { getSandboxSnapshot, getCacheInfo, clearPkgCache, pumpWaiters } from '../sandbox/dockerProvider.js';
import { sandboxConfig, setSandboxConfig, SANDBOX_DEFAULTS } from '../sandbox/sandboxConfig.js';
import { historianConfig, setHistorianConfig, HISTORIAN_DEFAULTS } from '../services/historianConfig.js';
import { deps } from '../seams/runtime.js';

// ── 注入依赖的 lazy 别名(保持下方调用点不变)──
const listGlobalModels = (...args: any[]): Promise<any[]> => (deps().brain.models.listGlobalModels as any)(...args);

const router = Router();
const ACTIVE = "status IN ('queued','running')";

// ── 按 session 聚合：一个会话多次回复(run)合并统计 ──
router.get('/sessions', async (_req, res) => {
  try {
    const rows = await query<any[]>(
      // ⏱ 相对时长在 SQL 内算(EXTRACT EPOCH of CURRENT_TIMESTAMP - col):created_at/updated_at 是
      //   TIMESTAMP(无时区),由 node-pg 按进程本地时区解析,与 DB 会话时区不一致时整体偏移。SQL 内做
      //   时间差则两侧同会话时区一致折算,得到的秒龄与部署时区无关(绝对时间戳仍原样返回供 tooltip)。
      `SELECT s.session_id, s.user_id, s.app_id, s.runs, s.tokens, s.steps, s.active_runs,
              s.started_at, s.last_activity, s.started_age_sec, s.last_activity_age_sec,
              s.model_id, lr.status AS last_status, u.username
       FROM (
         SELECT session_id,
                MAX(user_id) AS user_id, MAX(app_id) AS app_id,
                COUNT(*)::int AS runs,
                COALESCE(SUM(tokens_total),0) AS tokens,
                COALESCE(SUM(current_step),0) AS steps,
                COUNT(*) FILTER (WHERE ${ACTIVE})::int AS active_runs,
                MIN(created_at) AS started_at, MAX(updated_at) AS last_activity,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(created_at)))::bigint AS started_age_sec,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(updated_at)))::bigint AS last_activity_age_sec,
                MAX(model_id) AS model_id
         FROM agent_runs GROUP BY session_id
       ) s
       LEFT JOIN LATERAL (
         SELECT status FROM agent_runs WHERE session_id = s.session_id ORDER BY updated_at DESC LIMIT 1
       ) lr ON true
       LEFT JOIN users u ON u.id = s.user_id
       ORDER BY (s.active_runs > 0) DESC, s.last_activity DESC
       LIMIT 100`,
    );
    const sessions = rows.map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      username: r.username || null,
      appId: r.app_id || 'ai-studio',
      modelId: r.model_id || null,
      runs: Number(r.runs) || 0,
      tokens: Number(r.tokens) || 0,
      steps: Number(r.steps) || 0,
      activeRuns: Number(r.active_runs) || 0,
      status: Number(r.active_runs) > 0 ? 'running' : String(r.last_status || 'idle'),
      startedAt: r.started_at,
      lastActivity: r.last_activity,
      startedAgeSec: r.started_age_sec == null ? null : Number(r.started_age_sec),
      lastActivityAgeSec: r.last_activity_age_sec == null ? null : Number(r.last_activity_age_sec),
    }));
    res.json({ sessions });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── 某 session 详情：汇总 + 其下各 run（进去看详情） ──
router.get('/sessions/:sid', async (req, res) => {
  try {
    const sid = req.params.sid;
    const sumRows = await query<any[]>(
      `SELECT s.*, u.username FROM (
         SELECT session_id, MAX(user_id) AS user_id, MAX(app_id) AS app_id,
                COUNT(*)::int AS runs, COALESCE(SUM(tokens_total),0) AS tokens,
                COALESCE(SUM(current_step),0) AS steps,
                COUNT(*) FILTER (WHERE ${ACTIVE})::int AS active_runs,
                MIN(created_at) AS started_at, MAX(updated_at) AS last_activity,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(created_at)))::bigint AS started_age_sec,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MAX(updated_at)))::bigint AS last_activity_age_sec
         FROM agent_runs WHERE session_id = ? GROUP BY session_id
       ) s LEFT JOIN users u ON u.id = s.user_id`,
      [sid],
    );
    if (!sumRows[0]) return res.status(404).json({ detail: 'session not found' });
    const s = sumRows[0];
    const runs = await query<any[]>(
      // duration_sec / *_age_sec 同样在 SQL 内算,免受 node-pg 时区解析影响。
      `SELECT id, status, current_step, model_id, sandbox_id, tokens_total, error, created_at, updated_at,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))::bigint AS created_age_sec,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - updated_at))::bigint AS updated_age_sec,
              EXTRACT(EPOCH FROM (updated_at - created_at))::bigint AS duration_sec
       FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC`,
      [sid],
    );
    res.json({
      session: {
        sessionId: s.session_id,
        userId: s.user_id,
        username: s.username || null,
        appId: s.app_id || 'ai-studio',
        runs: Number(s.runs) || 0,
        tokens: Number(s.tokens) || 0,
        steps: Number(s.steps) || 0,
        activeRuns: Number(s.active_runs) || 0,
        startedAt: s.started_at,
        lastActivity: s.last_activity,
        startedAgeSec: s.started_age_sec == null ? null : Number(s.started_age_sec),
        lastActivityAgeSec: s.last_activity_age_sec == null ? null : Number(s.last_activity_age_sec),
      },
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        currentStep: Number(r.current_step) || 0,
        modelId: r.model_id || null,
        sandboxId: r.sandbox_id || null,
        tokens: Number(r.tokens_total) || 0,
        error: r.error || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        createdAgeSec: r.created_age_sec == null ? null : Number(r.created_age_sec),
        updatedAgeSec: r.updated_age_sec == null ? null : Number(r.updated_age_sec),
        durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── 终止：单个 run ──
router.post('/runs/:id/abort', async (req, res) => {
  try {
    const rows = await query<any[]>(`SELECT id FROM agent_runs WHERE id = ? LIMIT 1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ detail: 'run not found' });
    abortRun(req.params.id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── 终止：某 session 的全部在飞 run ──
router.post('/sessions/:sid/abort', async (req, res) => {
  try {
    const rows = await query<any[]>(
      `SELECT id FROM agent_runs WHERE session_id = ? AND ${ACTIVE}`,
      [req.params.sid],
    );
    rows.forEach((r) => abortRun(r.id));
    res.json({ ok: true, aborted: rows.length });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── 概览统计（按 session） ──
router.get('/stats', async (_req, res) => {
  try {
    const rows = await query<any[]>(
      `SELECT COUNT(DISTINCT session_id)::int AS sessions,
              COUNT(DISTINCT session_id) FILTER (WHERE ${ACTIVE})::int AS active_sessions,
              COUNT(*) FILTER (WHERE ${ACTIVE})::int AS active_runs,
              COALESCE(SUM(tokens_total) FILTER (WHERE ${ACTIVE}),0) AS active_tokens,
              COUNT(*) FILTER (WHERE sandbox_id IS NOT NULL AND ${ACTIVE})::int AS active_sandboxes
       FROM agent_runs`,
    );
    const r = rows[0] || {};
    res.json({
      sessions: Number(r.sessions) || 0,
      activeSessions: Number(r.active_sessions) || 0,
      activeRuns: Number(r.active_runs) || 0,
      activeTokens: Number(r.active_tokens) || 0,
      activeSandboxes: Number(r.active_sandboxes) || 0,
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── 真实资源占用：活跃沙箱容器（agent-sbx-*）的 docker stats 快照（尽力而为） ──
function dockerAgentStats(): Promise<Array<{ name: string; cpu: string; mem: string; memPerc: string }>> {
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'],
      { timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const out: Array<{ name: string; cpu: string; mem: string; memPerc: string }> = [];
        for (const line of String(stdout).split('\n')) {
          const p = line.split('\t');
          if (p.length < 4) continue;
          const name = p[0].trim();
          if (!name.startsWith('agent-sbx-') && !name.startsWith('agent-run-')) continue;
          out.push({ name, cpu: p[1].trim(), mem: p[2].trim(), memPerc: p[3].trim() });
        }
        resolve(out);
      },
    );
  });
}

router.get('/resources', async (_req, res) => {
  // 进程内登记的活跃执行（权威，ephemeral 容器秒级存活，docker stats 常抓不到）
  // 叠加 docker stats 快照（能抓到就补真实 CPU/内存）。
  const snap = getSandboxSnapshot();
  let stats: Array<{ name: string; cpu: string; mem: string; memPerc: string }> = [];
  try { stats = await dockerAgentStats(); } catch { /* best-effort */ }
  const statByName = new Map(stats.map((s) => [s.name, s]));
  const containers = snap.active.map((e) => {
    const st = statByName.get(e.name);
    return {
      name: e.name,
      kind: e.kind,
      runId: e.runId,
      ageMs: Date.now() - e.startedAt,
      cpu: st?.cpu || '—',
      mem: st?.mem || '—',
      memPerc: st?.memPerc || '—',
    };
  });
  // docker stats 抓到但进程表里没有的（理论上不该有，兜底显示）
  for (const s of stats) {
    if (!snap.active.find((e) => e.name === s.name)) {
      containers.push({ name: s.name, kind: 'unknown', runId: null, ageMs: 0, cpu: s.cpu, mem: s.mem, memPerc: s.memPerc });
    }
  }
  // Node 主进程内存（整体服务占用：agent loop 在主进程跑，沙箱才在容器）
  const mem = process.memoryUsage();
  res.json({
    containers,
    activeCount: snap.activeCount,
    maxConcurrent: snap.maxConcurrent,
    recent: snap.recent,
    node: {
      rssMB: Math.round(mem.rss / 1048576),
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      heapTotalMB: Math.round(mem.heapTotal / 1048576),
      externalMB: Math.round(mem.external / 1048576),
      uptimeSec: Math.round(process.uptime()),
    },
  });
});

// ── 某 run 的输出内容（会话输出）：逐步的 LLM 文本 + 工具调用/结果 + 最终文本 ──
router.get('/runs/:id/transcript', async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return res.status(404).json({ detail: 'run not found' });
    const r: any = run;
    const input = typeof r.input === 'string' ? safeParse(r.input) : r.input;
    const result = typeof r.result === 'string' ? safeParse(r.result) : r.result;
    const steps = await listSteps(req.params.id);
    // 相对时长在 SQL 内算,免受 node-pg 时区解析影响。
    const ageRows = await query<any[]>(
      `SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))::bigint AS created_age_sec,
              EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - updated_at))::bigint AS updated_age_sec,
              EXTRACT(EPOCH FROM (updated_at - created_at))::bigint AS duration_sec
       FROM agent_runs WHERE id = ? LIMIT 1`,
      [req.params.id],
    );
    const ar = ageRows[0] || {};
    res.json({
      run: {
        id: r.id,
        sessionId: r.session_id,
        status: r.status,
        modelId: r.model_id || null,
        tokens: Number(r.tokens_total) || 0,
        currentStep: Number(r.current_step) || 0,
        error: r.error || null,
        createdAt: r.created_at || null,
        updatedAt: r.updated_at || null,
        createdAgeSec: ar.created_age_sec == null ? null : Number(ar.created_age_sec),
        updatedAgeSec: ar.updated_age_sec == null ? null : Number(ar.updated_age_sec),
        durationSec: ar.duration_sec == null ? null : Number(ar.duration_sec),
      },
      userMessage: (input && input.message) || null,
      finalContent: (result && result.content) || null,
      steps: steps.map((s) => ({
        stepNo: s.stepNo,
        content: s.llmResponse?.content || '',
        toolCalls: Array.isArray(s.toolCalls)
          ? s.toolCalls.map((c: any) => ({ name: c?.function?.name || c?.name || '?', arguments: c?.function?.arguments ?? c?.arguments ?? '' }))
          : [],
        toolResults: Array.isArray(s.toolResults)
          ? s.toolResults.map((t: any) => ({ name: t?.name || '?', content: t?.content ?? '', isError: !!t?.isError }))
          : [],
      })),
    });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

function safeParse(s: any): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

// ── 沙箱设置（并发上限 / 包缓存体积上限 / 缓存保留天数）+ 缓存信息 ──
router.get('/sandbox/config', async (_req, res) => {
  try {
    const cache = await getCacheInfo();
    res.json({ config: sandboxConfig(), defaults: SANDBOX_DEFAULTS, cache });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

router.put('/sandbox/config', async (req, res) => {
  try {
    const b = req.body || {};
    const patch: any = {};
    if (b.maxConcurrent !== undefined) patch.maxConcurrent = Number(b.maxConcurrent);
    if (b.pkgCacheMaxMB !== undefined) patch.pkgCacheMaxMB = Number(b.pkgCacheMaxMB);
    if (b.pkgCacheTtlDays !== undefined) patch.pkgCacheTtlDays = Number(b.pkgCacheTtlDays);
    for (const k of Object.keys(patch)) {
      if (!Number.isFinite(patch[k])) return res.status(400).json({ detail: `invalid ${k}` });
    }
    const config = await setSandboxConfig(patch);
    pumpWaiters(); // 并发上限可能调高 → 立即唤醒排队任务
    const cache = await getCacheInfo();
    res.json({ config, defaults: SANDBOX_DEFAULTS, cache });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

router.post('/sandbox/cache/clear', async (_req, res) => {
  try {
    const clearedMB = await clearPkgCache();
    const cache = await getCacheInfo();
    res.json({ ok: true, clearedMB, cache });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── Historian（空闲会话复盘）设置：开关 / 空闲触发分钟 / 摘要模型 ──
router.get('/historian/config', async (_req, res) => {
  try {
    const models = await listGlobalModels(false, false, { type: 'llm' })
      .then((ms) => ms.map((m) => ({ id: m.id, name: m.name })))
      .catch(() => [] as Array<{ id: string; name: string }>);
    res.json({ config: historianConfig(), defaults: HISTORIAN_DEFAULTS, models });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

router.put('/historian/config', async (req, res) => {
  try {
    const b = req.body || {};
    const patch: any = {};
    if (b.enabled !== undefined) patch.enabled = !!b.enabled;
    if (b.idleMinutes !== undefined) {
      const n = Number(b.idleMinutes);
      if (!Number.isFinite(n)) return res.status(400).json({ detail: 'invalid idleMinutes' });
      patch.idleMinutes = n;
    }
    if (b.modelId !== undefined) {
      const id = String(b.modelId || '');
      if (id) {
        const ok = (await listGlobalModels(false, false, { type: 'llm' })).some((m) => m.id === id);
        if (!ok) return res.status(400).json({ detail: 'unknown or disabled model' });
      }
      patch.modelId = id;
    }
    const config = await setHistorianConfig(patch);
    res.json({ config, defaults: HISTORIAN_DEFAULTS });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

// ── 扁平 run 列表（兼容/调试） ──
router.get('/runs', async (_req, res) => {
  try {
    const rows = await query<any[]>(
      `SELECT r.id, r.session_id, r.user_id, r.app_id, r.status, r.current_step,
              r.model_id, r.sandbox_id, r.tokens_total, r.error, r.created_at, r.updated_at,
              u.username AS username
       FROM agent_runs r LEFT JOIN users u ON u.id = r.user_id
       ORDER BY (r.status IN ('queued','running')) DESC, r.updated_at DESC
       LIMIT 100`,
    );
    res.json({ runs: rows });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'failed' });
  }
});

export default router;
