---
name: 网页应用调试
description: 当网页应用出现 bug、白屏、报错、行为不符预期时使用；提供系统化调试流程(复现→隔离→假设→验证)、浏览器 DevTools(Console/Network/Elements/断点/source map)用法、React 常见 bug(无限重渲染、陈旧状态、重复请求、key 警告、事件未绑定)排查、二分定位、读报错栈,以及 Forsion 预览白屏/importmap 缺依赖的症状→动作对照。触发词:调试、debug、白屏、报错栈、无限重渲染、Network 4xx、CORS、importmap、断点、source map、页面不刷新、点击没反应。
version: 1.0.0
category: 前端
---

# 网页应用调试

**先诊断,再改代码。** 未复现的 bug 不要动手;每次只验证一个假设,一次只改一处。

## 系统化流程(按序,别跳步)

1. **复现** — 找到 100% 触发的最小步骤,记录 URL、操作序列、输入、预期 vs 实际。不能稳定复现就先补日志缩小随机性。
2. **隔离** — 把问题空间对半砍(见「二分定位」),定位到具体文件/组件/请求/状态,而非"整页坏了"。
3. **假设** — 写一句可证伪的断言,如"`user` 首帧为 `undefined`,取 `.name` 崩溃"。
4. **验证** — 用 DevTools/`console.log`/断点判真假。真→查根因再修;假→回第 3 步换假设。
5. **回归** — 复现原步骤确认已修,并回归相邻功能,防按下葫芦浮起瓢。

## 症状 → 动作(速查)

| 症状 | 先看哪 | 常见根因 |
|---|---|---|
| 整页白屏 | Console 第一条红报错 | JS 抛错中断挂载 / importmap 缺依赖 / 入口路径错 |
| `Failed to resolve module specifier` | Console + importmap | 裸依赖没进 importmap,补 esm.sh 条目 |
| `does not provide an export 'jsx'` | importmap | 缺 `react/jsx-runtime` 条目 |
| 点击没反应 | Elements 事件 + 代码 | `onClick` 写成 `onclick` / `onClick={fn()}` 立即执行 |
| 数据不显示/转圈不停 | Network 该请求状态码 | 4xx/5xx、CORS、响应结构变了、URL 拼错 |
| 请求发两次 | Network 时间线 | StrictMode 双调用 + effect 无清理 / 依赖抖动 |
| 页面疯狂刷新卡死 | Console `Too many re-renders` | 渲染期 setState / effect 依赖不稳定引用 |
| 改了状态 UI 不动 | React DevTools props/state | 直接 mutate 数组对象 / 陈旧闭包 |
| `key` 警告 | 报错指向的 `.map()` | 列表项缺 `key` 或用 index 当 key |
| 样式不生效 | Elements → Computed | 选择器特异性 / 被覆盖 / `<link>` 没加载 |

## 浏览器 DevTools

- **Console**:先看**最上面第一条**报错(后续多是连锁)。`$0` = Elements 选中节点;`console.table(arr)` 看数组;`console.log('[flag]', {a,b})` 加标签便于搜。
- **Network**:勾 **Disable cache**,按 Fetch/XHR 过滤。看 **Status**、**Headers**(URL/CORS)、**Payload**、**Response**。请求根本没出现 = 代码没发出去。
- **Elements**:**Computed** 定位样式被谁覆盖;**Event Listeners** 确认监听真的绑上;右键 → Break on 设 DOM 变更断点。
- **Sources / 断点**:代码插 `debugger;` 或点行号下断;**条件断点**(右键行号)只在 `id===42` 时停。断住后看 Scope、Call Stack、Watch。
- **Source map**:dev-server 用 sucrase 转译 `.ts/.tsx`,Sources 里应见**原始 TSX**、断点直接打源码行;若只见转译码,说明 source map 没生效,按报错 `file:line` 回源码定位。

## 读报错栈

- **从上往下读**,找**第一个属于你项目文件**的帧(`./components/Foo.tsx:23`),那通常是出事点;上面 react-dom 内部帧可略过。
- `Cannot read properties of undefined (reading 'x')` → 某对象是 `undefined` 却取 `.x`;回溯它从哪来(props?fetch 未回?)。
- `X is not a function` → 导入名/解构写错,或该值还没赋。
- 行号对不上真实代码 → 确认看的是 source-map 后的源码位置。

