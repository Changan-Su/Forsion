/// <reference types="vite/client" />
/**
 * 主题注册表:**设计语言(data-theme)× 主题色(data-skin)× 背景色(data-bg)× 明暗(data-mode)**。
 * - 语言 = 文件夹主题(themes/<id>/{theme.json,theme.css}),构建期 import.meta.glob 收集,只管 UI 结构(圆角/字体/阴影/布局)。
 *   bundle 语言按目录自动发现,磁盘语言在运行时合并。
 * - 主题色 / 背景色 = 纯颜色,见 theme/skins.css 的 [data-skin] / [data-bg] 两组块(cream/coral/teal/lavender/zhi);
 *   两轴各有 custom,走内联 seed 变量。**两轴同 id = 拆轴前的整套配色**,故老用户默认观感不变。
 * 旧单轴 preset(lovable/echo/qbird/dreamer/custom)首启自动迁移到 (lang, skin);背景色缺省承接 skin。
 */
import type { ThemeManifest, ThemeEntry } from './manifest';

export type { ThemeManifest, ThemeEntry, ThemePreview } from './manifest';

const manifestModules = import.meta.glob<ThemeManifest>('./themes/*/theme.json', {
  eager: true,
  import: 'default',
});

const cssUrlModules = import.meta.glob<string>('./themes/*/theme.css', {
  eager: true,
  query: '?url',
  import: 'default',
});

function folderIdFromPath(path: string): string {
  const parts = path.split('/');
  const idx = parts.findIndex((p) => p === 'themes');
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : '';
}

function buildRegistry(): Record<string, ThemeEntry> {
  const result: Record<string, ThemeEntry> = {};
  for (const [path, manifest] of Object.entries(manifestModules)) {
    const id = folderIdFromPath(path);
    if (!id) continue;
    const cssUrl = cssUrlModules[path.replace(/theme\.json$/, 'theme.css')];
    if (!cssUrl) {
      console.warn(`[themes] language "${id}" is missing theme.css — skipping.`);
      continue;
    }
    result[id] = { manifest: { ...manifest, id }, cssUrl };
  }
  return result;
}

/** 语言注册表:bundle 项(import.meta.glob,现只剩 lovable 基底)+ 运行时合并进来的磁盘主题。**可变**。 */
export const themeRegistry: Record<string, ThemeEntry> = buildRegistry();

/** 合并磁盘主题(来自 window.tangu.listThemes,manifest 为不可信用户文件);bundle 项(有 cssUrl)不可被覆盖。 */
export function mergeDiskThemes(list: Array<{ id: string; manifest: Record<string, unknown>; css: string }>): void {
  for (const t of list) {
    const id = String((t.manifest?.id as string) || t.id || '').trim();
    if (!id) continue;
    const existing = themeRegistry[id];
    if (existing && existing.cssUrl) continue; // bundle 基底(lovable)不可被磁盘覆盖
    themeRegistry[id] = { manifest: { ...t.manifest, id } as unknown as ThemeManifest, cssText: t.css };
  }
}

/** 清掉所有磁盘主题项(cssText),保留 bundle 项。重载前调用(配合 loader.removeInjectedThemeStyles)。 */
export function clearDiskThemes(): void {
  for (const id of Object.keys(themeRegistry)) {
    if (themeRegistry[id].cssText !== undefined) delete themeRegistry[id];
  }
}

export const DEFAULT_LANG = 'lovable';
export const DEFAULT_SKIN = 'cream';
export const DEFAULT_SEED = '#8b7fd6';

/** 配色条目(纯颜色;CSS 在 theme/skins.css)。**同一张表供两根轴用**:主题色轴取 `accent`,背景色轴取 `bg`
 *  —— 它们本来就是同一套调色板被拆成的两半。swatch 仅供设置面板色卡预览。custom 用 seed 动态取色。 */
export interface SkinInfo {
  id: 'cream' | 'coral' | 'teal' | 'lavender' | 'zhi' | 'custom';
  /** 强调色(主题色轴的色卡点) */
  accent: string;
  /** 暗色下的强调色 */
  accentDark: string;
  /** 舞台底色(背景色轴的色卡点) */
  bg: string;
  /** 暗色下的舞台底色 */
  bgDark: string;
  /** 背景家族的完整色度种子；设置面板用它表达颜色身份，不能拿近白/近黑的最终表面代替。 */
  bgSeed: string;
}

