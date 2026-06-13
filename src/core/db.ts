/**
 * DB 访问垫片:把曾经的 `import { query } from 'src/config/database'` 收敛到注入的 host。
 * 全部 lazy 取 deps()(运行时,装配之后),故各文件只需把 import 路径换到这里、调用点不变。
 */
import { deps } from '../seams/runtime.js';
import { toSqliteDDL } from './dialectDDL.js';

export const query = <T = any>(sql: string, params?: any[]): Promise<T> =>
  deps().host.query<T>(sql, params);

export const getDbType = (): string => deps().host.getDbType();
export const getNowSql = (): string => deps().host.getNowSql();
export const getDateSql = (column: string): string => deps().host.getDateSql(column);
export const getDateSubSql = (days: number): string => deps().host.getDateSubSql(days);

/** schema DDL 方言适配:sqlite host 下把 PG DDL 转 SQLite,其余原样(microserver/worker/外部 PG 仍为 PG)。 */
export const ddl = (sql: string): string =>
  deps().host.getDbType() === 'sqlite' ? toSqliteDDL(sql) : sql;

/** 「column 早于 minutes 分钟前」的 SQL 片段(整数内联,无注入)。host 未实现则回退 Postgres 形式。 */
export const getOlderThanSql = (column: string, minutes: number): string => {
  const h = deps().host;
  if (h.getOlderThanSql) return h.getOlderThanSql(column, minutes);
  return `${column} < CURRENT_TIMESTAMP - INTERVAL '${Math.max(0, Math.floor(minutes))} minutes'`;
};
