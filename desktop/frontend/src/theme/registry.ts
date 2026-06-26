/// <reference types="vite/client" />
/**
 * 主题注册表(移植自 Forsion-AI-Studio client/themes/registry.ts):
 * 构建期 import.meta.glob 收集 ./themes/<id>/{theme.json,theme.css},CSS 以 ?url 引用,
 * 只有激活主题的 <link> 生效。桌面默认主题 = 素纸(sozhi)。
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
      console.warn(`[themes] theme "${id}" is missing theme.css — skipping.`);
      continue;
    }
    result[id] = { manifest: { ...manifest, id }, cssUrl };
  }
  return result;
}

export const themeRegistry: Readonly<Record<string, ThemeEntry>> = Object.freeze(buildRegistry());

export const DEFAULT_PRESET = 'lovable';
export const DEFAULT_SEED = '#8b7fd6';

/** 「自定义」取色皮肤:无 theme.css 文件夹,骑 lovable 基底 CSS,强调色+背景由内联 seed 变量驱动
 *  (见 theme/loader.ts applyTheme 的 custom 分支)。cssUrl 指向 lovable 作兜底。 */
const CUSTOM_THEME_ENTRY: ThemeEntry = {
  manifest: {
    id: 'custom',
    name: '自定义',
    description: '取色 · 自适应。强调色由你定,背景氛围微染,明暗自适应。',
    version: '1.0.0',
    author: 'Forsion',
    supportsDarkMode: true,
    tags: ['lcl', 'custom'],
    preview: {
      background: {
        light: 'linear-gradient(135deg, #f6f6f7 0%, #eeeef0 100%)',
        dark: 'linear-gradient(135deg, #1b1b1d 0%, #29292b 100%)',
      },
      accent: DEFAULT_SEED,
      title: { text: '自定义' },
      tagline: '取色 · 自适应',
      swatches: [DEFAULT_SEED, '#f6f6f7', '#6e6e73', '#e6e6e9'],
    },
  },
  cssUrl: themeRegistry['lovable']?.cssUrl ?? Object.values(themeRegistry)[0]?.cssUrl ?? '',
};

/** 全部主题:lovable/echo/qbird/dreamer 按推荐序,「自定义」殿后。 */
export function listThemes(): ThemeEntry[] {
  const preferred = ['lovable', 'echo', 'qbird', 'dreamer'];
  const folders = Object.values(themeRegistry).slice().sort((a, b) => {
    const ia = preferred.indexOf(a.manifest.id);
    const ib = preferred.indexOf(b.manifest.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
  return [...folders, CUSTOM_THEME_ENTRY];
}

export function getTheme(id: string): ThemeEntry | null {
  if (id === 'custom') return CUSTOM_THEME_ENTRY;
  return themeRegistry[id] ?? null;
}

export function hasTheme(id: string): boolean {
  return id === 'custom' || id in themeRegistry;
}

/** 启动时解析应使用的 preset(localStorage 键与全家桶一致:forsion_theme_preset)。 */
export function resolveInitialPreset(): string {
  let raw: string | null = null;
  try { raw = localStorage.getItem('forsion_theme_preset'); } catch { /* private mode */ }
  if (raw && hasTheme(raw)) return raw;
  if (hasTheme(DEFAULT_PRESET)) return DEFAULT_PRESET;
  const first = Object.keys(themeRegistry)[0];
  return first ?? DEFAULT_PRESET;
}

export function resolveInitialMode(): 'light' | 'dark' {
  try {
    const raw = localStorage.getItem('forsion_theme');
    if (raw === 'dark' || raw === 'light') return raw;
  } catch { /* private mode */ }
  return 'light';
}
