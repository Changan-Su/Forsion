/**
 * 直连 provider(BYO-key)信息与连通性探测。
 *   GET  /agent/providers      → { providers: [{ providerId, baseUrl, modelIds }] }  // 后端实际加载的(不含 apiKey)
 *   POST /agent/providers/test → { success, message }  // 两段探测:GET /models → 1-token chat completion
 *
 * 配置写入不在此(desktop 经 IPC 直写 ~/.tangu/providers.json 后重启托管后端;CLI 用 --providers-file)。
 * test 探测移植 server 的 /admin/models/test-connection 策略,差异:apiKey 可空(Ollama 等本地端点)。
 */
import { Router } from 'express';
import { authMiddleware } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { loadLocalWebSearchConfig, redactedLocalConfig, testLocalSearch } from '../adapters/standalone/localSearch.js';
import { saveSection } from '../core/config.js';

const router = Router();

router.get('/agent/providers', authMiddleware, async (_req, res) => {
  try {
    res.json({ providers: deps().brain.models.listDirectProviders?.() ?? [] });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'list providers failed' });
  }
});

router.post('/agent/providers/test', authMiddleware, async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl ?? '').trim();
    const apiKey = String(req.body?.apiKey ?? '').trim();
    const modelId = String(req.body?.modelId ?? '').trim();
    if (!baseUrl) return res.status(400).json({ detail: 'baseUrl required' });

    const clean = baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // 策略 1:GET /models(多数 OpenAI 兼容端点支持)
    try {
      const r = await fetch(`${clean}/models`, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const data: any = await r.json().catch(() => ({}));
        const n = data?.data?.length || data?.models?.length || 0;
        return res.json({ success: true, message: n > 0 ? `连接成功,发现 ${n} 个模型` : '连接成功,端点可达' });
      }
    } catch {
      /* /models 不可用 → 落到策略 2 */
    }

    // 策略 2:1-token chat completion(需要 modelId)
    if (modelId) {
      const r = await fetch(`${clean}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.ok) return res.json({ success: true, message: '连接成功,模型可响应' });
      const err: any = await r.json().catch(() => ({}));
      return res.json({
        success: false,
        message: `端点返回 ${r.status}: ${err?.error?.message || err?.message || '未知错误'}`,
      });
    }

    return res.json({ success: false, message: '无法验证连接;填入模型 ID 可做更深探测' });
  } catch (e: any) {
    res.json({ success: false, message: `连接失败: ${e?.message || e}` });
  }
});

/** OpenAI(`data:[{id}]`)/ Ollama(`models:[{name|id}]`)/ 裸数组 多形兼容解析 → 归一 {id,name?}。 */
function parseModels(data: any): Array<{ id: string; name?: string }> {
  const out: Array<{ id: string; name?: string }> = [];
  const push = (id: any, name?: any) => {
    const sid = typeof id === 'string' ? id.trim() : '';
    if (sid) out.push(name && String(name).trim() ? { id: sid, name: String(name).trim() } : { id: sid });
  };
  const list = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data) ? data
        : [];
  for (const m of list) {
    if (typeof m === 'string') push(m);
    else if (m && typeof m === 'object') push(m.id ?? m.name ?? m.model, m.name ?? m.display_name);
  }
  return out;
}

/**
 * POST /agent/providers/fetch-models → { models: [{id, name?}] }
 * 后端代拉上游 GET {baseUrl}/models(避 CORS),供「自定义 Provider」编辑器发现可用模型名。
 * 软失败:上游不可达/无列表 → 返回 { models: [] }(不 500,前端展示空态)。
 */
router.post('/agent/providers/fetch-models', authMiddleware, async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl ?? '').trim();
    const apiKey = String(req.body?.apiKey ?? '').trim();
    if (!baseUrl) return res.status(400).json({ detail: 'baseUrl required' });

    const clean = baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const tryFetch = async (path: string): Promise<Array<{ id: string; name?: string }>> => {
      try {
        const r = await fetch(`${clean}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return [];
        const data: any = await r.json().catch(() => ({}));
        return parseModels(data);
      } catch {
        return [];
      }
    };

    // 先 {base}/models,无果再 {base}/v1/models(覆盖 baseUrl 未含 /v1 的情况)。
    let models = await tryFetch('/models');
    if (!models.length) models = await tryFetch('/v1/models');

    // 去重 + 按 id 排序。
    const seen = new Set<string>();
    const deduped = models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
    deduped.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ models: deduped });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'fetch models failed' });
  }
});

// ── 本地联网搜索(BYO-key)设置:config.json webSearch 段 ─────────────────────
//   GET  /agent/websearch       → redacted 配置(hasKey 布尔,不回明文)
//   PUT  /agent/websearch       → 保存(key:'__keep__' 不变 / '' 清除 / 其余覆写)
//   POST /agent/websearch/test  → 只测指定 provider,不落盘
// 写的是本机 config.json → 云端(hostExec=false)一律 404,与 special 同门。

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: '本地搜索设置仅在本地(桌面/TUI)可用' });
    return false;
  }
  return true;
}

router.get('/agent/websearch', authMiddleware, async (_req, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json(redactedLocalConfig());
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'read websearch config failed' });
  }
});

router.put('/agent/websearch', authMiddleware, async (req, res) => {
  if (!ensureLocal(res)) return;
  try {
    const cur = loadLocalWebSearchConfig();
    const b = req.body ?? {};
    const VALID = ['auto', 'bocha', 'tavily', 'zhipu', 'duckduckgo'];
    if (b.provider !== undefined && !VALID.includes(String(b.provider))) {
      return res.status(400).json({ detail: `provider must be one of: ${VALID.join(', ')}` });
    }
    const mergeKey = (next: any, prev: string | null): string | null => {
      if (next === undefined || next === '__keep__') return prev;
      if (next === null || next === '') return null;
      return String(next);
    };
    saveSection('webSearch', {
      provider: b.provider !== undefined ? String(b.provider) : cur.provider,
      bochaApiKey: mergeKey(b.bochaApiKey, cur.bochaApiKey),
      tavilyApiKey: mergeKey(b.tavilyApiKey, cur.tavilyApiKey),
      zhipuApiKey: mergeKey(b.zhipuApiKey, cur.zhipuApiKey),
      zhipuEngine: ['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'].includes(String(b.zhipuEngine))
        ? String(b.zhipuEngine)
        : cur.zhipuEngine,
    });
    res.json({ success: true, config: redactedLocalConfig() });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'save websearch config failed' });
  }
});

router.post('/agent/websearch/test', authMiddleware, async (req, res) => {
  if (!ensureLocal(res)) return;
  try {
    const provider = String(req.body?.provider ?? 'auto');
    // 始终 200,调用方看 result.ok(与 server 端 test 同约定)。
    res.json(await testLocalSearch({ provider: provider as any, apiKey: req.body?.apiKey, zhipuEngine: req.body?.zhipuEngine }));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'websearch test failed' });
  }
});

export default router;
