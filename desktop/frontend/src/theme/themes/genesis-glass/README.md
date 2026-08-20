# Genesis Glass · 琉璃

设计语言 = Genesis 结构 × macOS 原生玻璃。**本主题一个颜色键都不声明** —— 所有材质都是配色 token 的
`color-mix` 半透版,故任意配色(cream/coral/teal/lavender/custom)× 亮暗全部自动成立,
也就不存在「暗色块漏键拿到亮色值」的对称问题。

跨主题的通用纪律见仓根 `DESIGN.md`;这里只写**本主题特有的东西和踩过的坑**。

## 材质分档

| 档 | 变量 | 谁用 | 备注 |
|---|---|---|---|
| 0 stage | `--gl-stage` | `html`/`body`/`.shell`/`.wb-dockview` | 一路透到窗口,让原生 vibrancy 成为唯一底 |
| 1 chrome | `--gl-chrome` | ribbon、主区外框 | 只染色 |
| 2 pane | `--gl-pane` | 侧栏组(文字密度高,比 chrome 厚一档) | 只染色 |
| 3 paper | `--gl-paper` | 主视图纸卡 | **全实色**,可读性锚点 |
| 3.5 thin | `--gl-thin`(50%) | 输入卡 | 身后有正文在动,保留明显的景深透色 |
| 4 float | `--gl-float`(84%) | 一级/二级菜单、弹窗、命令面板、toast | 浮层跨侧栏与 portal 时仍须有可读的磨砂染色兜底 |

浓度旋钮(chrome/pane/float/模糊半径/饱和度)已接进**设置 → 主题 → 选中卡下方的滑块**
(`theme.json` 的 `settings[]`,宿主把值写成 `:root` 内联变量)。
`--gl-thin` **不接旋钮**,写字面值;菜单统一消费 `--gl-float`,因此「浮层浓度」会同时控制菜单与大型浮层。
带 `--gl-*-pct` 的写法专留给 `theme.json` 声明过的档位,
且那些兜底值必须与 `theme.json` 的 `default` **逐字一致**(`themeSettings.test.ts` 有断言)。

暗色不设独立旋钮:在**同一个**滑块上加固定增量(+10/+8/+2),于是用户拖一次两边一起动、
亮暗相对关系恒定。

## 三条会出 bug 的纪律

1. **每层只有一个元素上色**,上级容器一律置透明 —— 否则染色相乘,玻璃变糊。
2. **外壳层(0/1/2)绝不加 `backdrop-filter`**。既没用(背后是透明的 shell,backdrop 里没有可糊的像素),
   又会坏事:它让该元素成为其 `position: fixed` 后代的包含块,而编辑器里一堆浮层是 fixed +
   `getBoundingClientRect` 算出的视口坐标且**就地渲染不 portal**(`.amx-cal-cardwrap`、`.amx-db-pop`、
   `.amx-hoverprev`、`.amx-trash-wrap`、ShareCard…),给 groupview 上 filter 会让它们整体偏移。
3. **`--bg-glass` 必须写在 `(0,3,0)`**(`:root[data-theme][data-skin]`):`skins.css` 在
   `:root.dark[data-skin]` 里逐配色定义过它,不提特异性的话本主题对 `.modal/.toast/.jump-bottom`
   完全不生效,更糟的是 `data-glass='off'` 时它们停在配色给的 0.9 alpha 上 —— 毛玻璃关了却还是半透明。

## 已知边界

- **侧栏糊不出来(不是 bug,是物理)**:CSS 的 `backdrop-filter` 只能糊页面自己画出来的像素。
  侧栏一路半透/全透 → backdrop 里没有不透明像素 → `computed` 里 blur 一直在,就是不起作用,
  现象是「输入卡后面的正文原样清晰地透过来」。故侧栏组内的输入卡**回到 float 那档靠浓度**;
  菜单无论主区/侧栏都默认使用 float。主区输入卡能糊是因为身后有实色纸卡。
- **body portal 出去的浮层管不着**:右键菜单等按**屏幕位置**取 backdrop,DOM 上不在侧栏组里,
  上面那条选择器覆盖不到 —— 它们开在侧栏上方时同样糊不出东西,只能靠自身浓度。
- **非 macOS 没有原生 vibrancy**:主进程铺的是**写死的**实色底(`#fbf8f5`/`#252327`,不跟配色),
  故 `:root[data-theme][:not([data-platform='mac'])]` 把舞台钉回 `var(--bg)`,
  呈现为「柔和分层的实色主题」而不是掉色。要治本得让宿主的降级底色跟随当前配色。
- **`data-glass='off'`**:`base.css` 只清 `backdrop-filter`,**不管染色** —— 本文件末尾那块必须把
  所有材质一并回落实色,漏一个(如 `--gl-thin`)就会出现「毛玻璃关了、正文却透过输入卡」。

## 排查须知

**复现本主题的问题必须切窗口材质。** 手工改 `data-theme` 不会走 loader 的 `syncWindowMaterial`,
窗口还是实色底 → 侧栏照样糊得出来,看不到问题。真机现场要补:

```js
window.tangu.setWindowMaterial({ material: 'system-glass', mode: 'dark' })
```

仪器:`npm run check:chatside` 的 24/25 两条(输入卡主区薄档 / 侧栏加厚、一级/二级菜单是不是 float 磨砂)。
