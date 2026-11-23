# Amadeus 主题格式

每套主题 = 这个目录下的一个**自包含文件夹** `themes/<id>/`，含两个文件。构建期由 `theme/engine.ts`
用 `import.meta.glob` 自动发现：新建一个文件夹放进去，重新构建即出现在「设置 → 外观 → 主题」，
无需改任何注册代码。（日后若加 runtime drop-in，消费的也是同一格式。）

```
themes/<id>/
├── manifest.ts   元数据 + 可选的自定义取色函数
└── theme.css     该主题的 CSS 变量 + 可选结构样式
```

## manifest.ts

```ts
import type { ThemeManifest } from '../../engine'
const manifest: ThemeManifest = {
  id: 'my-theme',          // 与 theme.css 里的 [data-theme='my-theme'] 一致
  label: 'My Theme · 名',  // 选择器里显示
  swatch: '#8b7fd6',       // 选择器圆点色
  order: 2,                // 排序(越小越前;内置默认 Origin = 0)
  custom: (seed, dark) => ({ '--primary': seed /* … */ }), // 可选,见下
}
export default manifest
```

## theme.css

把整套 UI 用到的 token 在主题作用域里重定义即可（组件 100% 走 `var(--*)`，零硬编码颜色）。

- **调色板**（随明暗变）：`[data-theme='<id>'][data-mode='light']` 与 `[data-theme='<id>'][data-mode='dark']`。
- **非明暗 token**（radii / `--font-ui` 等）：用 `:root[data-theme='<id>']`，确保盖过 Origin 的 `:root` 默认（特异性 0,2,0 > 0,1,0，与加载顺序无关）。
- **结构改造**（可选）：`[data-theme='<id>'] .sidebar { … }` 之类，恒胜裸 `.selector`。Dreamer 即用此把三区做成浮动圆角卡。

需覆盖的 token 契约：

```
背景  --bg --bg-alt           表面  --surface --surface-2
描边  --border --border-strong 文字  --text --text-sec --text-muted
主色  --primary --primary-2 --on-primary
派生  --selection --drop --primary-soft   ← 建议用 color-mix 从 --primary 派生一次,自动跟随
阴影  --shadow-panel
圆角  不在这里声明:Genesis 的 base.css :root 是唯一来源(xs = sm / 2、pill、弃用别名 xl 都在那里),
      Genesis 主题只覆盖 sm / md / lg;契约见仓根 DESIGN §3,棘轮 npm run check:radius
字体  --font-ui   (--font-mono 在 base.css)
```

`Origin` 是默认主题：它的调色板挂在**裸** `[data-mode]` 上（任何未知/旧的 `data-theme` 都回落到它，
不闪烁），font 是 `:root` 默认（圆角不在这里，见上）；其它主题在其上覆盖。`base.css` 只放主题无关项（motion、
`--font-mono`）。

## custom(seed, dark) — 自定义取色（可选）

返回一组要内联到 `<html>` 的 CSS 变量；用户在外观面板取一个种子色时调用，`engine.applyAccent`
负责套用/清除并按主题持久化（`amadeus.accent.<id>`）。约定**只设强调 + 氛围**（如 `--primary`、
背景/渐变），中性色（`--text`/`--border`/`--surface`）留给 theme.css，使任意种子都自然成立。
`--selection/--drop/--primary-soft` 已从 `--primary` 派生，免设。`theme/color.ts` 提供
`hexToRgb / mix / onAccent` 复用。
