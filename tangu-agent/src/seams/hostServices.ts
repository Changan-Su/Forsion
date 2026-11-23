/**
 * 接缝:HostServices —— DB / 鉴权中间件 / 日志 / SQL 方言。
 *
 * 与 server/src/microBackend/types.ts 的 MicroBackendHost 同构,故 microserver 模式下
 * Forsion 注入的 host 可直接当 HostServices 用(零适配);standalone 模式由 localHost 实现。
 */
import type { RequestHandler } from 'express';

export interface HostServices {
  /** PostgreSQL 查询(MySQL-style ? 占位符自动转 $1/$2…)。 */
  query<T = any>(sql: string, params?: any[]): Promise<T>;
  getDbType(): string;
  getNowSql(): string;
  getDateSql(column: string): string;
  getDateSubSql(days: number): string;
  /** 可选:返回「column 早于 minutes 分钟前」的 SQL 片段(整数 minutes 内联,无注入)。
   *  缺省时 core 用 Postgres 形式(microserver/worker/外部 PG 皆为 PG,无需实现);
   *  仅 sqliteHost 覆写为 datetime() 形式。 */
  getOlderThanSql?(column: string, minutes: number): string;
  /** 可选:同步事务(只有本机 SQLite 实现)。fn 里用 run 同步执行语句(SELECT / RETURNING 回行,其余回空数组),
   *  整段 BEGIN IMMEDIATE … COMMIT,抛错整段回滚。fn 里不能 await —— 正是同步才保证别的异步任务插不进这段事务。
   *  没实现 = 调用方按各自的「可重放」退路逐条写(外部 PG / PGlite)。 */
  transactionSync?<T>(fn: (run: (sql: string, params?: any[]) => any[]) => T): T;

  /** 用户鉴权中间件(Bearer token)。 */
  authMiddleware: RequestHandler;
  /** 管理员鉴权中间件(需配合 authMiddleware)。 */
  adminMiddleware: RequestHandler;

  log(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
}
