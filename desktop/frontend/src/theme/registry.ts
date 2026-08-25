/// <reference types="vite/client" />
/**
 * 双轴主题注册表:**设计语言(data-theme)× 配色(data-skin)× 明暗(data-mode)**。
 * - 语言 = 文件夹主题(themes/<id>/{theme.json,theme.css}),构建期 import.meta.glob 收集,只管 UI 结构(圆角/字体/阴影/布局)。
 *   bundle 语言按目录自动发现,磁盘语言在运行时合并。
 * - 配色 = 纯颜色,见 theme/skins.css 的 [data-skin]/ .dark[data-skin] 块(cream/coral/teal/lavender/zhi);custom 走内联 seed 变量。
 * 旧单轴 preset(lovable/echo/qbird/dreamer/custom)首启自动迁移到 (lang, skin)。
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

/** 配色条目(纯颜色;CSS 在 theme/skins.css)。swatch 仅供设置面板色卡预览。custom 用 seed 动态取色。 */
export interface SkinInfo {
  id: 'cream' | 'coral' | 'teal' | 'lavender' | 'zhi' | 'custom';
  /** 强调色(色卡主点) */
  accent: string;
  /** 浅色底(色卡背景) */
  bg: string;
}

const SKINS: SkinInfo[] = [
  { id: 'cream', accent: '#1c1c1c', bg: '#f8f7f6' },
  { id: 'coral', accent: '#ff8a6b', bg: '#fbf5ef' },
  { id: 'teal', accent: '#4d8794', bg: '#f5f5f7' },
  { id: 'lavender', accent: '#8b7fd6', bg: '#f4eef7' },
  { id: 'zhi', accent: '#1e96eb', bg: '#ffffff' },
  { id: 'custom', accent: DEFAULT_SEED, bg: '#f6f6f7' },
];

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

/** 全部配色(含 custom 殿后)。 */
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