## 二分定位(最快的隔离手段)

- **代码二分**:注释后半段 / 提前 `return`,看 bug 是否消失,逐步夹逼到几行。
- **数据二分**:半量输入试,定位是否某条脏数据触发。
- **日志二分**:可疑路径中点插 `console.log('reached A')`,看执行走到哪断掉。
- **版本二分**:对照上一个能跑的提交(`git log` / `git bisect` 思路)diff 出引入问题的改动。

## React 常见 bug

```tsx
// 无限重渲染:渲染期直接 setState
function Bad() {
  const [n, setN] = useState(0);
  setN(n + 1);                                // ❌ 每次渲染都触发 → Too many re-renders
  return <button onClick={() => setN(n + 1)}>{n}</button>; // ✅ 放进事件/effect
}
// effect 依赖不稳定引用 → 无限循环
useEffect(() => { load(opts); }, [{ id }]);   // ❌ 每渲染都是新对象,恒不相等
useEffect(() => { load(id); }, [id]);         // ✅ 依赖原始值;对象/函数用 useMemo/useCallback 稳定
```

```tsx
// 重复请求:StrictMode 双调用 + 竞态。加清理与取消
useEffect(() => {
  const ac = new AbortController();
  fetch(`/api/user/${id}`, { signal: ac.signal })
    .then(r => r.json()).then(setUser)
    .catch(e => { if (e.name !== 'AbortError') throw e; });
  return () => ac.abort();                     // ✅ 卸载/依赖变时中止,避免重复与旧响应覆盖新
}, [id]);
```

```tsx
// 陈旧状态:闭包捕获旧值 → 用函数式更新
setInterval(() => setCount(count + 1), 1000);  // ❌ count 永远是初值
setInterval(() => setCount(c => c + 1), 1000); // ✅
setItems(prev => [...prev, x]);                // ✅ 不可变更新,别 items.push(x)

// key:稳定唯一,别用 index(增删会错位复用)
{items.map(it => <Row key={it.id} data={it} />)}

// 事件绑定:传引用、用驼峰
<button onClick={handleClick}>OK</button>      // ✅
<button onClick={handleClick()}>OK</button>    // ❌ 渲染时就执行
<button onclick={handleClick}>OK</button>      // ❌ React 是 onClick
```

- **React DevTools → Components**:选组件看实时 props/state、确认在对应 Provider 内、用 Profiler 看谁在重渲染。

## 白屏 / importmap 缺依赖(Forsion 预览专属)

预览是本地 dev-server(sucrase 按需转译,**无构建、无 npm install、无打包**)。入口恒为项目根 `index.html`,裸依赖必须在 `<script type="importmap">` 映射到 `https://esm.sh/<包>@<版本>`。
**排查顺序**:Console 第一条报错 → 是否 `Failed to resolve module specifier "xxx"` → 检查 importmap 有无该裸包条目。

```html
<!-- index.html —— React 自动 JSX 运行时必须含 react/jsx-runtime -->
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime"
  }
}
</script>
<link rel="stylesheet" href="./styles.css" />   <!-- CSS 用 <link>,别在 JS 里 import -->
<div id="root"></div>
<script type="module" src="./main.tsx"></script>
```

**白屏自查清单**:
- Console 有红报错吗?**先修第一条**,后面多是连锁。
- 缺 `react/jsx-runtime` → `does not provide an export named 'jsx'`,补该条目。
- 用了新库(`date-fns`、`zustand` 等)没加 importmap → `Failed to resolve module specifier`,加一条带版本号的 esm.sh 映射,**绝不写 `npm install`**。
- 相对 import 路径/后缀错(`./Foo` vs `./Foo.tsx`)、大小写不符 → 404,Network 里有红请求。
- `#root` 挂载点 id 与 `getElementById` 不一致 → 静默白屏,无报错。
- 顶层 `throw` / 首帧访问未就绪数据 → 组件崩溃卸载整树;用 ErrorBoundary 或可选链 `data?.x` 兜底。
