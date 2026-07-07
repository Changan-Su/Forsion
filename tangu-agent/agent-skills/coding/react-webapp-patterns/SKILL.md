---
name: React 组件与状态模式
description: 当在 Forsion Coding Space 里编写 React/前端组件、hooks、状态管理,或排查重渲染、数据获取、内存泄漏、陈旧闭包类 bug 时使用。提供 hooks 依赖数组、useEffect 竞态与清理、组件组合、状态选型(useState/Context/zustand)、数据获取三态(loading/error/取消)、列表 key、受控/非受控、memo/useMemo/useCallback 的可复制正反例(均适配 importmap+esm.sh 无构建环境)。
version: 1.0.0
category: 前端
---

# React 组件与状态模式

环境=本地 dev-server 即时转译 JSX/TSX,**无构建、无 npm install、无打包**。裸依赖走项目根 `index.html` 的 importmap →
`https://esm.sh/<包>@<版本>`,importmap **必须含 `react/jsx-runtime`**(自动 JSX 运行时),CSS 用 `<link>` 不在 JS 里 import。
要新增包=加 importmap 条目,不装依赖。下方片段均在此环境直接可跑。本技能只讲**怎么写对**。

## Hooks 铁律(最高频 bug 源)

- **只在组件/自定义 hook 顶层调用 hook**:不能进 `if`/循环/回调/`return` 之后。分支逻辑写进 hook 内部,不要用条件跳过 hook。
- **依赖数组要诚实**:effect/`useMemo`/`useCallback` 读到的每个响应式值(props、state、其派生量)都必须进依赖数组。别用空数组或删依赖"消警告"——那是在造陈旧闭包。
- **陈旧闭包**:effect/定时器/订阅回调会冻结创建它那一帧的变量。要读"最新值"就用**函数式更新**或 **ref**,不要把变量塞进闭包又不进依赖。
- **每个订阅/监听/定时器都要在 cleanup 里拆**:`return () => {...}`,否则重渲染叠加、卸载后 setState 报警告、内存泄漏。

```tsx
// 反例:闭包捕获首帧 count,永远只 +1 到 1
useEffect(() => {
  const id = setInterval(() => setCount(count + 1), 1000);
  return () => clearInterval(id);
}, []); // ← 读了 count 却不进依赖
// 正确:函数式更新,不依赖外部变量,空数组才成立
useEffect(() => {
  const id = setInterval(() => setCount(c => c + 1), 1000);
  return () => clearInterval(id);
}, []);
```

## useEffect 竞态与数据获取(loading / error / 取消)

慢请求先发后到会覆盖新数据。用 `AbortController` + `active` 闩锁只认最后一次;用判别联合表达三态,别堆一堆布尔:

```tsx
type State<T> = { s: 'idle' | 'loading' } | { s: 'ok'; data: T } | { s: 'error'; err: string };

function useUser(id: string) {
  const [st, set] = useState<State<User>>({ s: 'idle' });
  useEffect(() => {
    let active = true;
    const ctrl = new AbortController();
    set({ s: 'loading' });
    fetch(`/api/user/${id}`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(data => { if (active) set({ s: 'ok', data }); })
      .catch(e => { if (active && e.name !== 'AbortError') set({ s: 'error', err: String(e) }); });
    return () => { active = false; ctrl.abort(); }; // id 变化/卸载都取消旧请求
  }, [id]);
  return st;
}
```

- 渲染端**三态都要画**:`loading` 骨架、`error` 兜底+重试、`ok` 内容。别只处理成功路径。
- 要缓存/重试/去重时,importmap 加 `"@tanstack/react-query": "https://esm.sh/@tanstack/react-query@5?deps=react@18"`,别自己造。

## 组件组合优于继承

React 里**不用类继承共享 UI**,而是用 `children` / 具名插槽 props 拼装,用自定义 hook 抽逻辑。

```tsx
function Panel({ title, actions, children }:
  { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <section className="panel"><header>{title}{actions}</header>{children}</section>;
}
// <Panel title="用户" actions={<Btn/>}><UserTable/></Panel>
```

