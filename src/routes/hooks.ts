/**
 * Lifecycle Hooks 配置（`~/.tangu/config.json` 的 hooks 段）。handler 自带 authMiddleware。
 *   GET   /agent/hooks                读配置 + 按事件展开的发现列表（含 trust/active）
 *   PUT   /agent/hooks   { events }   写 events（面板保存即视为审阅通过 → 全 user hook 自动信任）
 *   POST  /agent/hooks/trust  { key } 审阅通过某 needs-review hook
 *   POST  /agent/hooks/enable { key, enabled }  开/关某 hook
 *
 * 本地特性：profile.capabilities.hostExec=false（云端）一律 404。
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import {
  loadHooksConfig,
  saveHooksConfig,
  syncUserTrust,
  trustHook,
  setHookEnabled,
  discoverAll,
  normalizeHooksConfig,
  HOOK_EVENT_NAMES,
} from '../hooks/index.js';

const router = Router();

function ensureLocal(res: any): boolean {
  if (!deps().profile.capabilities.hostExec) {
    res.status(404).json({ detail: 'Hooks 仅在本地（桌面/TUI）可用' });
    return false;
  }
  return true;
}

/** 发现列表按事件分组（面板逐事件渲染）。 */
function discoveredByEvent(): Record<string, any[]> {
  const cfg = loadHooksConfig();
  const all = discoverAll(cfg);
  const out: Record<string, any[]> = {};
  for (const e of HOOK_EVENT_NAMES) out[e] = [];
  for (const d of all) {
    out[d.event].push({
      key: d.key,
      matcher: d.matcher || '',
      command: d.handler.command,
      commandWindows: d.handler.commandWindows || '',
      timeout: d.handler.timeout || 0,
      statusMessage: d.handler.statusMessage || '',
      source: d.source,
      trust: d.trust,
      enabled: d.enabled,
      active: d.active,
    });
  }
  return out;
}

router.get('/agent/hooks', authMiddleware, async (_req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    res.json({ events: loadHooksConfig().events, discovered: discoveredByEvent(), eventNames: HOOK_EVENT_NAMES });
  } catch (e: any) {
    res.status(500).json({ detail: e?.message || 'load hooks failed' });
  }
});

router.put('/agent/hooks', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const cur = loadHooksConfig();
    // 只替换 events，保留 state；面板保存即审阅通过 → 同步信任所有 user hook。
    const next = normalizeHooksConfig({ events: body.events ?? {}, state: cur.state });
    saveHooksConfig(syncUserTrust(next));
    res.json({ events: loadHooksConfig().events, discovered: discoveredByEvent() });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'save hooks failed' });
  }
});

router.post('/agent/hooks/trust', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const key = String(req.body?.key || '');
    if (!key) { res.status(400).json({ detail: 'key required' }); return; }
    trustHook(key);
    res.json({ discovered: discoveredByEvent() });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'trust failed' });
  }
});

router.post('/agent/hooks/enable', authMiddleware, async (req: AuthRequest, res) => {
  if (!ensureLocal(res)) return;
  try {
    const key = String(req.body?.key || '');
    if (!key) { res.status(400).json({ detail: 'key required' }); return; }
    setHookEnabled(key, req.body?.enabled !== false);
    res.json({ discovered: discoveredByEvent() });
  } catch (e: any) {
    res.status(400).json({ detail: e?.message || 'enable failed' });
  }
});

export default router;
