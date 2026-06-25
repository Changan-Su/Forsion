/**
 * 外部 agent 引擎目录(桌面引擎选择器;handler 自带 authMiddleware)。
 *   GET /agent/engines → { engines: [{ id, name }] }
 * 仅 standalone/desktop(host-only)装配了 deps().engines → 返回清单;microserver/worker(云端)未装配 → []。
 */
import { Router } from 'express';
import { authMiddleware } from '../core/http.js';
import { deps } from '../seams/runtime.js';

const router = Router();

router.get('/agent/engines', authMiddleware, (_req, res) => {
  res.json({ engines: deps().engines?.list() ?? [] });
});

// 懒探测某引擎能力(模型 + slash 命令);云端/无该引擎 → 空。首次会 spawn(慢),manager 内缓存。
router.get('/agent/engines/:id/capabilities', authMiddleware, async (req, res) => {
  try {
    const engines = deps().engines;
    if (!engines || !engines.has(req.params.id)) return res.json({ models: [], commands: [] });
    res.json(await engines.capabilities(req.params.id));
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'probe failed' });
  }
});

// 设某引擎默认模型(设置页「Agent CLIs」);body { defaultModel }。空串=清除。
router.put('/agent/engines/:id', authMiddleware, (req, res) => {
  const engines = deps().engines;
  if (!engines || !engines.has(req.params.id)) return res.status(404).json({ detail: 'unknown engine' });
  const modelId = typeof req.body?.defaultModel === 'string' ? req.body.defaultModel : '';
  engines.setDefaultModel(req.params.id, modelId);
  res.json({ ok: true });
});

export default router;
