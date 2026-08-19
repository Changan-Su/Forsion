// 宿主写盘的全局串行锁。**可重入**。
//
// 为什么单开一个叶子模块(零 import):
//   - `services/checkpoints.ts` 的恢复要和写类工具**同一把锁**(不然回退能和别人在飞的 run 交叠)。
//     它去 import `tools/hostExec.ts` 只为拿一把锁,会把整张工具表拽进 service 层。
//   - 锁本身没有任何依赖,放叶子模块两边都单向依赖它,不成环。
//
// 为什么必须可重入(codex 2026-08-17 评审 P1):快照要和写在**同一个临界区**里 ——
// `registry.executeTool` 在锁里做「拍 pre-image → 执行工具 → 取写后指纹」,而工具自己
// (`hostExec` 的 write_file/edit_file、`applyPatch`)内部本来就各自 `withWriteLock`。
// 不可重入的话内层等外层放锁、外层等内层跑完 = **死锁**。
//
// 拿 AsyncLocalStorage 判「我是不是已经在锁里」:它跨 await 传递,而写路径全是 async。

import { AsyncLocalStorage } from 'node:async_hooks';

const held = new AsyncLocalStorage<true>();

// 单链串行:并行子代理各自串行执行工具,但两个子代理可同时进写类工具;
// edit/multi_edit/apply_patch 是「读-改-写」,交叠会静默丢更新。写操作毫秒级,单链无争用痛点。
// ponytail: 全局一条链,真出现写吞吐瓶颈再按路径分锁。
let writeChain: Promise<unknown> = Promise.resolve();

/** 在全局写锁里跑 fn。已经在锁里(同一条异步链上层调过)则直接执行,不再排队。 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (held.getStore()) return fn(); // 重入:已持锁,直接跑
  const r = writeChain.then(
    () => held.run(true, fn),
    () => held.run(true, fn),
  );
  writeChain = r.then(() => undefined, () => undefined);
  return r;
}

/** 当前异步上下文是否已持有写锁(只为断言/单测;业务代码别拿它做分支)。 */
export function holdingWriteLock(): boolean {
  return held.getStore() === true;
}
