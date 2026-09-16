/** 进程内按 key 串行(check-then-act 的最小互斥):同 key 的调用排队,不同 key 并行。跨进程/多实例不覆盖(那是数据库约束的事)。 */
const chains = new Map<string, Promise<unknown>>();
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  chains.set(key, settled);
  void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return run;
}
