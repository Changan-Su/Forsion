/**
 * H5 未知档位 fail-closed —— 三个「读审批档」的解析口(审批档重设计 2026-09-25 §3.4 的补漏):
 *   ① agentRegistry:config.toml 的 approval_mode(以及旧扁平 .md 迁移源的 approvalMode);
 *   ② projectContext:project-settings.json / 设置接口里的项目默认 approvalMode;
 *   ③ groupChat.sanitizeTempAgents:客户端发来的临时团队成员 approvalMode。
 * 旧口径三处都是「不在白名单 → 静默丢掉 / 写成 ''」= 跟随会话 / 缺省档 —— 用户手改配置想收紧,拼错一个字反而放宽。
 * 现在统一走 approvals.normalizeApprovalMode:空 / 缺席照旧(= 跟随);四个 id 原样;其它非空值 → readonly 并告警。
 * 末尾一块真 loop:config.toml 写了拼错的档的 Agent,私聊里工作区内写照样要批(旧口径 → auto-edit 不问)。
 *
 * ⚠️ normalizeApprovalMode 的告警按「来源|值」进程内去重 —— 断言告警的用例各用不同的 slug / 值。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { subscribe } from '../src/services/eventBus.js';
import { resolveApproval } from '../src/services/approvals.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { getAgent, parseAgentConfig, parseAgentFile } from '../src/agents/agentRegistry.js';
import { readProjectSettings, sanitizeProjectSettings, projectSettingsFile } from '../src/services/projectContext.js';
import { sanitizeTempAgents } from '../src/services/groupChat.js';

const USER = 'u1';
let home: string;
let warn: ReturnType<typeof vi.spyOn>;

const warned = (re: RegExp): boolean => warn.mock.calls.some((c) => re.test(String(c[0])));

function agentFolder(slug: string, tomlTail: string): string {
  const dir = join(home, 'agents', slug);
  mkdirSync(join(dir, 'Library'), { recursive: true });
  writeFileSync(join(dir, 'config.toml'), `name = "${slug}"\n${tomlTail}`);
  writeFileSync(join(dir, 'SOUL.md'), `You are ${slug}.`);
  return join(dir, 'Library');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-h5-parsers-'));
  process.env.TANGU_HOME = home;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('① agentRegistry · config.toml approval_mode', () => {
  it('拼错 / 大小写变体 / 非字符串 → readonly 并告警(点名 agent 与来源)', () => {
    expect(parseAgentConfig('typo-a', 'name = "A"\napproval_mode = "read-only"\n', '').approvalMode).toBe('readonly');
    expect(warned(/未知审批档 "read-only"\(来源 agent typo-a config\.toml\)/)).toBe(true);
    expect(parseAgentConfig('typo-b', 'name = "B"\napproval_mode = "Full-Auto"\n', '').approvalMode).toBe('readonly');
    expect(parseAgentConfig('typo-c', 'name = "C"\napproval_mode = 5\n', '').approvalMode).toBe('readonly');
    expect(parseAgentConfig('typo-d', 'name = "D"\napproval_mode = true\n', '').approvalMode).toBe('readonly');
  });

  it('对照:缺席 / 空串 → \'\'(跟随会话,不告警);四个 id 原样', () => {
    expect(parseAgentConfig('ok-a', 'name = "A"\n', '').approvalMode).toBe('');
    expect(parseAgentConfig('ok-b', 'name = "B"\napproval_mode = ""\n', '').approvalMode).toBe('');
    for (const m of ['readonly', 'auto-edit', 'full-auto', 'custom']) {
      expect(parseAgentConfig(`ok-${m}`, `name = "X"\napproval_mode = "${m}"\n`, '').approvalMode).toBe(m);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('磁盘上的 Agent(getAgent 读 config.toml)同样归一 —— 设置页与激活看到的都是 readonly', async () => {
    agentFolder('disk-typo', 'approval_mode = "read only"\n');
    expect((await getAgent('disk-typo'))?.approvalMode).toBe('readonly');
    expect(warned(/未知审批档 "read only"\(来源 agent disk-typo config\.toml\)/)).toBe(true);
    agentFolder('disk-empty', 'approval_mode = ""\n');
    expect((await getAgent('disk-empty'))?.approvalMode).toBe('');
    // 少个引号 = 非法 TOML(整份解析失败)→ 照样 readonly,不回落成跟随会话
    agentFolder('disk-unquoted', 'approval_mode = readonly\n');
    expect((await getAgent('disk-unquoted'))?.approvalMode).toBe('readonly');
  });

  it('首尾空白先剥(同 projectContext):纯空白 = 跟随会话、带空格的已知档原样,都不告警', () => {
    expect(parseAgentConfig('ws-a', 'name = "A"\napproval_mode = "   "\n', '').approvalMode).toBe('');
    expect(parseAgentConfig('ws-b', 'name = "B"\napproval_mode = " auto-edit "\n', '').approvalMode).toBe('auto-edit');
    expect(parseAgentConfig('ws-c', 'name = "C"\napproval_mode = "full-auto\\t"\n', '').approvalMode).toBe('full-auto');
    expect(warn).not.toHaveBeenCalled();
  });

  it('整份 TOML 解析失败(最常见:approval_mode 忘了引号)→ 有非空 approval_mode 行就 readonly 并告警', () => {
    // 旧口径:parseToml 抛错 → meta = {} → '' = 跟随会话(host 上 auto-edit),想收紧反而放宽
    expect(parseAgentConfig('unq-a', 'name = "A"\napproval_mode = readonly\n', '').approvalMode).toBe('readonly');
    expect(warned(/agent unq-a 的 config\.toml 解析失败,其中 approval_mode = readonly 按 readonly 处理/)).toBe(true);
    // 写的是更宽的档也一样:文件已不可信,只许更严
    expect(parseAgentConfig('unq-b', 'name = "B"\napproval_mode = full-auto\n', '').approvalMode).toBe('readonly');
    // approval_mode 本身合法、坏的是别的行 → 同样 readonly(不取信坏文件里的放宽档)
    expect(parseAgentConfig('unq-c', 'name = "C\napproval_mode = "full-auto"\n', '').approvalMode).toBe('readonly');
    // CRLF 换行照认
    expect(parseAgentConfig('unq-d', 'name = "D"\r\napproval_mode = auto-edit\r\n', '').approvalMode).toBe('readonly');
    // 告警按 slug|原值 去重(云端每次请求都重解析):同一坏文件再解析一次仍是 readonly,但不再告警
    const n = warn.mock.calls.length;
    expect(parseAgentConfig('unq-a', 'name = "A"\napproval_mode = readonly\n', '').approvalMode).toBe('readonly');
    expect(warn.mock.calls.length).toBe(n);
  });

  it('对照:解析失败但没写 approval_mode / 写的是空串 → \'\'(跟随会话,不告警);`=` 后换行不把下一行算进来', () => {
    expect(parseAgentConfig('unq-none', 'name = oops\n', '').approvalMode).toBe('');
    expect(parseAgentConfig('unq-empty', 'name = oops\napproval_mode = ""\n', '').approvalMode).toBe('');
    expect(parseAgentConfig('unq-empty-c', "name = oops\napproval_mode = '' # inherit\n", '').approvalMode).toBe('');
    expect(parseAgentConfig('unq-nl', 'approval_mode =\nname = "x"\n', '').approvalMode).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('旧扁平 .md(迁移源)的 approvalMode 同口径', () => {
    expect(parseAgentFile('legacy-x', '---\nname: X\napprovalMode: fullauto\n---\nb').approvalMode).toBe('readonly');
    expect(warned(/来源 agent legacy-x \(legacy \.md\)/)).toBe(true);
    expect(parseAgentFile('legacy-y', '---\nname: Y\n---\nb').approvalMode).toBe('');
    // 引号里的空白也先剥:纯空白 = 跟随会话,带空格的已知档原样
    expect(parseAgentFile('legacy-ws', '---\nname: W\napprovalMode: "  "\n---\nb').approvalMode).toBe('');
    expect(parseAgentFile('legacy-pad', '---\nname: P\napprovalMode: " full-auto "\n---\nb').approvalMode).toBe('full-auto');
  });
});

describe('② projectContext · 项目默认 approvalMode', () => {
  it('拼错 / 超长 / 非字符串 → readonly 并告警;只带一个坏档的项目不再被当成「没有有效键」删掉', () => {
    expect(sanitizeProjectSettings({ approvalMode: 'yolo' })).toEqual({ approvalMode: 'readonly' });
    expect(warned(/未知审批档 "yolo"\(来源 project settings approvalMode\)/)).toBe(true);
    expect(sanitizeProjectSettings({ model: 'm', approvalMode: 'x'.repeat(40) })).toEqual({ model: 'm', approvalMode: 'readonly' });
    expect(sanitizeProjectSettings({ approvalMode: 7 })).toEqual({ approvalMode: 'readonly' });
  });

  it('对照:首尾空白照旧剥掉;空 / 纯空白 / null → 不设;四个 id 原样', () => {
    expect(sanitizeProjectSettings({ approvalMode: ' auto-edit ' })).toEqual({ approvalMode: 'auto-edit' });
    expect(sanitizeProjectSettings({ approvalMode: '' })).toBeNull();
    expect(sanitizeProjectSettings({ approvalMode: '   ' })).toBeNull();
    expect(sanitizeProjectSettings({ model: 'm', approvalMode: null })).toEqual({ model: 'm' });
    for (const m of ['readonly', 'auto-edit', 'full-auto', 'custom']) expect(sanitizeProjectSettings({ approvalMode: m })).toEqual({ approvalMode: m });
    expect(warn).not.toHaveBeenCalled();
  });

  it('读盘:用户手改 project-settings.json 写了 "Read-Only" → readProjectSettings 给 readonly', async () => {
    const proj = join(home, 'proj');
    mkdirSync(proj, { recursive: true });
    writeFileSync(projectSettingsFile(), JSON.stringify({ version: 1, projects: { [realpathSync(proj)]: { approvalMode: 'Read-Only' } } }));
    expect(await readProjectSettings(proj)).toEqual({ approvalMode: 'readonly' });
  });
});

describe('③ groupChat.sanitizeTempAgents · 临时成员 approvalMode', () => {
  const temp = (approvalMode: unknown, slug = 'tmp'): any => sanitizeTempAgents([{ slug, name: 'T', systemPrompt: 'p', approvalMode }])[0];

  it('未知非空 → readonly 并告警;空 / 缺席 → \'\';已知 id 原样(含 custom,与 agentRegistry 落盘口径一致)', () => {
    expect(temp('yolo', 'tmp-yolo').approvalMode).toBe('readonly');
    expect(warned(/来源 temp agent tmp-yolo/)).toBe(true);
    expect(temp(42, 'tmp-num').approvalMode).toBe('readonly');
    expect(temp(undefined).approvalMode).toBe('');
    expect(temp('').approvalMode).toBe('');
    for (const m of ['readonly', 'auto-edit', 'full-auto', 'custom']) expect(temp(m).approvalMode).toBe(m);
  });

  it('首尾空白先剥(同 projectContext):纯空白 → \'\'、带空格的已知档原样,不告警', () => {
    expect(temp('   ', 'tmp-ws').approvalMode).toBe('');
    expect(temp(' auto-edit ', 'tmp-pad').approvalMode).toBe('auto-edit');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('真 loop:config.toml 档写错的 Agent,私聊里按 readonly 跑', () => {
  let lib: string;
  beforeEach(async () => {
    const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
    db.exec(toSqliteDDL(STANDALONE_SCHEMA));
    const fakeBrain: any = {
      llm: {
        resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
        buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
        // 还没有工具结果 → 在工作区(Agent 的 Library)里写一个文件;有了 → 收尾。后台调用不带 onToken。
        streamProviderCompletion: async (o: any) => {
          if (!o.onToken) return { content: 'bg', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' };
          if ((o.payload?.messages || []).some((m: any) => m.role === 'tool')) return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
          return {
            content: '', reasoning: '',
            toolCalls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'x' }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 10 }, finishReason: 'stop',
          };
        },
      },
      users: { getUserById: async () => ({ id: USER, username: 'u' }) },
      memory: { getMemory: async () => ({ content: '' }) },
      models: { hasDirectModel: () => false },
    };
    const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
    configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
    await runMigration();
  });

  let seq = 0;
  /** 私聊形状的会话(不带 approvalMode,同 routes/solo.ts):审批一律拒,返回收到的审批请求。 */
  async function soloRun(slug: string): Promise<any[]> {
    const sid = `S-${slug}`;
    await query(
      `INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind, projectless, agent_config) VALUES (?, ?, 'tangu', 't', 'm1', 'user', 1, ?)`,
      [sid, USER, JSON.stringify({ soloAgentSlug: slug, agentSlug: slug, execMode: 'host', cwd: lib, preset: null })],
    );
    const runId = `R-H5P-${++seq}`;
    const cfg = JSON.parse((await query<any[]>(`SELECT agent_config FROM chat_sessions WHERE id = ?`, [sid]))[0].agent_config);
    await createRun({
      id: runId, sessionId: sid, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A${seq}`,
      input: { message: 'go', userMessageId: `U${seq}`, attachments: [], agentConfig: cfg, client: 'desktop/2.11.4', origin: 'client' },
    });
    const asked: any[] = [];
    const off = subscribe(runId, (ev) => {
      if (ev.type !== 'approval_request' || asked.some((x) => x.approvalId === ev.payload.approvalId)) return;
      asked.push(ev.payload);
      resolveApproval(ev.payload.approvalId, { action: 'reject' });
    });
    enqueueRun(sid, runId);
    const t0 = Date.now();
    try {
      for (;;) {
        const r = await getRun(runId);
        if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) {
          expect(r.status).toBe('done');
          return asked;
        }
        if (Date.now() - t0 > 20_000) throw new Error(`run 未结束(status=${r?.status})`);
        await new Promise((res) => setTimeout(res, 25));
      }
    } finally {
      off();
    }
  }

  it('approval_mode = "read-only"(拼错)→ 工作区内写照问 readonly、文件没写出来(旧口径 → auto-edit 不问直接写)', async () => {
    lib = agentFolder('loop-typo', 'approval_mode = "read-only"\n');
    const asked = await soloRun('loop-typo');
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'mode', mode: 'readonly' }]);
    expect(readdirSync(lib).filter((f) => f.endsWith('.txt'))).toEqual([]);
  }, 30_000);

  it('对照:approval_mode = ""(跟随)→ host 缺省 auto-edit,工作区内写不问', async () => {
    lib = agentFolder('loop-empty', 'approval_mode = ""\n');
    expect(await soloRun('loop-empty')).toEqual([]);
    expect(readdirSync(lib).filter((f) => f.endsWith('.txt'))).toEqual(['a.txt']);
  }, 30_000);
});
