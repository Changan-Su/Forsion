/**
 * 主题可调参数:manifest 的 `settings[]` → :root 内联 CSS 变量。
 *
 * 机制对齐插件的 registerSetting(值落 localStorage `theme.<themeId>.<key>`,回到默认即删键),
 * 差别在于插件自己用 JS 读值,而主题是纯 CSS —— 所以必须由宿主把值写成 CSS 变量。
 * 写法与 custom 配色的 9 个 seed 键同源(内联样式,穿透一切选择器)。
 *
 * ⚠ theme.json 是不可信的用户文件,值最终进 setProperty。故本文件是**信任边界**:
 * 每种类型都收敛到受限值域,key 不合规整条丢弃。纯函数部分无 DOM 依赖,便于 vitest 覆盖。
 */
import type { ThemeEntry, ThemeSetting } from './manifest';
import { isMotionToken } from './motionGuard';

const KEY_RE = /^--[a-z0-9-]+$/i;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const lsKeyFor = (themeId: string, settingKey: string): string => `theme.${themeId}.${settingKey}`;

/** manifest 里结构合法、key 可安全写进 CSS 的那些设置项(坏项静默丢弃,不拖垮整个主题)。 */
export function usableSettings(entry: ThemeEntry | null | undefined): ThemeSetting[] {
  const list = entry?.manifest?.settings;
  if (!Array.isArray(list)) return [];
  return list.filter((s) => {
    if (!s || typeof s !== 'object' || !KEY_RE.test(String(s.key)) || typeof s.label !== 'string') return false;
    // 动效 token 不许做成就地调参(动效收口:动效归宿主管,见 motionGuard.ts)
    if (isMotionToken(String(s.key))) return false;
    switch (s.type) {
      case 'number':
        return Number.isFinite(s.default) && Number.isFinite(s.min) && Number.isFinite(s.max) && s.min < s.max;
      case 'select':
        return Array.isArray(s.options) && s.options.length > 0
          && s.options.every((o) => o && typeof o.value === 'string' && typeof o.label === 'string');
      case 'boolean':
        return typeof s.on === 'string' && typeof s.off === 'string';
      case 'color':
        return HEX_RE.test(String(s.default));
      default:
        return false;
    }
  });
}

/** 原始存值(localStorage 里的字符串,null=未设)→ 可写进 CSS 的字符串。越界/非法一律回落 default。 */
export function toCssValue(setting: ThemeSetting, raw: string | null): string {
  switch (setting.type) {
    case 'number': {
      // ⚠ 空串必须当「未设」:Number('') === 0 是有限值,不拦的话用户清空输入框会被钳到 min
      //   而不是回到默认(单测钉住)。
      const n = raw === null || raw.trim() === '' ? setting.default : Number(raw);
      const safe = Number.isFinite(n) ? Math.min(setting.max, Math.max(setting.min, n)) : setting.default;
      return `${safe}${setting.unit ?? ''}`;
    }
    case 'select':
      return setting.options.some((o) => o.value === raw) ? (raw as string) : setting.default;
    case 'boolean': {
      const on = raw === null ? setting.default : raw === 'true';
      return on ? setting.on : setting.off;
    }
    case 'color':
      return raw !== null && HEX_RE.test(raw) ? raw : setting.default;
  }
}

/** 读一项的「表单值」(给控件用的原始串,不是 CSS 值);未设时给 default 的字符串形式。 */
export function readRaw(themeId: string, setting: ThemeSetting): string {
  try {
    const v = localStorage.getItem(lsKeyFor(themeId, setting.key));
    if (v !== null) return v;
  } catch { /* private mode */ }
  return String(setting.default);
}

/** 写一项;回到默认=删键(与插件 SettingRow 同约定,便于「重置」和默认值日后调整)。 */
export function writeRaw(themeId: string, setting: ThemeSetting, raw: string): void {
  try {
    if (raw === String(setting.default)) localStorage.removeItem(lsKeyFor(themeId, setting.key));
    else localStorage.setItem(lsKeyFor(themeId, setting.key), raw);
  } catch { /* 配额满等,忽略 */ }
}

export function resetAll(themeId: string, settings: ThemeSetting[]): void {
  for (const s of settings) {
    try { localStorage.removeItem(lsKeyFor(themeId, s.key)); } catch { /* ignore */ }
  }
}

/**
 * 把 entry 的参数刷到 :root。prev 是上一个主题的 entry —— 必须传,否则切走后它的变量会滞留
 * (下一个主题若碰巧同名 key 就会读到上一个主题的值)。
 */
export function applyThemeSettings(entry: ThemeEntry | null | undefined, prev?: ThemeEntry | null): void {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root) return;
  const nextKeys = new Set<string>();
  const settings = usableSettings(entry);
  const themeId = entry?.manifest?.id ?? '';
  for (const s of settings) {
    nextKeys.add(s.key);
    root.style.setProperty(s.key, toCssValue(s, rawOrNull(themeId, s.key)));
  }
  // 只清「上一个主题声明过、这一个不再声明」的键,不碰别人的内联变量(custom 配色 seed 等)。
  if (prev && prev.manifest?.id !== entry?.manifest?.id) {
    for (const s of usableSettings(prev)) {
      if (!nextKeys.has(s.key)) root.style.removeProperty(s.key);
    }
  }
}

function rawOrNull(themeId: string, key: string): string | null {
  try { return localStorage.getItem(lsKeyFor(themeId, key)); } catch { return null; }
}
