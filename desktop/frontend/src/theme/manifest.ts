/**
 * 主题 manifest schema(移植自 Forsion-AI-Studio themes/_schema/manifest.ts,机制同源)。
 * 新增主题:src/theme/themes/<id>/ 下放 theme.json(本 shape)+ theme.css,重启 dev 即被注册表收录。
 */
export interface ThemeManifest {
  /** 稳定 id,kebab-case,必须等于目录名。 */
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  /** 是否提供独立暗色样式(.dark[data-theme=…])。 */
  supportsDarkMode: boolean;
  /** 浮卡布局信号:>0 时 Shell 给停靠面板留间距(soft=8)。取代旧的 lang==='soft' 魔法字符串。 */
  panelGap?: number;
  /** 请求宿主窗口提供跨窗取样的系统玻璃;缺省 opaque,非 macOS 当前安全降级为实色。 */
  windowMaterial?: 'system-glass';
  /**
   * 锁定明暗:声明后该主题的明暗不可手动改,强制取此值(明暗切换在设置/ribbon 里被禁用)。
   * `'system'` = 跟随系统主题(随 OS 明暗实时切换);`'light'`/`'dark'` = 固定单侧(如仅深色主题)。
   * 缺省 = 用户自由选(含用户自己选的「跟随系统」)。
   */
  colorScheme?: 'system' | 'light' | 'dark';
  tags?: string[];
  /** 主题激活时懒加载的 Google Fonts(离线环境会静默失败,主题需有本地字体回退)。 */
  fonts?: { google?: string[] };
  /** 主题自曝的可调参数;渲染在设置→主题里选中卡的下方,值落 :root 内联 CSS 变量。见 ThemeSetting。 */
  settings?: ThemeSetting[];
  preview: ThemePreview;
}

/**
 * 主题声明的可调参数。**`key` 就是 CSS 自定义属性名**(必须 `--` 开头)——宿主直接把值 setProperty
 * 到 :root,主题 CSS 用 `var(--key, <默认>)` 消费。没有中间映射层,声明即接线。
 *
 * 主题 CSS 里的 `var()` 兜底值必须与这里的 `default` 一致:首帧(磁盘主题 <style> 注入前)和
 * 「重置」之后都靠那个兜底,对不上就会两个值来回跳。
 *
 * ⚠ theme.json 是不可信的用户文件,而值最终进 CSS —— 四种类型都是**受限值域**(数字钳到 min/max、
 * select 必须命中自带选项、boolean 只在自带的 on/off 里二选一、color 必须是 #hex),
 * 且 key 必须过 `/^--[a-z0-9-]+$/i`。故没有自由文本能流进 setProperty。
 */
export type ThemeSetting =
  | ThemeSettingBase & { type: 'number'; default: number; min: number; max: number; step?: number; unit?: string }
  | ThemeSettingBase & { type: 'select'; default: string; options: Array<{ value: string; label: string }> }
  /** on/off 是写进 CSS 的两个值(如 '1px' / '0px'),不是 true/false。 */
  | ThemeSettingBase & { type: 'boolean'; default: boolean; on: string; off: string }
  | ThemeSettingBase & { type: 'color'; default: string };

interface ThemeSettingBase {
  /** = CSS 自定义属性名,`--kebab-case`。 */
  key: string;
  label: string;
  description?: string;
}

export interface ThemePreview {
  /** 预览只表达结构语言；颜色始终取当前 skin，避免语言卡再次私藏一套配色。 */
  shape?: 'paper' | 'glass' | 'soft' | 'compact';
  background: string | { light: string; dark: string };
  accent: string;
  label?: string;
  title?: { text?: string };
  swatches?: string[];
  tagline?: string;
}

export interface ThemeEntry {
  manifest: ThemeManifest;
  /** bundle 主题:Vite 资源 URL,走 <link>。 */
  cssUrl?: string;
  /** 磁盘主题:主进程读回的 CSS 文本,走 <style>(CSP 禁 file://)。 */
  cssText?: string;
}
