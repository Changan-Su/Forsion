/**
 * standalone 本地 Postgres 最小 schema(run/会话态)。共享数据(skills/memory/模型)走云端 brain。
 * 在 runMigration(建 agent_runs/steps/events + ALTER chat_sessions 加 historian 列)之前执行。
 * 以 TS 字符串内联(而非 .sql 文件),避免 tsc 不复制非 .ts 资产的问题。
 */
export const STANDALONE_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  app_id VARCHAR(50) NOT NULL DEFAULT 'tangu',
  title TEXT,
  model_id VARCHAR(128),
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  historian_last_summary_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id VARCHAR(36) PRIMARY KEY,
  session_id VARCHAR(36) NOT NULL,
  role VARCHAR(16) NOT NULL,
  content TEXT,
  timestamp BIGINT,
  model_id VARCHAR(128),
  reasoning TEXT,
  is_error BOOLEAN DEFAULT FALSE,
  tool_calls JSONB,
  tool_results JSONB,
  attachments JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);

CREATE TABLE IF NOT EXISTS global_settings (
  "key" VARCHAR(128) PRIMARY KEY,
  value TEXT
);
`;
