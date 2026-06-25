/**
 * FOUC-safe 主题 CSS 加载器(近原样移植自 Forsion-AI-Studio client/themes/loader.ts):
 * 每个主题一条 disabled <link>,切换时先启新再禁旧;preset 切换瞬间挂 theme-no-transition
 * 抑制全树过渡抖动;Google Fonts 按激活主题懒挂、切走即清(离线静默失败,主题自带本地回退字体)。
 */
import { themeRegistry, getTheme } from './registry';

const LINK_ID_PREFIX = 'forsion-theme-css-';
const FONT_LINK_ID_PREFIX = 'forsion-theme-font-';

let currentPresetId: string | null = null;
let themesWarmed = false;

function ensureThemeLinks(): void {
  for (const id of Object.keys(themeRegistry)) {
    const linkId = LINK_ID_PREFIX + id;
    if (document.getElementById(linkId)) continue;
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = themeRegistry[id].cssUrl;
    link.dataset.themeId = id;
    link.disabled = true;
    document.head.appendChild(link);
  }
}

function googleFontsHref(families: string[]): string {
  const params = families.map((f) => 'family=' + f.replace(/ /g, '+')).join('&');
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

function clearFontLinksExcept(activeId: string): void {
  const nodes = document.querySelectorAll<HTMLLinkElement>(`link[id^="${FONT_LINK_ID_PREFIX}"]`);
  nodes.forEach((node) => {
    if (node.id !== FONT_LINK_ID_PREFIX + activeId) node.remove();
  });
}

function ensureFontLink(themeId: string): void {
  const entry = getTheme(themeId);
  const families = entry?.manifest.fonts?.google;
  clearFontLinksExcept(themeId);
  if (!families || families.length === 0) return;
  const id = FONT_LINK_ID_PREFIX + themeId;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = googleFontsHref(families);
  document.head.appendChild(link);
}

/** 应用 preset + 明暗模式(幂等)。 */
export function applyTheme(presetId: string, mode: 'light' | 'dark'): void {
  ensureThemeLinks();

  const entry = getTheme(presetId) ?? Object.values(themeRegistry)[0];
  const resolvedId = entry?.manifest.id ?? presetId;

  const root = document.documentElement;
  const presetChanged = currentPresetId !== resolvedId;
  if (presetChanged) root.classList.add('theme-no-transition');

  root.dataset.theme = resolvedId;
  root.dataset.mode = mode;
  if (mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');

  const next = document.getElementById(LINK_ID_PREFIX + resolvedId) as HTMLLinkElement | null;
  if (next) next.disabled = false;

  if (currentPresetId && currentPresetId !== resolvedId) {
    const prev = document.getElementById(LINK_ID_PREFIX + currentPresetId) as HTMLLinkElement | null;
    if (prev) prev.disabled = true;
  }

  ensureFontLink(resolvedId);
  currentPresetId = resolvedId;

  try {
    localStorage.setItem('forsion_theme_preset', resolvedId);
    localStorage.setItem('forsion_theme', mode);
  } catch { /* private mode */ }

  if (presetChanged) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (raf) raf(() => raf(() => root.classList.remove('theme-no-transition')));
    else root.classList.remove('theme-no-transition');
  }
}

/** 启动时预热:显式 fetch 各主题 CSS(+字体表)进 HTTP 缓存,后续切换零等待。 */
export function preloadAllThemes(): void {
  ensureThemeLinks();
  if (themesWarmed) return;
  themesWarmed = true;
  for (const id of Object.keys(themeRegistry)) {
    const entry = themeRegistry[id];
    try { void fetch(entry.cssUrl, { cache: 'force-cache' }).catch(() => {}); } catch { /* ignore */ }
    const families = entry.manifest.fonts?.google;
    if (families && families.length) {
      try { void fetch(googleFontsHref(families), { mode: 'no-cors', cache: 'force-cache' }).catch(() => {}); } catch { /* ignore */ }
    }
  }
}
