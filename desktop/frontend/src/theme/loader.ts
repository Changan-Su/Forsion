/**
 * FOUC-safe 双轴主题加载器:语言(data-theme)走 disabled <link> 切换 + 字体懒挂;
 * 配色(data-skin)走 theme/skins.css 的 [data-skin] 块(静态全量),custom 配色走内联 seed 变量;
 * 明暗 = data-mode + .dark。preset 切换瞬间挂 theme-no-transition 抑制全树过渡抖动。
 */
import './skins.css';
import { themeRegistry, getLanguage, DEFAULT_LANG, DEFAULT_SEED } from './registry';
import { customSkinVars, CUSTOM_SKIN_VAR_KEYS } from './lcl/lovableData';
import { applyThemeSettings } from './themeSettings';

const LINK_ID_PREFIX = 'forsion-theme-css-';
const FONT_LINK_ID_PREFIX = 'forsion-theme-font-';

let currentKey: string | null = null;
let currentCssId: string | null = null;
let themesWarmed = false;

/** 把任意合法 CSS 色解析成 Electron 接受的 #rrggbb；失败就让主进程走明暗兜底。 */
function resolvedWindowBackground(): string | undefined {
  const root = document.documentElement;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;color:var(--bg)';
  root.appendChild(probe);
  try {
    const value = getComputedStyle(probe).color;
    const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length !== 3 || channels.some((n) => !Number.isFinite(n))) return undefined;
    return '#' + channels.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  } finally {
    probe.remove();
  }
}

/** 把主题 manifest 的材质意图同步给 Electron 窗口。浏览器/Web 环境无 preload 时自然 no-op。 */
export function syncWindowMaterial(): void {
  const root = document.documentElement;
  const entry = currentCssId ? getLanguage(currentCssId) : null;
  const wantsGlass = entry?.manifest.windowMaterial === 'system-glass' && root.dataset.glass !== 'off';
  const mode = root.dataset.mode === 'dark' ? 'dark' : 'light';
  const backgroundColor = resolvedWindowBackground();
  try {
    void window.tangu?.setWindowMaterial?.({ material: wantsGlass ? 'system-glass' : 'opaque', mode, backgroundColor });
  } catch { /* browser/no preload */ }
}

function ensureThemeLinks(): void {
  for (const id of Object.keys(themeRegistry)) {
    const linkId = LINK_ID_PREFIX + id;
    if (document.getElementById(linkId)) continue;
    const entry = themeRegistry[id];
    if (entry.cssText !== undefined) {
      // 磁盘主题:CSP 禁 file://,故把主进程读回的 CSS 文本注入 <style>(.disabled 同 <link> 通用)。
      const style = document.createElement('style');
      style.id = linkId;
      style.dataset.themeId = id;
      style.textContent = entry.cssText;
      style.disabled = true;
      document.head.appendChild(style);
    } else if (entry.cssUrl) {
      const link = document.createElement('link');
      link.id = linkId;
      link.rel = 'stylesheet';
      link.href = entry.cssUrl;
      link.dataset.themeId = id;
      link.disabled = true;
      document.head.appendChild(link);
    }
  }
}

