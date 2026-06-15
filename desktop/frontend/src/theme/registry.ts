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

export const DEFAULT_PRESET = 'qbird';

/** 全部主题,素纸最前,其余按推荐序。 */
export function listThemes(): ThemeEntry[] {
  const preferred = ['sozhi', 'monet', 'qbird'];
  return Object.values(themeRegistry).slice().sort((a, b) => {
    const ia = preferred.indexOf(a.manifest.id);
    const ib = preferred.indexOf(b.manifest.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.manifest.id.localeCompare(b.manifest.id);
  });
}

export function getTheme(id: string): ThemeEntry | null {
  return themeRegistry[id] ?? null;
}

export function hasTheme(id: string): boolean {
  return id in themeRegistry;
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
