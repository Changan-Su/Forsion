/**
 * 后台调用的输出上限要给思考另留余量(llm/openaiCompat.ts 的 thinkingHeadroom)。
 * 托管 Claude 5 行在服务端是 reasoning_mode=prefix:请求里不发 thinking 字段,模型照样自己想,
 * 想的 token 也算在 max_tokens 里。只按正文给上限 → 思考吃光 → 上游 stop_reason=max_tokens 且零正文 →
 * 服务端 422「Upstream output limit reached before any reply was produced」(11-15 反馈:项目记忆整理 12,288 被吃光)。
 * 这里钉住两条后台整理调用(记忆整理 / 项目记忆写满压缩)实际发出的 maxTokens。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./specialAgentsConfig.js', async (orig) => ({
  ...(await orig<typeof import('./specialAgentsConfig.js')>()),
  loadSpecialAgentsConfig: () => ({ historian: { modelId: 'bg-model' } }),
  resolveBackgroundModelId: async (id: string) => id,
}));
vi.mock('./projectMemory.js', async (orig) => ({
  ...(await orig<typeof import('./projectMemory.js')>()),
  openProjectMemory: async () => ({
    snapshot: () => ({
      entries: [
        { id: 'e1', content: '- Build with npm run build in the engine folder', createdAt: 1, updatedAt: 1, source: { kind: 'auto' }, evidenceIds: [] },
        { id: 'e2', content: '- Tests live next to the source files', createdAt: 1, updatedAt: 1, source: { kind: 'auto' }, evidenceIds: [] },
      ],
      tombstones: [],
    }),
  }),
}));

import { configureTangu } from '../seams/runtime.js';
import { createTanguProfile } from '../profiles/index.js';
import { proposeOrganize, ORGANIZE_CALL_DEADLINE_MS } from './memoryOrganize.js';
import { compactProjectMemory, resetProjectMemoryCompactionForTests, ORGANIZE_DEADLINE_MS } from './projectMemoryCompact.js';
import { CLAUDE_THINKING_HEADROOM } from '../llm/openaiCompat.js';
import { PROTOCOL_MARK } from '../llm/openaiCompat.js';
import { CLAUDE_MAX_TOKENS_CEILING } from '../llm/modelCapabilities.js';

/** 生产里的托管 Claude 行(/api/brain/llm/resolve 回的形状):provider=anthropic、defaultBaseUrl 空、baseUrl 是网关占位。 */
const HOSTED_CLAUDE = { model: { id: 'pr-claude', name: 'Claude Opus 5.5', provider: 'anthropic', defaultBaseUrl: null }, apiKey: '__cloud_proxy__', baseUrl: 'https://api.example.test', apiModelId: 'claude-opus-5-5' };
/** 中转形态:provider 不是 anthropic、端点也认不出,只有模型 id 看得出是 Claude 5。 */
const RELAY_CLAUDE = { model: { id: 'relay', name: 'relay', provider: 'external' }, apiKey: 'k', baseUrl: 'https://relay.example.test/v1', apiModelId: 'claude-sonnet-5-5' };
const CODEX = { model: { id: 'codex', name: 'codex', provider: 'codex', [PROTOCOL_MARK]: 'openai-responses' }, apiKey: 'k', baseUrl: 'https://chatgpt.com/backend-api/codex', apiModelId: 'gpt-6-luna' };

/** 两个调用点都写死的正文上限(services/memoryOrganize.ts / projectMemoryCompact.ts 的 MAX_OUTPUT_TOKENS)。 */
const BODY = 12_288;

let sent: any[];
let resolved: any;

beforeEach(() => {
  sent = [];
  resolved = HOSTED_CLAUDE;
  resetProjectMemoryCompactionForTests();
  const brain: any = {
    llm: {
      resolveModelAndKey: async () => resolved,
      buildProviderPayload: async (o: any) => { sent.push(o); return {}; },
      // 截断 = 两处都按「没成」返回,不往下写盘
      streamProviderCompletion: async () => ({ content: '', finishReason: 'length', usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    },
    users: { getUserById: async () => ({ id: 'u1', username: 'u' }) },
  };
  const billing: any = { calculateCost: async () => 0, logApiUsage: async () => {}, consumeTokenPoints: async () => ({ ok: true }) };
  configureTangu({ host: { log: () => {} }, brain, billing, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
});

const organize = () => proposeOrganize('u1', 'project', {}, [], []);
const compact = () => compactProjectMemory('u1', { dir: '/nonexistent/project-memory-test', name: 'p', project: 'p' } as any);

describe('后台整理调用的输出上限含思考余量', () => {
  it('托管 Claude 5:记忆整理 = 正文 + Claude 余量', async () => {
    await organize();
    expect(sent).toHaveLength(1);
    expect(sent[0].maxTokens).toBe(BODY + CLAUDE_THINKING_HEADROOM);
  });

  it('托管 Claude 5:项目记忆写满压缩 = 正文 + Claude 余量', async () => {
    const out = await compact();
    expect(out).toMatchObject({ status: 'skipped', reason: 'rejected' });
    expect(sent).toHaveLength(1);
    expect(sent[0].maxTokens).toBe(BODY + CLAUDE_THINKING_HEADROOM);
  });

  it('中转上的 Claude 5(端点 / provider 都认不出)也留', async () => {
    resolved = RELAY_CLAUDE;
    await organize();
    expect(sent[0].maxTokens).toBe(BODY + CLAUDE_THINKING_HEADROOM);
  });

  it('原生思考的非 Claude 端点照旧 + 4096', async () => {
    resolved = CODEX;
    await organize();
    await compact();
    expect(sent.map((o) => o.maxTokens)).toEqual([BODY + 4096, BODY + 4096]);
  });

  it('加上余量也不超过 Claude 都吃得下的 32000(服务端缺省同值)', () => {
    expect(BODY + CLAUDE_THINKING_HEADROOM).toBeLessThanOrEqual(CLAUDE_MAX_TOKENS_CEILING);
  });

  // 截止不能比输出上限先撞墙:托管 Claude 5 的上限按约 100 tok/s(每 token 10ms)写得完。原来 90 / 60 秒连 12,288 都要 137 / 205 tok/s。
  it('一次整理调用的截止够把整份上限按 100 tok/s 写完', () => {
    expect(ORGANIZE_CALL_DEADLINE_MS).toBeGreaterThanOrEqual((BODY + CLAUDE_THINKING_HEADROOM) * 10);
  });
  it('项目记忆整理一整次(分堆 + 压缩)的外层截止装得下两次满额调用', () => {
    expect(ORGANIZE_DEADLINE_MS).toBeGreaterThanOrEqual(ORGANIZE_CALL_DEADLINE_MS + (BODY + CLAUDE_THINKING_HEADROOM) * 10);
  });
});