/** 移除磁盘主题注入的 <style>(只清 cssText 那批,不动 bundle <link>),使重载能用编辑过的 CSS 重建。 */
export function removeInjectedThemeStyles(): void {
  document.querySelectorAll<HTMLStyleElement>(`style[id^="${LINK_ID_PREFIX}"]`).forEach((n) => n.remove());
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

function ensureFontLink(langId: string): void {
  const entry = getLanguage(langId);
  const families = entry?.manifest.fonts?.google;
  clearFontLinksExcept(langId);
  if (!families || families.length === 0) return;
  const id = FONT_LINK_ID_PREFIX + langId;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = googleFontsHref(families);
  document.head.appendChild(link);
}

/** 应用 语言 × 配色 × 明暗(幂等)。`custom` 配色骑当前语言结构 + 内联 seed 变量(其余中性色回退 :root)。
 *  opts.customColor/customBg 缺省时回退已存 forsion_theme_seed / forsion_theme_bg_seed,
 *  故明暗/语言切换无需调用方再传;customBg 传空串 = 清除背景色(恢复「背景跟随强调色」单色模式)。 */
export function applyTheme(
  langId: string,
  skinId: string,
  mode: 'light' | 'dark',
  opts?: { customColor?: string; customBg?: string },
): void {
  ensureThemeLinks();

  const entry = getLanguage(langId) ?? Object.values(themeRegistry)[0];
  const cssId = entry?.manifest.id ?? DEFAULT_LANG;

  const root = document.documentElement;
  const nextKey = `${cssId}/${skinId}/${mode}`;
  const changed = currentKey !== nextKey;
  if (changed) root.classList.add('theme-no-transition');

  root.dataset.theme = cssId;
  root.dataset.skin = skinId;
  root.dataset.mode = mode;
  if (mode === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');

  // 语言样式切换:启新禁旧(bundle=<link>,磁盘=<style>,二者 .disabled 通用)。
  const next = document.getElementById(LINK_ID_PREFIX + cssId) as HTMLLinkElement | HTMLStyleElement | null;
  if (next) next.disabled = false;
  if (currentCssId && currentCssId !== cssId) {
    const prev = document.getElementById(LINK_ID_PREFIX + currentCssId) as HTMLLinkElement | HTMLStyleElement | null;
    if (prev) prev.disabled = true;
  }

  // 配色:custom 用内联 seed 变量(覆盖 color/mode);命名配色用 skins.css 的 [data-skin] 块,故清掉内联。
  if (skinId === 'custom') {
    let seed = opts?.customColor;
    if (!seed) { try { seed = localStorage.getItem('forsion_theme_seed') || undefined; } catch { /* ignore */ } }
    let bgSeed = opts?.customBg;
    if (bgSeed === undefined) { try { bgSeed = localStorage.getItem('forsion_theme_bg_seed') || undefined; } catch { /* ignore */ } }
    const vars = customSkinVars(seed || DEFAULT_SEED, mode === 'dark', bgSeed || undefined);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    if (opts?.customColor) { try { localStorage.setItem('forsion_theme_seed', opts.customColor); } catch { /* ignore */ } }
    if (opts?.customBg !== undefined) {
      try {
        if (opts.customBg) localStorage.setItem('forsion_theme_bg_seed', opts.customBg);
        else localStorage.removeItem('forsion_theme_bg_seed');
      } catch { /* ignore */ }
    }
  } else {
    for (const k of CUSTOM_SKIN_VAR_KEYS) root.style.removeProperty(k);
  }

  ensureFontLink(cssId);
  // 主题自曝参数 → :root 内联 CSS 变量。必须在 currentCssId 改写**之前**取上一个 entry,
  // 否则切主题时旧主题声明的变量清不掉(会滞留到新主题上)。
  applyThemeSettings(entry, currentCssId ? getLanguage(currentCssId) : null);
  currentKey = nextKey;
  currentCssId = cssId;
  syncWindowMaterial();

  try {
    localStorage.setItem('forsion_theme_lang', cssId);
    localStorage.setItem('forsion_theme_skin', skinId);
    localStorage.setItem('forsion_theme', mode);
  } catch { /* private mode */ }

  if (changed) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (raf) raf(() => raf(() => root.classList.remove('theme-no-transition')));
    else root.classList.remove('theme-no-transition');
  }
}

/** 启动时预热:显式 fetch 各语言 CSS(+字体表)进 HTTP 缓存,后续切换零等待。 */
export function preloadAllThemes(): void {
  ensureThemeLinks();
  if (themesWarmed) return;
  themesWarmed = true;
  for (const id of Object.keys(themeRegistry)) {
    const entry = themeRegistry[id];
    if (entry.cssUrl) { // 磁盘主题(cssText)已注入 DOM,无需预取
      try { void fetch(entry.cssUrl, { cache: 'force-cache' }).catch(() => {}); } catch { /* ignore */ }
    }
    const families = entry.manifest.fonts?.google;
    if (families && families.length) {
      try { void fetch(googleFontsHref(families), { mode: 'no-cors', cache: 'force-cache' }).catch(() => {}); } catch { /* ignore */ }
    }
  }
}
