/**
 * Hooks 配置段（`~/.tangu/config.json` 的 `hooks` 段，五段式镜像 services/specialAgentsConfig.ts）。
 *
 *   events : 每事件的 matcher 组 → handlers
 *   state  : 每 hookKey 的 { enabled, trustedHash }（信任/开关，只 user scope 写）
 *
 * 「存在即权威」：段缺失 → 全默认（空）。normalize 绝不抛（坏配置降级为默认，缺字段回落）。
 * host-only：config.json 仅 standalone/desktop 读（core/config.ts:17），云端 getRawSection 恒 undefined。
 */
import { getRawSection, saveSection } from '../core/config.js';
import { hookContentHash, hookKey } from './trust.js';
import {
  HOOK_EVENT_NAMES,
  type DiscoveredHook,
  type HookEventName,
  type HookEventsConfig,
  type HookHandlerConfig,
  type MatcherGroup,
} from './types.js';

export interface HookTrustState {
  enabled: boolean;
  trustedHash: string;
}
export interface HooksConfig {
  events: HookEventsConfig;
  state: Record<string, HookTrustState>;
}

export const HOOKS_DEFAULTS: HooksConfig = { events: {}, state: {} };

const asStr = (v: any, def = ''): string => (typeof v === 'string' ? v : def);

function normalizeHandler(raw: any): HookHandlerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const command = asStr(raw.command);
  if (!command.trim()) return null; // 只支持 command 类型且必须非空
  const h: HookHandlerConfig = { type: 'command', command };
  if (typeof raw.commandWindows === 'string' && raw.commandWindows.trim()) h.commandWindows = raw.commandWindows;
  if (Number.isFinite(Number(raw.timeout))) h.timeout = Math.max(1, Math.floor(Number(raw.timeout)));
  if (typeof raw.statusMessage === 'string' && raw.statusMessage.trim()) h.statusMessage = raw.statusMessage;
  return h;
}

function normalizeGroups(raw: any): MatcherGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: MatcherGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const hooks = Array.isArray(g.hooks)
      ? g.hooks.map(normalizeHandler).filter((h: HookHandlerConfig | null): h is HookHandlerConfig => !!h)
      : [];
    if (!hooks.length) continue;
    const grp: MatcherGroup = { hooks };
    if (typeof g.matcher === 'string' && g.matcher.trim()) grp.matcher = g.matcher.trim();
    out.push(grp);
  }
  return out;
}

/** 合并默认 + 原始，任何缺失/坏字段回落默认。绝不抛。 */
export function normalizeHooksConfig(raw: any): HooksConfig {
  const events: HookEventsConfig = {};
  const rawEvents = (raw && typeof raw === 'object' && raw.events) || {};
  for (const name of HOOK_EVENT_NAMES) {
    const groups = normalizeGroups(rawEvents[name]);
    if (groups.length) events[name] = groups;
  }
  const state: Record<string, HookTrustState> = {};
  const rawState = (raw && typeof raw === 'object' && raw.state) || {};
  if (rawState && typeof rawState === 'object') {
    for (const [k, v] of Object.entries<any>(rawState)) {
      if (!v || typeof v !== 'object') continue;
      state[k] = { enabled: v.enabled !== false, trustedHash: asStr(v.trustedHash) };
    }
  }
  return { events, state };
}

export function loadHooksConfig(): HooksConfig {
  return normalizeHooksConfig(getRawSection('hooks'));
}

export function saveHooksConfig(next: HooksConfig): HooksConfig {
  const merged = normalizeHooksConfig(next);
  saveSection('hooks', merged);
  return merged;
}

/** 展开某事件下所有 handler → DiscoveredHook（带 key/contentHash/trust/active）。P1 仅 user scope。 */
export function discoverHooks(cfg: HooksConfig, event: HookEventName): DiscoveredHook[] {
  const groups = cfg.events[event] || [];
  const out: DiscoveredHook[] = [];
  for (const g of groups) {
    for (const h of g.hooks) {
      const contentHash = hookContentHash(event, g.matcher, h);
      const key = hookKey('user', event, contentHash);
      const st = cfg.state[key];
      const trusted = !!st && st.trustedHash === contentHash;
      const enabled = st ? st.enabled !== false : true;
      out.push({
        key,
        event,
        matcher: g.matcher,
        handler: h,
        source: 'user',
        contentHash,
        trust: trusted ? 'trusted' : 'needs-review',
        enabled,
        active: enabled && trusted,
      });
    }
  }
  return out;
}

export function discoverAll(cfg: HooksConfig): DiscoveredHook[] {
  return HOOK_EVENT_NAMES.flatMap((e) => discoverHooks(cfg, e));
}

/** 信任某 hook（写入其当前 contentHash，保留 enabled）。用于面板/路由的「审阅通过」。 */
export function trustHook(key: string): HooksConfig {
  const cfg = loadHooksConfig();
  const d = discoverAll(cfg).find((h) => h.key === key);
  if (d) {
    cfg.state[key] = { enabled: cfg.state[key]?.enabled !== false, trustedHash: d.contentHash };
    return saveHooksConfig(cfg);
  }
  return cfg;
}

/** 开/关某 hook（保留已有 trustedHash；未信任则补当前 hash——面板开启即视为信任该内容）。 */
export function setHookEnabled(key: string, enabled: boolean): HooksConfig {
  const cfg = loadHooksConfig();
  const d = discoverAll(cfg).find((h) => h.key === key);
  const prev = cfg.state[key];
  cfg.state[key] = { enabled, trustedHash: prev?.trustedHash || d?.contentHash || '' };
  return saveHooksConfig(cfg);
}

/** 面板保存 events 后调用：把所有 user hook 标为已信任（用户在自己的面板里编辑即为审阅通过）。 */
export function syncUserTrust(cfg: HooksConfig): HooksConfig {
  for (const d of discoverAll(cfg)) {
    cfg.state[d.key] = { enabled: cfg.state[d.key]?.enabled !== false, trustedHash: d.contentHash };
  }
  return cfg;
}
