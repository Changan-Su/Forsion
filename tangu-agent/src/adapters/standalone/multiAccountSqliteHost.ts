/**
 * 多账号模式的 HostServices:每个账号一个 SQLite 库(`<accountHome>/state.db`),按需打开、按账号缓存;
 * `query` / `transactionSync` 按当前账号(core/accountScope.ts)路由,没有账号就抛。不靠查询条件区分人 —— 库文件本身就是每人一份。
 *
 * 另有一份引擎级的「会话 id → 账号」登记(`<engineRoot>/session-owners.db`):会话 id 可以由客户端给(POST /agent/runs 会自动建会话),
 * 而进程里有不少以 sessionId 为键的表(排队、审批「总是允许」、上传、按停复盘…)。登记保证同一个会话 id 只属于一个账号:
 * 往 chat_sessions 插行之前先认领,已经是别人的就拒;路由层据此把别人的会话 id 当不存在(404)。
 */
import type { RequestHandler } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { HostServices } from '../../seams/hostServices.js';
import { accountHome, currentAccountId, engineRoot, isValidAccountId, runWithAccount } from '../../core/accountScope.js';
import { toSqliteDDL } from '../../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../../db/schemaStandalone.js';
import { applyWalWithFallback, sanitize } from './sqliteHost.js';

/** 宿主填的受信头(与引擎现有的受信账号头同名)。 */
export const ACCOUNT_HEADER = 'x-forsion-user';

export type AccountIdentity =
  | { ok: true; accountId: string }
  | { ok: false; status: 400 | 401; detail: string };

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 「来的是谁」:口令(证明请求来自宿主)+ X-Forsion-User(宿主验完登录后填)。口令不对 / 缺头 → 401;头格式不合格 → 400。 */
export function checkAccountIdentity(headers: Record<string, string | string[] | undefined>, localToken: string): AccountIdentity {
  const auth = headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !localToken || !sameSecret(auth.slice(7), localToken)) {
    return { ok: false, status: 401, detail: 'Unauthorized' };
  }
  const raw = headers[ACCOUNT_HEADER];
  if (raw === undefined || raw === '') return { ok: false, status: 401, detail: 'Unauthorized' };
  if (typeof raw !== 'string' || !isValidAccountId(raw)) return { ok: false, status: 400, detail: 'Invalid account id' };
  return { ok: true, accountId: raw };
}

export interface MultiAccountHost {
  host: HostServices;
  /** 开户(本进程第一次见到某账号):核对落盘位置、建目录、base schema、把库里已有的会话 id 补登进登记表、provision(迁移 + 收敛上次留下的 run + 播种)。
   *  同账号并发的首请求共享一个 promise;失败下次重试。 */
  ensureAccount(id: string): Promise<void>;
  /** 会话 id 现在归谁(没人认领过 → undefined)。 */
  sessionOwner(sessionId: string): string | undefined;
  /** 当前账号认领一个会话 id:没人认领 → 记成自己的;已经是自己的 → true;是别人的 → false。 */
  claimSession(sessionId: string): boolean;
  /** 已打开库的账号(测试 / 诊断)。 */
  openAccounts(): string[];
  close(): void;
}

export interface MultiAccountHostConfig {
  localToken: string;
  /** 开户时在该账号上下文里跑:迁移、播种内置技能 / 示例命令。 */
  provision: (accountId: string) => Promise<void>;
}

const INSERT_SESSION_RE = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+chat_sessions\s*\(\s*id\s*[,)]/i;
/** 任何往 chat_sessions 写新行的写法(INSERT / REPLACE …)。不是「第一列是 id」的那种就拒(缺省拒绝:认领不了的不让写)。 */
const ANY_SESSION_INSERT_RE = /\b(?:INSERT|REPLACE)\b[^;]*?\bINTO\s+chat_sessions\b/i;

export class SessionIdTakenError extends Error {
  constructor() { super('Session not found'); this.name = 'SessionIdTakenError'; }
}

