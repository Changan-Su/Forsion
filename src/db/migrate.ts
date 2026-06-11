/**
 * agent-core 迁移：runs / steps / events 三张表（幂等）。
 * 被 migrate-all 的 microserver 扫描段自动执行，也可被模块内部调用。
 * 对齐设计文档 server/Documents/Tangu-Agent-云架构设计.md §4.2。
 * 注：agent_sandboxes 表在 Phase B 沙箱落地时追加。
 */
import { query } from '../core/db.js';

export async function runMigration(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(36) NOT NULL,
      user_id VARCHAR(36) NOT NULL,
      app_id VARCHAR(50) NOT NULL DEFAULT 'ai-studio',
      status VARCHAR(16) NOT NULL DEFAULT 'queued',
      current_step INTEGER NOT NULL DEFAULT 0,
      model_id VARCHAR(128),
      sandbox_id VARCHAR(36),
      assistant_message_id VARCHAR(36),
      input JSONB,
      result JSONB,
      error TEXT,
      tokens_total INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)`);

  await query(`
    CREATE TABLE IF NOT EXISTS agent_steps (
      id VARCHAR(36) PRIMARY KEY,
      run_id VARCHAR(36) NOT NULL,
      step_no INTEGER NOT NULL,
      llm_request JSONB,
      llm_response JSONB,
      tool_calls JSONB,
      tool_results JSONB,
      state_delta JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, step_no)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id)`);

  await query(`
    CREATE TABLE IF NOT EXISTS agent_run_events (
      id BIGSERIAL PRIMARY KEY,
      run_id VARCHAR(36) NOT NULL,
      seq INTEGER NOT NULL,
      type VARCHAR(24) NOT NULL,
      payload JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, seq)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_run_events(run_id)`);

  // 修复共享 files 表唯一约束漏掉 app_id 的 bug：parent_id='ROOT' 是跨 app 共享 sentinel，
  // 旧约束 (user_id, parent_id, name, is_deleted) 让两个 app 不能各自拥有同名顶级目录
  // （旧 'agent' app 占了 workspace → 'ai-studio' 建不了自己的 workspace，云端 snapshot 静默失败）。
  // 加上 app_id 即修复（仅放宽约束，存量行不会违反）。幂等。
  try {
    const oldName = 'files_user_id_parent_id_name_is_deleted_key';
    const newName = 'files_user_app_parent_name_deleted_key';
    const hasNew = await query<any[]>(
      `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'files'::regclass`,
      [newName],
    );
    if (!hasNew.length) {
      await query(`ALTER TABLE files DROP CONSTRAINT IF EXISTS ${oldName}`);
      await query(`ALTER TABLE files ADD CONSTRAINT ${newName} UNIQUE (user_id, app_id, parent_id, name, is_deleted)`);
      console.log('✅ [agent-core] files 唯一约束已修正为含 app_id');
    }
  } catch (e: any) {
    console.warn('[agent-core] files 约束修正失败（可能并发或权限）：', e?.message || e);
  }

  // Historian：会话复盘标记列（幂等）。记录某 session 上次被 historian 处理的时间，
  // 配合扫描谓词「last IS NULL OR last < updated_at」只在 session 有新活动后再复盘。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS historian_last_summary_at TIMESTAMP`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_historian ON chat_sessions(app_id, archived, updated_at)`);
  } catch (e: any) {
    console.warn('[agent-core] historian 列迁移失败：', e?.message || e);
  }

  // 会话级 agent 配置 + emoji（桌面端会话设置;幂等,云端已有同名列时为 no-op）。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_config JSONB`);
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS emoji VARCHAR(32)`);
  } catch (e: any) {
    console.warn('[agent-core] agent_config/emoji 列迁移失败：', e?.message || e);
  }

  // 图片附件链路:hydrateHistory 读 chat_messages.attachments(新基础 schema 已内联;
  // 老库补列,幂等)。
  try {
    await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB`);
  } catch (e: any) {
    console.warn('[agent-core] chat_messages.attachments 列迁移失败：', e?.message || e);
  }

  console.log('✅ [agent-core] migrations done (agent_runs/agent_steps/agent_run_events)');
}
