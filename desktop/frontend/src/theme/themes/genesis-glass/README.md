# Genesis Glass · 琉璃

设计语言 = Genesis 结构 × macOS 原生玻璃。**本主题一个颜色键都不声明** —— 所有材质都是配色 token 的
`color-mix` 半透版,故任意配色(cream/coral/teal/lavender/zhi/custom)× 亮暗全部自动成立,
也就不存在「暗色块漏键拿到亮色值」的对称问题。

跨主题的通用纪律见仓根 `DESIGN.md`;这里只写**本主题特有的东西和踩过的坑**。

## 材质分档

| 档 | 变量 | 谁用 | 备注 |
|---|---|---|---|
| 0 stage | `--gl-stage` | `html`/`body`/`.shell`/`.wb-dockview` | 一路透到窗口,让原生 vibrancy 成为唯一底 |
| 1 chrome | `--gl-chrome` | ribbon、主区外框 | 只染色 |
| 2 pane | `--gl-pane` | 侧栏组(文字密度高,比 chrome 厚一档) | 只染色 |
| 3 paper | `--gl-paper` | 主视图纸卡 | **全实色**,可读性锚点 |
| 3.5 thin | `--gl-thin`(50%) | 输入卡（主页现有 Chatbox 为 46%） | 身后有正文在动,保留明显的景深透色 |
| 3.6 menu | `--gl-menu`(默认 58%) | 一级/二级菜单、popover | 与输入卡共用高光和模糊,只加厚一档 |
| 4 float | `--gl-float`(默认 72%) | 弹窗、命令面板、toast | 信息密度更高,但仍能看见被打散的背景 |
| fallback | `--gl-side`(默认 84%) | 侧栏输入卡、Ribbon / 侧栏浮层 | 没有可靠页面像素可糊时靠染色保证可读 |

浓度旋钮(chrome/pane/float/模糊半径/饱和度)已接进**设置 → 主题 → 选中卡下方的滑块**
(`theme.json` 的 `settings[]`,宿主把值写成 `:root` 内联变量)。
`--gl-thin` **不接旋钮**,写字面值；「浮层浓度」是大型浮层的基准，菜单自动比它薄 14 个百分点，
侧栏兜底自动比它厚 12 个百分点。三档共享 `--gl-sheen` 和同一 `--gl-blur-float`，层级不同但质感必须一致。
带 `--gl-*-pct` 的写法专留给 `theme.json` 声明过的档位,
且那些兜底值必须与 `theme.json` 的 `default` **逐字一致**(`themeSettings.test.ts` 有断言)。

暗色不设独立旋钮:在**同一个**滑块上加固定增量,于是用户拖一次两边一起动、
亮暗相对关系恒定。

## 四条会出 bug 的纪律

1. **每层只有一个元素上色**,上级容器一律置透明 —— 否则染色相乘,玻璃变糊。
2. **外壳层(0/1/2)绝不加 `backdrop-filter`**。既没用(背后是透明的 shell,backdrop 里没有可糊的像素),
   又会坏事:它让该元素成为其 `position: fixed` 后代的包含块,而编辑器里一堆浮层是 fixed +
   `getBoundingClientRect` 算出的视口坐标且**就地渲染不 portal**(`.amx-cal-cardwrap`、`.amx-db-pop`、
   `.amx-hoverprev`、`.amx-trash-wrap`、ShareCard…),给 groupview 上 filter 会让它们整体偏移。
3. **拥有浮层后代的卡片/遮罩也不能直接加 `backdrop-filter`**。滤镜会把它变成 Backdrop Root，
   后代菜单 computed 仍显示 `blur(40px)`，实际却只能采到祖先的合成结果，视觉上就退化成半透明。
   输入卡、拥有二级面的模型/模式/添加菜单、命令面板遮罩都把材质画在无子节点的 `::before`；
   叶子浮层才直接使用滤镜。若新浮层会再打开子浮层，必须沿用这个拓扑。
4. **`--bg-glass` 必须写在 `(0,3,0)`**(`:root[data-theme][data-skin]`):`skins.css` 在
   `:root.dark[data-skin]` 里逐配色定义过它,不提特异性的话本主题对 `.modal/.toast/.jump-bottom`
   完全不生效,更糟的是 `data-glass='off'` 时它们停在配色给的 0.9 alpha 上 —— 毛玻璃关了却还是半透明。

## 已知边界

- **侧栏糊不出来(不是 bug,是物理)**:CSS 的 `backdrop-filter` 只能糊页面自己画出来的像素。
  侧栏一路半透/全透 → backdrop 里没有不透明像素 → `computed` 里 blur 一直在,就是不起作用,
  现象是「输入卡后面的正文原样清晰地透过来」。故侧栏组内的输入卡和可定位的 composer 菜单
  **回到 `--gl-side` 靠浓度**；主区 / 主页菜单使用 58% 菜单档，主区输入卡能糊是因为身后有实色纸卡。
- **body portal 出去的浮层管不着**:右键菜单等按**屏幕位置**取 backdrop,DOM 上不在侧栏组里,
  上面那条选择器覆盖不到 —— 它们开在侧栏上方时同样糊不出东西,只能靠自身浓度。
- **非 macOS 没有原生 vibrancy**:loader 会把当前 skin 解析后的 `--bg` 作为 `#rrggbb`
  同步给主进程窗口底，同时 `:root[data-theme][:not([data-platform='mac'])]` 把页面舞台钉回
  `var(--bg)`；因此呈现为「柔和分层的实色主题」，不会再从半透外壳下漏出 cream 底色。
- **`data-glass='off'`**:`base.css` 只清 `backdrop-filter`,**不管染色** —— 本文件末尾那块必须把
  所有材质一并回落实色,漏一个(如 `--gl-thin`)就会出现「毛玻璃关了、正文却透过输入卡」。

## 排查须知

**复现本主题的问题必须切窗口材质。** 手工改 `data-theme` 不会走 loader 的 `syncWindowMaterial`,
窗口还是实色底 → 侧栏照样糊得出来,看不到问题。真机现场要补:

```js
window.tangu.setWindowMaterial({ material: 'system-glass', mode: 'dark' })
```

仪器:

- `npm run check:homepageglass` 用高对比壁纸做启用/禁用滤镜的像素差，覆盖输入卡、模型一级/二级菜单、
  命令面板与 Space 收纳层；只看 computed style 不算通过。
- `npm run check:chatside` 的 24/25 两条覆盖输入卡主区薄档 / 侧栏加厚，并巡检所有已登记的一级、
  二级菜单和大型浮层是否仍处于 menu / float / fallback 的正确分档。