/**
 * 开户前核对账号的落盘位置没被软链引到别处:`accounts/`、账号 home 必须是真目录(不是软链),state.db 及已存在的 -wal / -shm
 * 必须是普通文件(不是软链、没有别的硬链接),home 的真实路径必须正好是 `<engineRoot 的真实路径>/accounts/<id>`。
 * 不满足就抛(这次开户失败,请求 500),日志写清是哪一项。engineRoot 本身经软链到达是允许的(宿主自己的配置)。
 */
export function assertAccountPaths(id: string): void {
  const home = accountHome(id);
  const accountsDir = join(engineRoot(), 'accounts');
  const fail = (why: string): never => {
    const msg = `multi-account: refusing to open account ${id}: ${why}`;
    console.error(`[tangu] ${msg}`);
    throw new Error(msg);
  };
  const realDir = (p: string): void => {
    let st;
    try { st = lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) fail(`${p} is a symbolic link`);
    if (!st.isDirectory()) fail(`${p} is not a directory`);
  };
  realDir(accountsDir);
  realDir(home);
  mkdirSync(home, { recursive: true });
  realDir(accountsDir);
  realDir(home);
  const expected = join(realpathSync.native(engineRoot()), 'accounts', id);
  const real = realpathSync.native(home);
  if (real !== expected) fail(`${home} resolves to ${real}, not ${expected}`);
  for (const name of ['state.db', 'state.db-wal', 'state.db-shm']) {
    const f = join(home, name);
    let st;
    try { st = lstatSync(f); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) fail(`${f} is a symbolic link`);
    if (!st.isFile()) fail(`${f} is not a regular file`);
    if (st.nlink > 1) fail(`${f} has other hard links`);
  }
}

