/**
 * 内嵌的默认拖入式主题种子。首次运行(~/.tangu/themes/ 不存在时)写入磁盘,此后文件夹完全归用户。
 * soft 从渲染端 bundle 移出后只活在这里 + 用户磁盘 —— 它就是「拖入式主题」的活样板(用户可照抄改色)。
 * ponytail: soft 体积小(<80 行 CSS),内嵌成常量免 extraResources/路径解析(dev+packaged 一致);
 *           种子主题变多再换 electron-builder build.extraResources。
 */
export interface SeedTheme {
  id: string
  /** theme.json 文本(写盘内容)。 */
  json: string
  /** theme.css 文本(写盘内容)。 */
  css: string
}

const SOFT_MANIFEST = {
  id: 'soft',
  name: 'Soft · 柔影',
  description: '柔影浮卡 · 大圆角(LCL soft 结构语言)。渐变舞台 + 角落辉光 + 圆角浮卡,Plus Jakarta Sans。颜色由「配色」决定。',
  version: '1.0.0',
  author: 'Forsion',
  supportsDarkMode: true,
  tags: ['lcl', 'soft', 'rounded'],
  // 浮卡布局信号:渲染端 Root 据此给 Shell 加面板间距(取代旧的 theme.lang==='soft' 魔法字符串)。
  panelGap: 8,
  fonts: { google: ['Plus Jakarta Sans:wght@400;500;600;700', 'Nunito:wght@400;600;700;800'] },
  preview: {
    shape: 'soft' as const,
    background: {
      light: 'linear-gradient(158deg, #fceee4 0%, #f6edf9 52%, #edeefc 100%)',
      dark: 'linear-gradient(158deg, #221c2e 0%, #1d1a28 55%, #181a2a 100%)',
    },
    accent: '#8b7fd6',
    title: { text: 'Soft' },
    tagline: '柔影浮卡 · 大圆角',
    swatches: ['#8b7fd6', '#f6edf9', '#6b6675', '#c3b8ee'],
  },
}

const SOFT_CSS = `/**
 * Soft — 设计语言:柔影浮卡 · 结构层(LCL「soft」基底,源自 Amadeus/tanguSoft)。
 * 双轴主题模型:**语言只管结构**(大圆角 · Plus Jakarta · 柔影 · 渐变舞台 + 角落辉光 + 每个停靠面板成独立圆角浮卡),
 * **颜色由配色(data-skin)决定**(故 soft + 任意配色 = 浮卡结构 + 该配色)。\`--glow\`/\`--bg\` 由配色给,这里只「用」。
 */

[data-theme='soft'] {
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 18px;
  --radius-chat-surface: 20px;
  --radius-chat-card: 14px;
  --font-ui: 'Plus Jakarta Sans', 'Nunito', ui-rounded, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
  --panel-blur: none;
  /* 阴影形态归 soft，阴影色归当前 skin：旧值写死薰衣草紫，soft × coral/teal 会无故泛紫。 */
  --card-shadow: 0 1px 2px var(--shadow), 0 12px 30px -10px var(--shadow);
  --btn-shadow: 0 3px 12px var(--shadow);
  --icon-shadow: 0 1px 5px var(--shadow);
}

@supports (color: color-mix(in srgb, red 50%, transparent)) {
  [data-theme='soft'] {
    --card-shadow: 0 1px 2px var(--shadow), 0 12px 30px -10px color-mix(in srgb, var(--accent-ink) 16%, transparent);
    --btn-shadow: 0 3px 12px color-mix(in srgb, var(--accent-ink) 22%, transparent);
    --icon-shadow: 0 1px 5px color-mix(in srgb, var(--accent-ink) 14%, transparent);
  }
}

.dark[data-theme='soft'] {
  --card-shadow: 0 1px 2px var(--shadow), 0 14px 34px -10px var(--shadow);
  --btn-shadow: 0 3px 12px var(--shadow);
  --icon-shadow: 0 1px 5px var(--shadow);
}

/* ─── soft 结构:渐变舞台 + 角落辉光 + 内嵌留白 + 每个停靠面板成独立圆角浮卡 ───
 * (soft 不止换色:外壳面板要浮起来。仅 soft 语言生效,lovable 仍扁平满铺。
 *  导航/对话/右栏 都是 Dockview 组,各自卡片化 + theme.gap=8 拉开 → 独立浮卡。
 *  --bg/--glow 由当前配色(data-skin)提供,故 soft × 任意配色 都成立。) */
[data-theme='soft'] .shell {
  background: var(--glow, transparent), var(--bg);
  padding: 8px;
  gap: 8px;
}
[data-theme='soft'] .shell-titlebar {
  background: transparent;
  border: 0;
  height: 22px;
}
[data-theme='soft'] .shell-top {
  background: transparent;
  gap: 8px;
}
[data-theme='soft'] .shell-work { background: transparent; }
[data-theme='soft'] .rb,
[data-theme='soft'] .sb {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--card-shadow);
  border: var(--border-width, 1px) solid color-mix(in srgb, var(--border) 70%, transparent);
}
[data-theme='soft'] .rb { width: 48px; padding-block: 9px; }
[data-theme='soft'] .sb { height: 26px; }
[data-theme='soft'] .dockview-theme-lcl .dv-groupview {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--card-shadow);
  overflow: hidden;
}
[data-theme='soft'] .t2-toolbar {
  background: color-mix(in srgb, var(--bg-card) 90%, transparent);
  border-bottom-color: color-mix(in srgb, var(--border) 70%, transparent);
}
[data-theme='soft'] .t2c-card { border-radius: 22px; }
[data-theme='soft'] .composer-anchor {
  background: linear-gradient(to top, color-mix(in srgb, var(--bg-card) 78%, transparent), transparent);
}
[data-theme='soft'] .dockview-theme-lcl {
  --dv-background-color: transparent;
  --dv-group-view-background-color: transparent;
  --dv-tabs-and-actions-container-background-color: transparent;
  --dv-activegroup-visiblepanel-tab-background-color: var(--overlay-light);
  --dv-inactivegroup-visiblepanel-tab-background-color: transparent;
}
[data-theme='soft'] .dockview-theme-lcl .dv-tabs-and-actions-container {
  border-bottom-color: color-mix(in srgb, var(--border) 65%, transparent);
}
`

export const SEED_THEMES: SeedTheme[] = [
  { id: 'soft', json: JSON.stringify(SOFT_MANIFEST, null, 2) + '\n', css: SOFT_CSS },
]
