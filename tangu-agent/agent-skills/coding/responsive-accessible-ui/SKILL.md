---
name: 响应式布局与无障碍
description: 当在 Coding Space 构建或修改任何网页 UI(页面、布局、组件、表单、弹窗/对话框、导航、图标按钮)时使用,提供移动优先响应式布局、flexbox/grid 套路、clamp 流式尺寸、语义化 HTML、ARIA 取舍、键盘可达与焦点管理(focus trap)、WCAG 对比度、prefers-reduced-motion/prefers-color-scheme、表单可访问性、触摸目标 44×44 等 a11y 能力,附可直接复制的 CSS/JSX 片段与交付前自检清单。
version: 1.0.0
category: 无障碍
---

# 响应式布局与无障碍(a11y)

默认移动优先、语义先行、ARIA 兜底。下面每条都可落地。

## 0. Forsion 环境铁律(代码必须遵守)

- 无构建、无 npm install、无打包;dev-server 用 sucrase 按需转译 `.tsx/.jsx`。
- 入口是根 `index.html`,裸依赖走 `https://esm.sh`,importmap **必须含 `react/jsx-runtime`**。
- 要用新包 → 加 importmap 条目;**绝不**写安装/构建指令。CSS 用 `<link>`,**不要**在 JS 里 `import "*.css"`;多文件用相对路径 import。
- `<head>` **必须**有 `<meta name="viewport" content="width=device-width, initial-scale=1">`,否则移动端无响应式。

```html
<!-- index.html -->
<meta name="viewport" content="width=device-width, initial-scale=1">
<script type="importmap">{ "imports": {
  "react": "https://esm.sh/react@18.3.1",
  "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
  "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime"
}}</script>
<link rel="stylesheet" href="./styles.css">
<div id="root"></div>
<script type="module" src="./main.tsx"></script>
```

## 1. 移动优先 + 断点

- 基础样式写窄屏单列;用 `min-width` 媒体查询**向上**增强,不用 `max-width` 往下砍。
- 断点跟内容走不追设备,常用 `40rem / 64rem / 90rem`;用 `rem` 尊重用户字号。
- 优先「无查询」自适应(见 §2),媒体查询只留给真正换布局处。

## 2. Flexbox / Grid 常用套路

```css
/* 自适应网格:不写媒体查询,列数随宽度自动增减 */
.auto-grid { display: grid; gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(min(16rem, 100%), 1fr)); }
/* 内容居中限宽,两侧留白 */
.page { display: grid; grid-template-columns: 1fr min(70ch, 100%) 1fr; }
.page > * { grid-column: 2; }
/* 弹性行:超窄自动换行,别硬撑溢出 */
.toolbar { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.toolbar .spacer { margin-inline-start: auto; }   /* 把右侧推到底 */
```

- `min(16rem, 100%)` 防止单列时子项比视口宽而横向滚动。
- 逻辑属性优先(`margin-inline`/`padding-block`/`inset`),天然适配 RTL。
- 页面**永不横向滚动**;宽内容(表格/代码)套 `overflow-x: auto` 容器。

## 3. 流式尺寸:clamp

```css
:root {
  --step-0: clamp(1rem, 0.9rem + 0.5vw, 1.125rem);    /* 流式正文 */
  --step-2: clamp(1.5rem, 1.2rem + 1.5vw, 2.25rem);   /* 流式标题 */
  --gutter: clamp(1rem, 5vw, 2.5rem);                 /* 流式留白 */
}
h1 { font-size: var(--step-2); }
```

`clamp(最小, 首选, 最大)`:最小/最大用 `rem` 保证可缩放,首选含 `vw` 随视口流动——一行替代多数媒体查询。

## 4. 语义化 HTML(第一道 a11y 防线)

- 地标元素 `<header> <nav> <main> <aside> <footer>`;每页**恰好一个 `<main>` 和一个 `<h1>`**,标题层级不跳级。
- 触发动作 → `<button>`;跳转 URL → `<a href>`。**别拿 `<div onClick>` 当按钮**(丢键盘/焦点/角色)。
- 图片必有 `alt`(装饰图 `alt=""`);表格用 `<th scope>`;列表用 `<ul>/<ol>`。
- 一个语义元素 ≈ 免费的角色 + 键盘 + 焦点,胜过一堆 ARIA。

## 5. ARIA:何时用 / 何时别用

铁律:**No ARIA is better than bad ARIA。** 有原生元素就别加;用了就得补齐它承诺的行为(键盘、状态)。

