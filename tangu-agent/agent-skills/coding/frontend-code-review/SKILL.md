---
name: 前端代码审查
description: 当被要求 review/审查/检查前端或 React 代码、找 UI 隐患、把关组件质量时使用，提供浏览器端专项审查清单：安全（XSS、dangerouslySetInnerHTML、不可信 href/URL、target=_blank、innerHTML 注入、eval）、无障碍（语义标签、alt、label、键盘可达、focus 管理）、性能（重渲染、key、N+1 请求、图片、大依赖）、React 正确性（hooks 依赖、副作用清理、内存泄漏、Rules of Hooks、受控输入）与可维护性，并校验 Forsion 无构建/importmap 环境铁律，按 Critical/Suggestion/Nit 分级输出，每条附最小修复。
version: 1.0.0
category: 前端 / 代码质量
---

# 前端代码审查

浏览器 / React 专项 review。**只盯浏览器运行时与 React 语义**——DOM/XSS、a11y、渲染性能、hooks 生命周期、Forsion 环境铁律；通用逻辑/命名/架构交给通用 code-review，不重复。

## 严重度分级与输出

- **Critical** — 安全漏洞、崩溃、内存泄漏、数据丢失、a11y 完全阻断、违反环境铁律。**必须改。**
- **Suggestion** — 性能退化、可维护性、偏离最佳实践。应改。
- **Nit** — 命名、风格、微优化。可选。

每条一行：`[严重度] 文件:行 — 问题 — 最小修复`。Critical 在前；无问题就写“未发现问题”，不凑数。

## 1. 安全（多为 Critical）

- [ ] **`dangerouslySetInnerHTML` 灌未消毒富文本** —— 最常见 XSS。含用户/远端数据先消毒或改纯文本。
  ```jsx
  <div dangerouslySetInnerHTML={{ __html: comment }} />   // ❌ XSS
  <div>{comment}</div>                                    // ✅ React 默认转义
  ```
- [ ] **`href`/`src` 收不可信 URL** —— `javascript:`、`data:` 可执行脚本，白名单协议：
  ```jsx
  const safe = /^https?:\/\//.test(url) ? url : '#';      // ✅ 拒绝 javascript:
  ```
- [ ] **`target="_blank"` 缺 `rel="noopener noreferrer"`** —— 反标签劫持 + 隐私。
- [ ] **绕过 React 直改 DOM**：`el.innerHTML =`、`document.write`、`insertAdjacentHTML` 拼输入 → 用 `textContent` 或受控渲染。
- [ ] **`eval` / `new Function` / 内联事件字符串** —— 一律标记，几无正当用途。
- [ ] **密钥/token 硬编码进前端**（浏览器可见）；用户输入拼进 `importmap` 或动态 `import()` 路径 —— 禁区。

## 2. 无障碍 a11y（阻断类 Critical，其余 Suggestion）

- [ ] **`<div onClick>` 当按钮** —— 键盘不可达。改 `<button>`；必须用 div 则补 `role="button"` + `tabIndex={0}` + `onKeyDown`（Enter/Space）。
- [ ] **`<img>` 缺 `alt`**（装饰图 `alt=""`）；图标按钮缺 `aria-label`。
- [ ] **表单控件无 `<label htmlFor>`** 或 `aria-label`。
- [ ] **语义标签缺失**：`<nav>`/`<main>`、标题 `<h1..h6>` 不跳级，别用 div 汤。
- [ ] **focus 管理**：弹窗开时聚焦、关时归还、`Esc` 可关；不要 `outline:none` 且无替代焦点环。
- [ ] 颜色对比 ≥ 4.5:1；信息不能只靠颜色传达。

## 3. 性能（Suggestion，热路径可升 Critical）

- [ ] **内联对象/函数 props 触发子组件重渲染** —— 稳定引用用 `useMemo`/`useCallback`，纯组件包 `React.memo`。
  ```jsx
  <List style={{ m: 8 }} onPick={x => go(x)} />   // ❌ 每次 render 新引用
  ```
- [ ] **列表 `key={index}`** —— 顺序变动导致状态错位/多余重渲，用稳定业务 id。
- [ ] **N+1 / 瀑布请求**：`useEffect` 里循环 fetch，或 A 完成才发 B。能并行走 `Promise.all`，能一次取别拆。
- [ ] **图片**：给 `width/height` 防抖动，首屏外 `loading="lazy"`，别加载超大原图。
- [ ] **importmap 拉整库**：只用一个函数却引整个大包 → 换更小的 esm.sh 子路径/按需入口。
- [ ] 重计算未 `useMemo`；长列表（>数百项）无虚拟化。

## 4. React 正确性（多为 Critical）

- [ ] **hooks 依赖数组错误** —— 漏依赖读到 stale 值；乱加致无限循环。依赖须与内部读到的每个响应式值一致。
- [ ] **副作用未清理 → 内存泄漏**（最易漏）：
  ```jsx
  useEffect(() => {
    const t = setInterval(tick, 1000);
    const ac = new AbortController();
    window.addEventListener('resize', onResize);
    fetch(url, { signal: ac.signal });
    return () => { clearInterval(t); ac.abort();
      window.removeEventListener('resize', onResize); };   // ✅ 定时器/监听/请求全清
  }, []);
  ```
- [ ] **hooks 在条件/循环里调用** —— 违反 Rules of Hooks，须顶层无条件调用。
- [ ] **用 `useEffect + setState` 派生数据** —— render 里能直接算的别塞 effect（多余渲染 + 闪烁）。
- [ ] **卸载后 setState**：异步回调返回时组件已卸载 → 用 AbortController 或 mounted 标志守卫。
- [ ] key 用错层级；受控/非受控输入混用（有 `value` 无 `onChange`）。

## 5. 可维护性（Suggestion / Nit）

- [ ] 重复取数/事件逻辑抽 custom hook，重复 UI 抽组件。
- [ ] 组件过大 / 一函数多职责 → 拆。
- [ ] 魔法数字/字符串抽常量；TS 中 `any`、`@ts-ignore` 质疑。
- [ ] 死代码、`console.log`、注释掉的旧实现清理。

## Forsion 环境铁律（违反=Critical）

预览是 dev-server 按需转译 .ts/.tsx（sucrase），**无构建、无打包、无 `npm install`**。审到即报：

- [ ] 出现 `npm install` / `vite build` / `webpack` / 装 `package.json` 依赖 —— **一律 Critical，禁止**。
- [ ] 裸依赖没进根 `index.html` 的 **importmap**（走 `https://esm.sh/<包>@<版本>`）；用自动 JSX 运行时却漏 `react/jsx-runtime` → 白屏。
  ```html
  <script type="importmap">{ "imports": {
    "react": "https://esm.sh/react@18",
    "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime",
    "react-dom/client": "https://esm.sh/react-dom@18/client"
  }}</script>
  ```
- [ ] JS 里 `import './x.css'` —— 改 `index.html` 的 `<link rel="stylesheet">`。
- [ ] 多文件用相对路径 import。

## 审查流程

1. 定位改动/目标文件（优先 diff）。
2. 按 §1→§5 + 环境铁律逐维度过清单。
3. 归并去重，按 Critical→Suggestion→Nit 排序。
4. 每条给可直接落盘的最小修复，不空谈原则。