- 共享**行为**抽成自定义 hook(`useDisclosure`、`useUser`),共享**外观**抽成组件。别做"万能 props 巨型组件"。

## 状态管理选型(先本地,按需上升)

| 场景 | 用什么 |
|---|---|
| 只在一个组件/其子树用 | `useState` / `useReducer`(多字段联动用 reducer) |
| 少数几层传递 | 直接传 props,别急着上全局 |
| 低频全局:主题、语言、登录用户、feature flag | `Context`(value 用 `useMemo` 包稳定) |
| 高频全局:购物车、编辑器文档、协作光标 | `zustand`(切片订阅,避免全树重渲染) |

- **Context value 变化会让所有消费者重渲染**——高频更新别用 Context,否则要到处补 memo,那是选型错了的信号。
- zustand importmap 加 `"zustand": "https://esm.sh/zustand@5?deps=react@18"`,用**选择器只订阅需要的切片**:

```tsx
import { create } from 'zustand';
export const useCart = create<CartState>((set) => ({
  items: [], add: (it) => set(s => ({ items: [...s.items, it] })),
}));
const count = useCart(s => s.items.length); // 只有 length 变才重渲染;别 const {items}=useCart() 整取
```

## 列表 key

- key 必须**稳定且唯一**——用数据 id,**别用数组下标**(增删/排序会错位复用 DOM,导致输入框内容串行、动画错乱)。
- 没有天然 id 就在数据源头生成一次(`crypto.randomUUID()`),别在 render 里现造(每帧变=等于没 key)。

## 受控 vs 非受控

- **受控**:`value` + `onChange` 由 state 驱动——需要校验/联动/受 state 支配时用。切忌只给 `value` 不给 `onChange`(输入框锁死)。
- **非受控**:`defaultValue` + `ref` 读取——简单表单、不需每键重渲染时更省。
- **不要混用**:同一字段要么受控要么非受控;受控输入的 `value` 不可为 `undefined`(用 `?? ''` 兜底)。

## 性能:memo 家族(先别加,证明需要再加)

**默认不加**。多数 memo 化省不了多少,还增加复杂度和 bug 面。只在"确实避免了昂贵计算或大子树重渲染"时加,先用 React DevTools Profiler 测量,别凭感觉。

- `useMemo`:缓存**昂贵计算**(大数组排序/过滤),或给下游 memo 组件提供**稳定引用**的对象/数组。
- `useCallback`:仅当回调**传给了 `React.memo` 子组件**或**进了别处依赖数组**时才有意义;本组件用一次的函数包了纯属浪费。
- `React.memo`:包**渲染重**的子组件,前提是它的 props 引用稳定——否则每次新引用照样重渲染(常见白忙)。

```tsx
// 反例:onClick 每帧新建,React.memo(Child) 形同虚设
function List({ items }) {
  return items.map(it => <Child key={it.id} onClick={() => pick(it.id)} />);
}
// 正确:memo 组件 + 稳定回调才生效
const Child = React.memo(function Child({ id, onPick }) { /* 重渲染成本高 */ });
function List({ items, onPick }) {           // onPick 由上层 useCallback 稳定
  return items.map(it => <Child key={it.id} id={it.id} onPick={onPick} />);
}
```

- 依赖里放**每帧都变**的值(内联对象/新数组)会让 memo 永不命中——先让依赖稳定,再谈 memo。
- 更省事的做法:把频繁变动的 state **下沉**到只需要它的小组件,让父树不重渲染,常比撒 memo 更有效。

## 速查清单

- [ ] hooks 只在顶层调,依赖数组诚实(不删依赖消警告)
- [ ] 定时器/订阅/监听都有 cleanup;fetch 有 `AbortController` + `active` 闩锁
- [ ] 数据获取 loading/error/ok 三态都渲染
- [ ] 全局 state:低频→Context,高频→zustand 切片订阅;能本地就本地
- [ ] 列表 key 用稳定 id,不用下标
- [ ] 受控输入 `value` 配 `onChange` 且非 `undefined`
- [ ] memo 家族默认不加;加之前确认引用稳定且真省成本
- [ ] 新增包=加 importmap 条目(esm.sh),不写 npm install