/** bg/bgDark 必须与 skins.css 的 --bg 对齐；bgSeed 是生成/辨认背景家族的原色，不直接铺满页面。 */
const SKINS: SkinInfo[] = [
  { id: 'cream', accent: '#1c1c1c', accentDark: '#f8f7f6', bg: '#f8f7f6', bgDark: '#2a292b', bgSeed: '#9a8f84' },
  { id: 'coral', accent: '#ff8a6b', accentDark: '#ff9a7d', bg: '#f7e5dc', bgDark: '#292727', bgSeed: '#ff8a6b' },
  { id: 'teal', accent: '#4d8794', accentDark: '#5fa3b2', bg: '#dff1ea', bgDark: '#272a2a', bgSeed: '#4d8794' },
  { id: 'lavender', accent: '#8b7fd6', accentDark: '#a99cf0', bg: '#ede0f5', bgDark: '#29272c', bgSeed: '#8b7fd6' },
  { id: 'zhi', accent: '#1e96eb', accentDark: '#1c9ee4', bg: '#dcecfb', bgDark: '#272a2e', bgSeed: '#1e96eb' },
  { id: 'custom', accent: DEFAULT_SEED, accentDark: DEFAULT_SEED, bg: '#f6f6f7', bgDark: '#1b1b1d', bgSeed: DEFAULT_SEED },
];

/** 色卡取当前明暗那一面 —— 暗色下拿浅色底当背景色卡会骗人。 */
export function skinSwatch(sk: SkinInfo, dark: boolean, axis: 'accent' | 'bg'): string {
  if (axis === 'accent') return dark ? sk.accentDark : sk.accent;
  return dark ? sk.bgDark : sk.bg;
}

/** 背景色点同时展示「完整种子色」和「当前明暗的真实舞台面」。
 *  主段负责可辨认，右下小段负责诚实预告落地结果；不再把六个近白/近黑点摆成同一种颜色。 */
export function backgroundSwatch(sk: SkinInfo, dark: boolean, seed = sk.bgSeed): string {
  return `linear-gradient(135deg, ${seed} 0 64%, ${skinSwatch(sk, dark, 'bg')} 64% 100%)`
}

