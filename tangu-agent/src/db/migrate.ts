/**
 * agent-core 迁移：runs / steps / events 三张表（幂等）。
 * 被 migrate-all 的 microserver 扫描段自动执行，也可被模块内部调用。
 * 对齐设计文档 server/Documents/Tangu-Agent-云架构设计.md §4.2。
 * 注：agent_sandboxes 表在 Phase B 沙箱落地时追加。
 */
import { query, ddl, getDbType } from '../core/db.js';

export async function runMigration(): Promise<void> {
  await query(ddl(`
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
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)`);

  await query(ddl(`
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
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id)`);

  await query(ddl(`
    CREATE TABLE IF NOT EXISTS agent_run_events (
      id BIGSERIAL PRIMARY KEY,
      run_id VARCHAR(36) NOT NULL,
      seq INTEGER NOT NULL,
      type VARCHAR(24) NOT NULL,
      payload JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, seq)
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_run_events(run_id)`);

  // 配置驱动 profile：per-app 覆盖(admin panel 可改;DB > 文件 > 基线)。所有方言都建(经 ddl()
  // 把 JSONB 转 SQLite TEXT),故 server / 远程 worker / standalone 共享同一表语义。
  // 故意不含 hostExec/historian/sandboxMode 列——部署级强制,绝不可经覆盖授予(红线)。
  await query(ddl(`
    CREATE TABLE IF NOT EXISTS app_profile_overrides (
      app_id VARCHAR(50) PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      display_name VARCHAR(255),
      default_model_id VARCHAR(128),
      tool_builtins JSONB,
      capabilities JSONB,
      features JSONB,
      prompt_guidance JSONB,
      prompt_environment JSONB,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));

  // ── 第二轮新增表（本地 Special Agent + 上下文压缩;所有方言,ddl() 把 JSONB→SQLite TEXT）──
  // Special Agent 为本地特性(桌面/TUI)；云端建这些表只是防御性空表,零写入、零影响。

  // Muse 后台 agent 产出的 TODO 清单（本地隔离）。
  await query(ddl(`
    CREATE TABLE IF NOT EXISTS muse_todos (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      source_session_id VARCHAR(36),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_muse_todos_user ON muse_todos(user_id, status)`);

  // Special Agent（Historian/Muse）人类可读活动流（驱动工作视图）。
  await query(ddl(`
    CREATE TABLE IF NOT EXISTS special_agent_log (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      agent VARCHAR(16) NOT NULL,
      action VARCHAR(48) NOT NULL,
      detail TEXT,
      session_ref VARCHAR(36),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_special_agent_log_user ON special_agent_log(user_id, agent, created_at)`);

  // 会话压缩检查点：hydrate 时用 summary + through_timestamp 之后的消息重建上下文（前缀稳定,守 prompt-cache）。
  await query(ddl(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id VARCHAR(36) PRIMARY KEY,
      session_id VARCHAR(36) NOT NULL,
      summary TEXT NOT NULL,
      through_timestamp BIGINT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id)`);

  // WeChat Remote 绑定表：iLink bot token 只保存在本地 ~/.tangu/wechat/accounts.json，
  // DB 仅记录账号、peer 与 Tangu session 的绑定关系。
  await query(ddl(`
    CREATE TABLE IF NOT EXISTS tangu_wechat_accounts (
      id VARCHAR(128) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      wx_user_id VARCHAR(128),
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_tangu_wechat_accounts_user ON tangu_wechat_accounts(user_id, status)`);

  await query(ddl(`
    CREATE TABLE IF NOT EXISTS tangu_wechat_bindings (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      account_id VARCHAR(128) NOT NULL,
      peer_id VARCHAR(128),
      session_id VARCHAR(36) NOT NULL,
      remote_approval_mode VARCHAR(24) NOT NULL DEFAULT 'readonly',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_tangu_wechat_bindings_user ON tangu_wechat_bindings(user_id, is_active)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tangu_wechat_bindings_account_peer ON tangu_wechat_bindings(account_id, peer_id, is_active)`);

  // 用户收件箱(Inbox Space;本地特性,云端建空表零写入,同 muse_todos 纪律)。不进 StateStore,全程直连 query()。
  // 到期投递无定时器:读端过滤 deliver_at IS NULL OR deliver_at <= now 即「已投递」。
  // DELETE=软删(deleted_at):广播行硬删会破坏去重锚(唯一索引)与 MAX(created_at) 拉取游标 → 消息复活。
  // 广播行 created_at 存服务端 to_char 微秒原文(拉取游标原料);本地行走 DEFAULT CURRENT_TIMESTAMP。
  await query(ddl(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36) NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      sender_kind VARCHAR(16) NOT NULL DEFAULT 'agent',
      sender_id VARCHAR(64),
      origin_broadcast_id VARCHAR(36),
      deliver_at TIMESTAMP,
      read_at TIMESTAMP,
      archived_at TIMESTAMP,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `));
  await query(`CREATE INDEX IF NOT EXISTS idx_inbox_messages_user ON inbox_messages(user_id, archived_at, created_at)`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_messages_broadcast
    ON inbox_messages(user_id, origin_broadcast_id) WHERE origin_broadcast_id IS NOT NULL`);

  // 以下迁移仅对共享云库 / 外部 Postgres 生效：standalone(SQLite) 的 base schema(STANDALONE_SCHEMA)
  // 已完整建好 chat_sessions/chat_messages 的全部列，且 SQLite 的 ALTER ADD COLUMN 不支持
  // IF NOT EXISTS、也无 pg_constraint 目录，故 sqlite 形态在此提前返回，跳过整段 PG-only 迁移。
  if (getDbType() !== 'postgres') {
    // 老 SQLite 库补 kind 列（base schema 已含;此 ALTER 兜旧库。SQLite 不支持 IF NOT EXISTS,
    // 重复列报错吞掉即幂等)。隔离 Special Agent 工作会话不进会话列表。
    try { await query(`ALTER TABLE chat_sessions ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'user'`); }
    catch { /* 列已存在 */ }
    // 老 SQLite 库逐列补齐消息媒体与作者字段。base schema 只影响新库；CREATE TABLE IF NOT EXISTS
    // 不会给存量表补列，因此这里必须显式 ALTER（SQLite 不支持 IF NOT EXISTS，重复列错误吞掉即幂等）。
    for (const sql of [
      `ALTER TABLE chat_messages ADD COLUMN attachments JSONB`,
      `ALTER TABLE chat_messages ADD COLUMN display_files JSONB`,
      `ALTER TABLE chat_messages ADD COLUMN agent_slug VARCHAR(64)`,
      // Background Session 父链接:@讨论 / Historian 辅助讨论等隐藏子会话指回其来源会话,
      // 供 GET /agent/sessions/:id/background(右栏「子聊天」)持久列出。
      `ALTER TABLE chat_sessions ADD COLUMN parent_session_id VARCHAR(36)`,
    ]) {
      try { await query(sql); }
      catch { /* 列已存在 */ }
    }
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent ON chat_sessions(parent_session_id)`);
    console.log('✅ [agent-core] migrations done (sqlite：base schema 已含全部列)');
    return;
  }

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

  // 会话 kind（user|historian|muse）：隔离 Special Agent 工作会话不进列表。幂等。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'user'`);
  } catch (e: any) {
    console.warn('[agent-core] chat_sessions.kind 列迁移失败：', e?.message || e);
  }

  // Background Session 父链接(@讨论/Historian 辅助讨论等指回来源会话)。幂等。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS parent_session_id VARCHAR(36)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent ON chat_sessions(parent_session_id)`);
  } catch (e: any) {
    console.warn('[agent-core] chat_sessions.parent_session_id 列迁移失败：', e?.message || e);
  }

  // 会话级 agent 配置 + emoji（桌面端会话设置;幂等,云端已有同名列时为 no-op）。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS agent_config JSONB`);
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS emoji VARCHAR(32)`);
  } catch (e: any) {
    console.warn('[agent-core] agent_config/emoji 列迁移失败：', e?.message || e);
  }

  // todo 工具(builtin:todo)的会话级任务清单(幂等)。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS todos JSONB`);
  } catch (e: any) {
    console.warn('[agent-core] chat_sessions.todos 列迁移失败：', e?.message || e);
  }

  // 项目工作区(桌面本机模式会话按项目分组;云端会话恒 NULL,零影响)。幂等。
  try {
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS project_path TEXT`);
    await query(`ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS project_name VARCHAR(255)`);
  } catch (e: any) {
    console.warn('[agent-core] chat_sessions.project_* 列迁移失败：', e?.message || e);
  }

  // 图片附件链路:hydrateHistory 读 chat_messages.attachments(新基础 schema 已内联;
  // 老库补列,幂等)。
  try {
    await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachments JSONB`);
    // agent 在对话区展示的文件(display_file / generate_image / 表情包):路径或内联 dataUrl 列表。
    await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS display_files JSONB`);
    // 产出该消息的 agent slug(客户端据此还原头像/昵称;旧消息 NULL → 回退会话 agent)。
    await query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS agent_slug VARCHAR(64)`);
  } catch (e: any) {
    console.warn('[agent-core] chat_messages.attachments/display_files/agent_slug 列迁移失败：', e?.message || e);
  }

  console.log('✅ [agent-core] migrations done (agent_runs/agent_steps/agent_run_events)');
}
