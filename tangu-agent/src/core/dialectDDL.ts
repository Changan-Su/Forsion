/**
 * 把 core 的 Postgres 方言 DDL 转成 SQLite 可接受的形式。
 * 仅作用于「我们自己写的、受控的」schema DDL(migrate 的 CREATE TABLE + STANDALONE_SCHEMA),
 * 不是任意运行时 SQL,故定向替换是安全的。只需处理两类:
 *   - JSONB                → TEXT(SQLite 无 JSONB 类型;列里照存 JSON 字符串,应用层 stringify/parse)
 *   - BIGSERIAL PRIMARY KEY → INTEGER PRIMARY KEY AUTOINCREMENT(自增 rowid)
 * 其余 PG 类型(VARCHAR(n)/TIMESTAMP/BOOLEAN/BIGINT/INTEGER/TEXT)在 SQLite 下经类型亲和或
 * 现代字面量(TRUE/FALSE)原样可用;ON CONFLICT / CURRENT_TIMESTAMP 两方言一致,无需改写。
 */
export function toSqliteDDL(pgDDL: string): string {
  return pgDDL
    .replace(/\bBIGSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/\bJSONB\b/gi, 'TEXT');
}