export function createMultiAccountSqliteHost(cfg: MultiAccountHostConfig): MultiAccountHost {
  const dbs = new Map<string, Database.Database>();
  const ready = new Map<string, Promise<void>>();

  mkdirSync(engineRoot(), { recursive: true });
  const owners = new Database(join(engineRoot(), 'session-owners.db'));
  applyWalWithFallback(owners);
  owners.pragma('busy_timeout = 5000');
  owners.exec(`CREATE TABLE IF NOT EXISTS session_owners (session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const ownerOf = owners.prepare('SELECT account_id FROM session_owners WHERE session_id = ?').pluck();
  const claimIns = owners.prepare('INSERT OR IGNORE INTO session_owners (session_id, account_id) VALUES (?, ?)');

  const sessionOwner = (sessionId: string): string | undefined => {
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    return (ownerOf.get(sessionId) as string | undefined) ?? undefined;
  };
  const claimFor = (accountId: string, sessionId: string): boolean => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    claimIns.run(sessionId, accountId);
    return sessionOwner(sessionId) === accountId;
  };

  /**
   * 开户时把这个账号库里已有的会话 id 补登给这个账号(登记表和账号库可能不同步:登记表丢了 / 账号库是搬来的 / 上次进程在
   * 插行和认领之间退出)。已被别的账号登记的 id 不改动、不中断开户,只在日志里写清楚 —— 那条会话在本账号里照常可见,
   * 但它的 id 起新 run 会被当成别人的(404)。
   */
  const backfillClaims = (id: string, db: Database.Database): void => {
    const ids = (db.prepare('SELECT id FROM chat_sessions').pluck().all() as unknown[]).filter((x): x is string => typeof x === 'string' && !!x);
    if (!ids.length) return;
    owners.transaction((list: string[]) => { for (const sid of list) claimIns.run(sid, id); })(ids);
    for (const sid of ids) {
      const owner = sessionOwner(sid);
      if (owner !== id) console.error(`[tangu] multi-account: session ${sid} in account ${id} is registered to another account; registry left unchanged`);
    }
  };

  const accountOrThrow = (what: string): string => {
    const id = currentAccountId();
    if (!id) throw new Error(`multi-account: no account in context for ${what}`);
    return id;
  };

  const dbFor = (id: string): Database.Database => {
    let db = dbs.get(id);
    if (db) return db;
    assertAccountPaths(id); // 账号 home / 库文件不许是软链、不许落到 accounts/<id> 之外
    db = new Database(join(accountHome(id), 'state.db'));
    applyWalWithFallback(db);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(toSqliteDDL(STANDALONE_SCHEMA)); // base schema(幂等);runMigration 在开户时跑
    dbs.set(id, db);
    return db;
  };

  /** 往 chat_sessions 插行前先认领会话 id(第一列一律是 id);是别人的就拒,不让两个账号的会话共用进程里以 sessionId 为键的表。 */
  const guardSessionInsert = (accountId: string, sql: string, params: any[]): void => {
    if (!INSERT_SESSION_RE.test(sql)) {
      if (ANY_SESSION_INSERT_RE.test(sql)) throw new Error('multi-account: chat_sessions inserts must list id as the first column');
      return;
    }
    const sid = params[0];
    if (typeof sid !== 'string' || !claimFor(accountId, sid)) throw new SessionIdTakenError();
  };

  const runStmt = (db: Database.Database, sql: string, params?: any[]): any[] => {
    const clean = (params ?? []).map(sanitize);
    const stmt = db.prepare(sql);
    if (stmt.reader) return stmt.all(...clean) as any[];
    stmt.run(...clean);
    return [];
  };

  const authMiddleware: RequestHandler = (req, res, next) => {
    const who = checkAccountIdentity(req.headers, cfg.localToken);
    if (!who.ok) return res.status(who.status).json({ detail: who.detail });
    // app 级闸已经把整个请求绑进 runWithAccount;对不上说明有路由绕过了它 —— 缺省拒绝。
    if (currentAccountId() !== who.accountId) return res.status(401).json({ detail: 'Unauthorized' });
    (req as any).user = { userId: who.accountId, username: who.accountId, role: 'USER' };
    next();
  };

  const host: HostServices = {
    query: async <T = any>(sql: string, params?: any[]): Promise<T> => {
      const id = accountOrThrow('host.query');
      guardSessionInsert(id, sql, params ?? []);
      return runStmt(dbFor(id), sql, params) as unknown as T;
    },
    transactionSync: <T>(fn: (run: (sql: string, params?: any[]) => any[]) => T): T => {
      const id = accountOrThrow('host.transactionSync');
      const db = dbFor(id);
      const run = (sql: string, params?: any[]): any[] => {
        guardSessionInsert(id, sql, params ?? []);
        return runStmt(db, sql, params);
      };
      return db.transaction(() => fn(run)).immediate();
    },
    getDbType: () => 'sqlite',
    getNowSql: () => 'CURRENT_TIMESTAMP',
    getDateSql: (column: string) => `date(${column})`,
    getDateSubSql: (days: number) => `date('now', '-${Math.max(0, Math.floor(days))} days')`,
    getOlderThanSql: (column: string, minutes: number) =>
      `${column} < datetime('now', '-${Math.max(0, Math.floor(minutes))} minutes')`,
    authMiddleware,
    adminMiddleware: (_req, res) => { res.status(403).json({ detail: 'Forbidden' }); }, // 多账号模式没有管理员
    log: (msg, ...a) => console.log('[tangu]', msg, ...a),
    warn: (msg, ...a) => console.warn('[tangu]', msg, ...a),
    error: (msg, ...a) => console.error('[tangu]', msg, ...a),
  };

  const ensureAccount = (id: string): Promise<void> => {
    if (!isValidAccountId(id)) return Promise.reject(new Error('multi-account: invalid account id'));
    let p = ready.get(id);
    if (!p) {
      p = runWithAccount(id, async () => {
        backfillClaims(id, dbFor(id));
        await cfg.provision(id);
      });
      p.catch(() => { if (ready.get(id) === p) ready.delete(id); });
      ready.set(id, p);
    }
    return p;
  };

  return {
    host,
    ensureAccount,
    sessionOwner,
    claimSession: (sessionId) => claimFor(accountOrThrow('claimSession'), sessionId),
    openAccounts: () => [...dbs.keys()],
    close: () => {
      for (const db of dbs.values()) { try { db.close(); } catch { /* ignore */ } }
      dbs.clear();
      ready.clear();
      try { owners.close(); } catch { /* ignore */ }
    },
  };
}
