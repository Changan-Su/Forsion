/**
 * standalone(SQLite)存量库列迁移:老库(建库时 base schema 还没有新列)跑 runMigration 后,
 * 列集必须追平「今天新建的库」。守住两类回归:
 *   1. 补列写了 PG 专有语法(如 ADD COLUMN IF NOT EXISTS)→ SQLite 报语法错 → rethrow,测试直接红;
 *   2. 往 STANDALONE_SCHEMA 加了列却忘了在 migrate.ts columnBackfills 补一条 → 超集断言红。
 * 2026-08「no such column: projectless」事故即两者叠加:PG 语法 + catch 吞错,老库永远缺列。
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { createSqliteHost } from '../adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../core/dialectDDL.js';
import { STANDALONE_SCHEMA } from './schemaStandalone.js';
import { runMigration } from './migrate.js';

/** 模拟早期老库:chat 两表只有初版列;wechat 两表缺后来加的 channel。 */
const OLD_SCHEMA = `
CREATE TABLE chat_sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  app_id VARCHAR(50) NOT NULL DEFAULT 'tangu',
  title TEXT,
  model_id VARCHAR(128),
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE chat_messages (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  role VARCHAR(16) NOT NULL,
  content TEXT,
  timestamp BIGINT,
  model_id VARCHAR(128),
  reasoning TEXT,
  is_error BOOLEAN DEFAULT FALSE,
  tool_calls TEXT,
  tool_results TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tangu_wechat_accounts (
  id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  wx_user_id VARCHAR(128),
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE tangu_wechat_bindings (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  account_id VARCHAR(128) NOT NULL,
  peer_id VARCHAR(128),
  session_id VARCHAR(36) NOT NULL,
  remote_approval_mode VARCHAR(24) NOT NULL DEFAULT 'auto-edit',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

function tableCols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((r) => r.name);
}

/** 在给定初始 schema 的内存库上跑 runMigration(configureTangu 单例覆盖,串行调用安全)。 */
async function migrateFrom(initialSchema: string) {
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 't', userId: 'u' });
  db.exec(initialSchema);
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  return { cols: (t: string) => tableCols(db, t) };
}

describe('standalone(SQLite)老库列迁移', () => {
  it('老库跑完 runMigration 后列集追平新建库(含 projectless)', async () => {
    const fresh = await migrateFrom(toSqliteDDL(STANDALONE_SCHEMA)); // 今天新建的库
    const old = await migrateFrom(OLD_SCHEMA); // 存量老库
    expect(old.cols('chat_sessions'), '事故列').toContain('projectless');
    for (const table of ['chat_sessions', 'chat_messages', 'tangu_wechat_accounts', 'tangu_wechat_bindings']) {
      const migrated = old.cols(table);
      for (const col of fresh.cols(table)) {
        expect(migrated, `${table}.${col} 老库迁移后缺失(columnBackfills 漏补?)`).toContain(col);
      }
    }
  });
});
