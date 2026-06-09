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

  /** 用户鉴权中间件(Bearer token)。 */
  authMiddleware: RequestHandler;
  /** 管理员鉴权中间件(需配合 authMiddleware)。 */
  adminMiddleware: RequestHandler;

  log(msg: string, ...args: any[]): void;
  warn(msg: string, ...args: any[]): void;
  error(msg: string, ...args: any[]): void;
}