- 别做:`<button role="button">`(冗余)、给可聚焦元素加 `aria-hidden="true"`、用 `<div role="button">` 却不接键盘。
- 该做:图标按钮加 `aria-label`;开关用 `aria-pressed`/`aria-expanded`;动态状态用 live region;`aria-describedby` 关联说明/错误。

```tsx
<button aria-label="搜索"><SearchIcon aria-hidden="true" /></button>
<button aria-expanded={open} aria-controls="menu">菜单</button>
<div role="status" aria-live="polite">{msg}</div>   {/* polite 不打断 */}
```

## 6. 键盘可达与焦点管理

- 所有交互项 `Tab` 可达且顺序合理;**焦点必须可见**——绝不 `outline: none` 了事,用 `:focus-visible`。
- 打开弹层:焦点移入并**陷住**(focus trap);`Esc` 关闭;关闭后**焦点归还**触发元素。
- 别用正数 `tabindex`;加跳过链接 `<a href="#main" class="skip-link">跳到主内容</a>`。

```css
:focus-visible { outline: 3px solid var(--focus, #2563eb); outline-offset: 2px; }
.skip-link { position: absolute; left: -999px; }
.skip-link:focus { left: 1rem; top: 1rem; }
```

```tsx
function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement;          // 记住触发元素
    const box = ref.current!;
    (box.querySelector<HTMLElement>('[autofocus],button,[href],input') ?? box).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab') return;
      const f = box.querySelectorAll<HTMLElement>(
        'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); }; // 归还焦点
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="dlg-t"
           onClick={(e) => e.stopPropagation()}>
        <h2 id="dlg-t">标题</h2>{children}
      </div>
    </div>
  );
}
```

## 7. 对比度与可读性

- WCAG AA:正文 ≥ **4.5:1**;大字(≥24px 或 ≥18.66px 粗体)与 UI 图形/边框/图标 ≥ **3:1**。
- **别只用颜色**传达信息(错误红字配图标/文字;链接靠下划线区分)。
- 正文 `line-height: 1.5`、行宽 `max-width: 66ch`;用近黑 `#1a1a1a` 而非纯黑降眩光。

## 8. prefers-reduced-motion / prefers-color-scheme

```css
@media (prefers-reduced-motion: reduce) {          /* 前庭敏感用户友好 */
  *, *::before, *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important;
  }
}
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; }  /* 控件/滚动条跟随 */
@media (prefers-color-scheme: dark) { :root { --bg: #0f0f0f; --fg: #ededed; } }
body { background: var(--bg); color: var(--fg); }
```

## 9. 表单可访问性

- 每个控件有 `<label htmlFor>`(占位符 ≠ 标签);相关一组用 `<fieldset><legend>`。
- 用对 `type`/`inputmode`/`autocomplete`(`email`、`inputmode="numeric"`、`autocomplete="one-time-code"`),移动端弹对键盘、自动填充。
- 校验:错误文本用 `aria-describedby` 关联、出错控件加 `aria-invalid`;**别 disable 提交按钮**,点了再报错并把焦点移到首个错误。

```tsx
<label htmlFor="email">邮箱</label>
<input id="email" type="email" autoComplete="email"
       aria-invalid={!!err} aria-describedby={err ? 'email-err' : undefined} />
{err && <p id="email-err" role="alert">{err}</p>}
```

## 10. 触摸目标尺寸

- 命中区 ≥ **44×44 CSS px**(WCAG 2.5.5),间距 ≥ 8px;图标视觉可小,用 padding 撑可点区。

```css
.icon-btn { min-width: 44px; min-height: 44px; display: inline-grid; place-items: center; }
@media (pointer: coarse) { .btn { min-height: 48px; } }
```

## 交付前自检清单

- [ ] `<meta viewport>` 存在;拉到 320px 无横向滚动、不破版。
- [ ] 一个 `<h1>`、地标齐全、标题不跳级;交互项是 `<button>/<a>` 而非 `<div>`。
- [ ] 纯键盘走完主流程:`Tab` 顺序合理、焦点可见、弹层可陷入/`Esc`/归还。
- [ ] 图标按钮有 `aria-label`;无多余/错误 ARIA;动态状态有 live region。
- [ ] 正文对比 ≥4.5:1、UI ≥3:1;信息不只靠颜色。
- [ ] `prefers-reduced-motion` 与 `prefers-color-scheme` 都已处理。
- [ ] 表单有 label、正确 `type/inputmode/autocomplete`、错误可达。
- [ ] 触摸目标 ≥44×44。
