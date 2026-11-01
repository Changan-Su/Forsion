/**
 * 「设置 → 模型 → 提供方 → 发给模型之前」的读写口(llm/outboundMask.ts)。写的是本机 config.json 与 tanguHome/masking/,
 * 云端 worker(hostExec=false)不开放,同 /agent/git-settings。
 */
import { Router } from 'express';
import { authMiddleware } from '../core/http.js';
import { deps } from '../seams/runtime.js';
import { updateSection } from '../core/config.js';
import { maskSettings, readAllowList, allowValue, removeAllow, readMaskLog, DEFAULT_MASK_SETTINGS } from '../llm/outboundMask.js';

const router = Router();
const local = () => deps().profile.capabilities.hostExec;

function summary() {
  const log = readMaskLog();
  const values = new Set<string>(), sessions = new Set<string>();
  for (const l of log) {
    if (l.action !== 'mask') continue;
    for (const h of l.hits) values.add(h.ph);
    if (l.sid) sessions.add(l.sid);
  }
  return { values: values.size, sessions: sessions.size };
}

router.get('/agent/masking', authMiddleware, (_req, res) => {
  if (!local()) return res.json({ writable: false });
  res.json({ writable: true, settings: maskSettings(), defaults: DEFAULT_MASK_SETTINGS, allow: readAllowList(), recent: summary() });
});
router.put('/agent/masking', authMiddleware, (req, res) => {
  if (!local()) return res.status(404).json({ detail: 'Masking settings are only available on a local engine' });
  const b = req.body || {};
  const patch: Record<string, unknown> = {};
  if (typeof b.secrets === 'boolean') patch.secrets = b.secrets;
  if (typeof b.personal === 'boolean') patch.personal = b.personal;
  if (b.action === 'mask' || b.action === 'warn' || b.action === 'block') patch.action = b.action;
  if (!Object.keys(patch).length) return res.status(400).json({ detail: 'masking settings fields required' });
  updateSection('masking', (cur) => ({ ...(cur && typeof cur === 'object' ? cur : {}), ...patch }));
  res.json({ settings: maskSettings() });
});
router.post('/agent/masking/allow', authMiddleware, (req, res) => {
  if (!local()) return res.status(404).json({ detail: 'local engine only' });
  const { value, kind } = req.body || {};
  if (typeof value !== 'string' || !value || typeof kind !== 'string') return res.status(400).json({ detail: 'value and kind required' });
  res.json({ entry: allowValue(value, kind) });
});
router.delete('/agent/masking/allow/:hash', authMiddleware, (req, res) => {
  if (!local()) return res.status(404).json({ detail: 'local engine only' });
  removeAllow(String(req.params.hash));
  res.json({ allow: readAllowList() });
});
router.get('/agent/masking/log', authMiddleware, (_req, res) => {
  if (!local()) return res.status(404).json({ detail: 'local engine only' });
  res.json({ lines: readMaskLog() });
});

export default router;
