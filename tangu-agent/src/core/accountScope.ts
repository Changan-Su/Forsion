/**
 * 多账号模式(multi-account mode)的账号上下文。
 *
 * 一台机器上多个账号共用一个 standalone 引擎进程:每个请求(以及它起的 run 的整棵异步子树)跑在
 * `runWithAccount(accountId, …)` 里;`tanguHome()` / `forsionSharedDir()` / 对话库 / 进程级缓存都按这里的
 * 「当前账号」分流。缺省(单人模式)这里的一切都是透明的:`isMultiAccount()` 为 false,其余函数原样返回。
 *
 * 规矩:
 * - 开关只认**真实环境变量** `TANGU_MULTI_ACCOUNT=1`,模块加载时读一次。`.env` 文件开关不了(它在开关读完之后才加载),
 *   CLI 也没有参数 —— 模块顶层就算路径的代码必须在 import 时就看到开关,多账号模式下当场抛错,而不是悄悄落进共用目录。
 * - 单独一个 AsyncLocalStorage,只用 `run()` 绑(不用 enterWith,也不进 seams/runContext.ts 的 RunCtx:那边会整体重建 store)。
 * - 本模块不 import 引擎里的任何东西(tanguHome.ts 依赖它,而几乎所有模块都依赖 tanguHome.ts)。
 *
 * 引擎级、不属于任何账号的路径(多账号模式下显式用 `engineRoot()`,清单保持短):
 *   - (引擎热更新覆盖层多账号模式下不用:boot/launch.ts 一律跑安装包自带的,见 boot/overlay.ts 的 overlaySkipReason)
 *   - `<engineRoot>/.env`(core/tanguHome.ts 的 envFile)
 *   - `<engineRoot>/session-owners.db`(adapters/standalone/multiAccountSqliteHost.ts):会话 id → 账号的登记,只存这两列、不含用户内容。
 *     会话 id 是全局命名空间:进程里以会话 id 为键的表(排队、「总允许」、读过的文件…)靠它保证一个 id 只属于一个账号。
 *   - `<engineRoot>/accounts/<id>/` 本身(每个账号的 home)
 * 插件包目录(TANGU_BUNDLE_DIRS、包内首方 plugins/)只读。其余一律账号级;归不清的先归账号级或关掉。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const MULTI = process.env.TANGU_MULTI_ACCOUNT === '1';

/** 多账号模式开关(进程级,模块加载时定死)。 */
export function isMultiAccount(): boolean {
  return MULTI;
}

/** 账号 id:小写字母 / 数字开头,其后小写字母、数字、_、-,共 1–64 个字符。**不做大小写归一**:带大写的直接拒
 *  (macOS 文件系统大小写不敏感,`Alice` / `alice` 会落进同一个文件夹)。 */
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidAccountId(id: unknown): id is string {
  return typeof id === 'string' && ACCOUNT_ID_RE.test(id);
}

interface AccountStore { id: string }
const als = new AsyncLocalStorage<AccountStore>();
// 模块加载时就启用 ALS(与 seams/runContext.ts 同理:Node < 24 懒装钩子,装上之前建的 promise 不受追踪)。
// run() 不会把 store 漏进兜底资源;传一个空 id 的 store 只为让钩子装上,currentAccountId 把空串当没有。
als.run({ id: '' }, () => {});

/** 在 `id` 这个账号的上下文里跑 fn(整个同步调用 + 它派生的全部异步续延)。id 不合格就抛。 */
export function runWithAccount<T>(id: string, fn: () => T): T {
  if (!isValidAccountId(id)) throw new Error(`multi-account: invalid account id ${JSON.stringify(String(id)).slice(0, 80)}`);
  return als.run({ id }, fn);
}

/** 当前账号;不在任何账号上下文里返回 undefined。 */
export function currentAccountId(): string | undefined {
  return als.getStore()?.id || undefined;
}

/**
 * 多账号模式下取当前账号,没有就抛 `multi-account: no account in context for <what>`(缺省拒绝:宁可报错,
 * 不落进共用目录 / 共用库)。单人模式返回 undefined、不抛 —— 调用方按单人路径走(只应在 isMultiAccount() 分支里用它的值)。
 */
export function requireAccountId(what: string): string {
  if (!MULTI) return undefined as unknown as string;
  const id = currentAccountId();
  if (!id) throw new Error(`multi-account: no account in context for ${what}`);
  return id;
}

/**
 * 把「当前账号」和回调绑在一起:存进进程级结构、稍后在别的异步上下文里执行的回调(队列、防抖、定时器、事件监听)用。
 * 单人模式原样返回 fn;多账号模式下绑定时不在账号上下文里也原样返回(执行时照样拿不到账号 → 碰账号数据就抛)。
 */
export function bindAccount<F extends (...a: any[]) => any>(fn: F): F {
  if (!MULTI) return fn;
  const id = currentAccountId();
  if (!id) return fn;
  return (function (this: unknown, ...a: any[]) {
    return runWithAccount(id, () => fn.apply(this, a));
  }) as F;
}

/**
 * 进程级缓存 / 单例按账号分:单人模式一个实例(第一次调用时建);多账号模式按 requireAccountId 取各自的实例。
 */
export function perAccount<T>(factory: () => T): () => T {
  let single: { v: T } | null = null;
  const byAccount = new Map<string, T>();
  return () => {
    if (!MULTI) {
      if (!single) single = { v: factory() };
      return single.v;
    }
    const id = requireAccountId('perAccount');
    if (!byAccount.has(id)) byAccount.set(id, factory());
    return byAccount.get(id) as T;
  };
}

/** 引擎根(不属于任何账号):`TANGU_HOME || ~/.tangu`。 */
export function engineRoot(): string {
  return process.env.TANGU_HOME || join(homedir(), '.tangu');
}

/** 账号的 home:`<engineRoot>/accounts/<id>`。id 不合格就抛。 */
export function accountHome(id: string): string {
  if (!isValidAccountId(id)) throw new Error(`multi-account: invalid account id ${JSON.stringify(String(id)).slice(0, 80)}`);
  return join(engineRoot(), 'accounts', id);
}

/** 账号的缺省工作目录:`<accountHome>/workspace`(会话没给 project_path / cwd 时用,给了也必须在账号文件夹里)。 */
export function accountWorkspaceDir(id: string): string {
  return join(accountHome(id), 'workspace');
}

/** 最深的已存在祖先取真实路径,再拼回其余段(软链、/tmp → /private/tmp 两侧同规)。 */
function realish(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail.reverse()); }
    catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

/**
 * 多账号模式下 p 是否在当前账号的文件夹里(含相等;按真实路径比)。从 cwd 往上找项目根 / 项目文档 / git 根的遍历
 * 走到这里为 false 就停 —— 别让账号的工作目录借上溯读到账号文件夹之外的东西。单人模式恒 true(调用方照旧遍历)。
 */
export function withinAccountRoot(p: string): boolean {
  if (!MULTI) return true;
  const id = currentAccountId();
  if (!id) return false;
  const root = realish(accountHome(id));
  const rel = relative(root, realish(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