/** 全部语言:lovable(bundle 基底)殿前,其余按 id 字母序(含磁盘主题)。 */
export function listLanguages(): ThemeEntry[] {
  return Object.values(themeRegistry).slice().sort((a, b) => {
    if (a.manifest.id === DEFAULT_LANG) return -1;
    if (b.manifest.id === DEFAULT_LANG) return 1;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

export function getLanguage(id: string): ThemeEntry | null {
  return themeRegistry[id] ?? null;
}

export function hasLanguage(id: string): boolean {
  return id in themeRegistry;
}

/** 全部配色(含 custom 殿后)。主题色轴与背景色轴共用这张表。 */
export function listSkins(): SkinInfo[] {
  return SKINS;
}

export function hasSkin(id: string): boolean {
  return SKINS.some((s) => s.id === id);
}

/** 旧单轴 preset → 新 (lang, skin) 迁移表。 */
const PRESET_MIGRATION: Record<string, { lang: string; skin: string }> = {
  lovable: { lang: 'lovable', skin: 'cream' },
  echo: { lang: 'lovable', skin: 'coral' },
  qbird: { lang: 'lovable', skin: 'teal' },
  dreamer: { lang: 'soft', skin: 'lavender' },
  custom: { lang: 'lovable', skin: 'custom' },
};

function legacyPreset(): { lang: string; skin: string } | null {
  try {
    const raw = localStorage.getItem('forsion_theme_preset');
    if (raw && PRESET_MIGRATION[raw]) return PRESET_MIGRATION[raw];
  } catch { /* private mode */ }
  return null;
}

/** 启动解析语言:新键 forsion_theme_lang 优先 → 旧 preset 迁移 → 默认。 */
export function resolveInitialLang(): string {
  try {
    const raw = localStorage.getItem('forsion_theme_lang');
    if (raw && hasLanguage(raw)) return raw;
  } catch { /* private mode */ }
  const migrated = legacyPreset();
  if (migrated && hasLanguage(migrated.lang)) return migrated.lang;
  if (hasLanguage(DEFAULT_LANG)) return DEFAULT_LANG;
  return Object.keys(themeRegistry)[0] ?? DEFAULT_LANG;
}

/** 启动解析配色:新键 forsion_theme_skin 优先 → 旧 preset 迁移 → 默认。 */
export function resolveInitialSkin(): string {
  try {
    const raw = localStorage.getItem('forsion_theme_skin');
    // zhi 在拆轴前会把 cream 的整套颜色强制成知蓝。只迁默认位一次，避免升级后老用户突然变成炭黑奶油色；
    // 其余用户明确选过的 coral/teal/lavender/custom 保留，让它们从此按真正的配色轴完整生效。
    if (localStorage.getItem('forsion_theme_lang') === 'zhi' && raw === 'cream'
      && localStorage.getItem('forsion_theme_zhi_skin_v1') !== '1') {
      localStorage.setItem('forsion_theme_skin', 'zhi');
      localStorage.setItem('forsion_theme_zhi_skin_v1', '1');
      return 'zhi';
    }
    if (raw && hasSkin(raw)) return raw;
  } catch { /* private mode */ }
  const migrated = legacyPreset();
  if (migrated && hasSkin(migrated.skin)) return migrated.skin;
  return DEFAULT_SKIN;
}

/** 启动解析背景色:新键 forsion_theme_bg 优先 → **回退到主题色 id**(= 拆轴前的整套配色,老用户观感不变)。 */
export function resolveInitialBg(): string {
  try {
    const raw = localStorage.getItem('forsion_theme_bg');
    if (raw && hasSkin(raw)) return raw;
  } catch { /* private mode */ }
  return resolveInitialSkin();
}

/** 明暗偏好(用户可选 system=跟随系统);真源 forsion_theme_pref,回退老键 forsion_theme(纯明暗)。 */
export function resolveInitialModePref(): 'light' | 'dark' | 'system' {
  try {
    const p = localStorage.getItem('forsion_theme_pref');
    if (p === 'light' || p === 'dark' || p === 'system') return p;
    const legacy = localStorage.getItem('forsion_theme'); // 老用户显式明暗,平滑迁移为等价偏好
    if (legacy === 'light' || legacy === 'dark') return legacy;
  } catch { /* private mode */ }
  return 'light';
}

/** system 偏好解析为当前系统明暗;非浏览器环境兜底 light。 */
export function systemMode(): 'light' | 'dark' {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  catch { return 'light'; }
}

/** 用户偏好解析后的明暗(偏好=system 时取系统值)。不含主题强制。 */
export function resolveInitialMode(): 'light' | 'dark' {
  const pref = resolveInitialModePref();
  return pref === 'system' ? systemMode() : pref;
}

/**
 * 首屏**落地**明暗:forced_scheme(上次会话锁定主题的强制值)> 用户偏好 > 老键。
 * bootstrap 与 store 初始 mode 都用它 —— 否则会先按用户偏好(忽略强制)渲染一帧,
 * 待磁盘 manifest 异步合并后才被 initThemes 纠回强制值 → 慢盘下可见闪(codex High-1)。
 * 与 index.html 首屏脚本同一优先级,保持一致。
 */
export function resolveInitialEffectiveMode(): 'light' | 'dark' {
  try {
    const forced = localStorage.getItem('forsion_theme_forced_scheme');
    if (forced === 'light' || forced === 'dark') return forced;
    if (forced === 'system') return systemMode();
  } catch { /* private mode */ }
  return resolveInitialMode();
}

/** 主题 manifest 锁定的 colorScheme(校验后;磁盘 manifest 不可信)。store 与设置面板共用,避免各判各的。 */
export function forcedSchemeForLanguage(lang: string): 'light' | 'dark' | 'system' | undefined {
  const cs = getLanguage(lang)?.manifest.colorScheme;
  return cs === 'system' || cs === 'light' || cs === 'dark' ? cs : undefined;
}
