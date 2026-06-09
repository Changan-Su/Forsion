/**
 * DB 访问垫片:把曾经的 `import { query } from 'src/config/database'` 收敛到注入的 host。
 * 全部 lazy 取 deps()(运行时,装配之后),故各文件只需把 import 路径换到这里、调用点不变。
 */
import { deps } from '../seams/runtime.js';

export const query = <T = any>(sql: string, params?: any[]): Promise<T> =>
  deps().host.query<T>(sql, params);

export const getDbType = (): string => deps().host.getDbType();
export const getNowSql = (): string => deps().host.getNowSql();
export const getDateSql = (column: string): string => deps().host.getDateSql(column);
export const getDateSubSql = (days: number): string => deps().host.getDateSubSql(days);
