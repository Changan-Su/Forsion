/** harnessStore 回归:往返/手改容忍/封顶/回滚。独立 TANGU_HOME 免污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let home: string;
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-harness-'));
  process.env.TANGU_HOME = home;
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.TANGU_HOME;
});

const SLUG = 'testbot';

describe('parse/serialize 往返', () => {
  it('空文件/缺文件 → 空列表', async () => {
    const { loadHarness, parseHarness } = await import('./harnessStore.js');
    expect(await loadHarness('nobody')).toEqual([]);
    expect(parseHarness('')).toEqual([]);
    expect(parseHarness('# Working Notes\n随便什么前言')).toEqual([]);
  });

  it('序列化 → 解析恢复全部字段(含未知 kind / 未知 meta 行)', async () => {
    const { parseHarness, serializeHarness } = await import('./harnessStore.js');
    const src = [
      '# Working Notes',
      '',
      '## [h-ab12] 评审先跑测试 (note)',
      '- evidence: 08-11/13 两次被纠正',
      '- created: 2026-08-11',
      '- updated: 2026-08-13 v2',
      '- priority: high', // 手改加的未知 meta,须保留
      '',
      '评审前先跑一遍相关测试。',
      '',
      '## [h-cd34] 长翻译拆两个分身 (recipe)',
      '- updated: 2026-08-12',
      '',
      '按章节拆给两个 delegate 并行。',
      '',
      '## [h-ef56] 未来类型 (hologram)', // 未知 kind:保留不丢
      '- updated: 2026-08-12',
      '',
      '正文。',
    ].join('\n');
    const entries = parseHarness(src);
    expect(entries.map((e) => e.id)).toEqual(['h-ab12', 'h-cd34', 'h-ef56']);
    expect(entries[0]).toMatchObject({ kind: 'note', title: '评审先跑测试', version: 2, createdAt: '2026-08-11', updatedAt: '2026-08-13', evidence: '08-11/13 两次被纠正' });
    expect(entries[0].extraMeta).toEqual(['- priority: high']);
    expect(entries[0].body).toBe('评审前先跑一遍相关测试。');
    expect(entries[2].kind).toBe('hologram');
    // 再序列化再解析,字段不漂移
    const round = parseHarness(serializeHarness(entries));
    expect(round).toEqual(entries);
  });

  it('标题含括号但结尾不是 kind 形状 → 不误吞', async () => {
    const { parseHarness } = await import('./harnessStore.js');
    const entries = parseHarness('## [h-xy] 用 grep -a (二进制哨兵) 找 NUL\n- updated: 2026-08-12\n\n正文');
    // 结尾括号组是 ASCII kind 形状才剥;中文括号内容不匹配 → 整串归 title
    expect(entries[0].title).toBe('用 grep -a (二进制哨兵) 找 NUL');
    expect(entries[0].kind).toBe('note');
  });
});

describe('applyHarnessEdit', () => {
  it('create 需要 evidence;成功后落盘 + journal', async () => {
    const { applyHarnessEdit, loadHarness, readJournal } = await import('./harnessStore.js');
    await expect(applyHarnessEdit(SLUG, { action: 'upsert', title: 'T', body: 'B' })).rejects.toThrow(/evidence/);
    const { entry } = await applyHarnessEdit(SLUG, { action: 'upsert', title: '先跑测试', body: '评审前先跑测试。', evidence: '今天被纠正' });
    expect(entry!.id).toMatch(/^h-[a-z0-9]{4}$/);
    expect(entry!.version).toBe(1);
    const onDisk = await loadHarness(SLUG);
    expect(onDisk).toHaveLength(1);
    const j = await readJournal(SLUG);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ action: 'upsert', entryId: entry!.id, before: null });
  });

  it('update 升 version;delete 移除;超长拒绝', async () => {
    const { applyHarnessEdit, loadHarness, BODY_MAX } = await import('./harnessStore.js');
    const [first] = await loadHarness(SLUG);
    const { entry } = await applyHarnessEdit(SLUG, { action: 'upsert', id: first.id, body: '评审前必须先跑测试再看 diff。' });
    expect(entry!.version).toBe(2);
    await expect(
      applyHarnessEdit(SLUG, { action: 'upsert', id: first.id, body: 'x'.repeat(BODY_MAX + 1) }),
    ).rejects.toThrow(/超长/);
    await applyHarnessEdit(SLUG, { action: 'delete', id: first.id });
    expect(await loadHarness(SLUG)).toHaveLength(0);
  });

  it('rollback 恢复上一版(update 后回滚回旧正文;create 后回滚=删除)', async () => {
    const { applyHarnessEdit, loadHarness } = await import('./harnessStore.js');
    const { entry } = await applyHarnessEdit(SLUG, { action: 'upsert', title: '条目A', body: '版本一', evidence: 'e' });
    const id = entry!.id;
    await applyHarnessEdit(SLUG, { action: 'upsert', id, body: '版本二' });
    await applyHarnessEdit(SLUG, { action: 'rollback', id });
    let cur = (await loadHarness(SLUG)).find((e) => e.id === id);
    expect(cur!.body).toBe('版本一');
    // create 型回滚:回滚掉 create 本身 → 条目消失
    const { entry: e2 } = await applyHarnessEdit(SLUG, { action: 'upsert', title: '条目B', body: 'b', evidence: 'e' });
    await applyHarnessEdit(SLUG, { action: 'rollback', id: e2!.id });
    expect((await loadHarness(SLUG)).find((e) => e.id === e2!.id)).toBeUndefined();
  });

  it('30 条封顶:满了拒新建,提示先淘汰', async () => {
    const { applyHarnessEdit, loadHarness, MAX_ENTRIES } = await import('./harnessStore.js');
    const slug = 'capbot';
    for (let i = 0; i < MAX_ENTRIES; i++) {
      await applyHarnessEdit(slug, { action: 'upsert', title: `条 ${i}`, body: '正文', evidence: 'e' });
    }
    expect(await loadHarness(slug)).toHaveLength(MAX_ENTRIES);
    await expect(applyHarnessEdit(slug, { action: 'upsert', title: '溢出', body: 'b', evidence: 'e' })).rejects.toThrow(/已满/);
  });

  it('写入自动脱敏', async () => {
    const { applyHarnessEdit } = await import('./harnessStore.js');
    const { entry } = await applyHarnessEdit(SLUG, {
      action: 'upsert', title: '密钥形状', evidence: 'e',
      body: '别再用 sk-abcdefghijklmnop1234 这个 key',
    });
    expect(entry!.body).toContain('[REDACTED]');
    expect(entry!.body).not.toContain('sk-abcdefghijklmnop1234');
  });
});

describe('Codex 评审修复回归', () => {
  it('title/evidence 换行被折叠成单行(不能伪造条目抬头)', async () => {
    const { applyHarnessEdit, loadHarness } = await import('./harnessStore.js');
    const slug = 'inject1';
    const { entry } = await applyHarnessEdit(slug, {
      action: 'upsert', title: 'Good\n## [h-evil] Extra (note)', body: 'b', evidence: 'e\n## [h-ev2] X',
    });
    expect(entry!.title).toBe('Good ## [h-evil] Extra (note)');
    expect(await loadHarness(slug)).toHaveLength(1); // 重新解析仍是一条
  });

  it('body 含条目抬头形状的行 → 拒绝', async () => {
    const { applyHarnessEdit } = await import('./harnessStore.js');
    await expect(
      applyHarnessEdit('inject2', { action: 'upsert', title: 'T', body: '第一行\n## [h-fake] 伪条目 (note)\n尾行', evidence: 'e' }),
    ).rejects.toThrow(/不能包含/);
  });

  it('CRLF 输入归一为 LF;meta 空行后的 "- key:" 行属正文非 extraMeta', async () => {
    const { parseHarness } = await import('./harnessStore.js');
    const src = '## [h-crlf] 条 (note)\r\n- updated: 2026-08-13\r\n\r\n- step: run tests\r\n- step: read diff\r\n';
    const [e] = parseHarness(src);
    expect(e.body).toBe('- step: run tests\n- step: read diff');
    expect(e.extraMeta).toBeUndefined();
    expect(e.body).not.toContain('\r');
  });

  it('rollback 撤销 delete 会超上限时拒绝', async () => {
    const { applyHarnessEdit, MAX_ENTRIES } = await import('./harnessStore.js');
    const slug = 'caproll';
    const ids: string[] = [];
    for (let i = 0; i < MAX_ENTRIES; i++) {
      const { entry } = await applyHarnessEdit(slug, { action: 'upsert', title: `条 ${i}`, body: 'b', evidence: 'e' });
      ids.push(entry!.id);
    }
    await applyHarnessEdit(slug, { action: 'delete', id: ids[0] }); // 29 条
    await applyHarnessEdit(slug, { action: 'upsert', title: '新', body: 'b', evidence: 'e' }); // 又满 30
    await expect(applyHarnessEdit(slug, { action: 'rollback', id: ids[0] })).rejects.toThrow(/上限/);
  });

  it('HARNESS.md 读失败(非 ENOENT)→ 抛错而非当空覆盖', async () => {
    const { applyHarnessEdit, loadHarness, harnessPath } = await import('./harnessStore.js');
    const slug = 'iofail';
    await fs.mkdir(path.dirname(harnessPath(slug)), { recursive: true });
    await fs.mkdir(harnessPath(slug)); // HARNESS.md 是个目录 → EISDIR
    await expect(loadHarness(slug)).rejects.toThrow();
    await expect(applyHarnessEdit(slug, { action: 'upsert', title: 'T', body: 'b', evidence: 'e' })).rejects.toThrow();
  });

  it('并发 upsert 串行化:两个同时 create 都存活', async () => {
    const { applyHarnessEdit, loadHarness } = await import('./harnessStore.js');
    const slug = 'race1';
    await Promise.all([
      applyHarnessEdit(slug, { action: 'upsert', title: 'A', body: 'a', evidence: 'e' }),
      applyHarnessEdit(slug, { action: 'upsert', title: 'B', body: 'b', evidence: 'e' }),
    ]);
    expect((await loadHarness(slug)).map((e) => e.title).sort()).toEqual(['A', 'B']);
  });
});

describe('候选收件箱(.harness-raw.md)', () => {
  it('追加→消费→再消费为空;append 与现有行正文去重', async () => {
    const { appendHarnessCandidates, consumeHarnessCandidates } = await import('./harnessStore.js');
    const slug = 'inboxbot';
    expect(await appendHarnessCandidates(slug, 'sess-0001', ['先跑测试', '拆分身并行'])).toBe(2);
    expect(await appendHarnessCandidates(slug, 'sess-0002', ['先跑测试', '新教训'])).toBe(1); // 重复正文不再追加
    const lines = await consumeHarnessCandidates(slug);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- \[\d{4}-\d{2}-\d{2} s:sess-000\] 先跑测试$/);
    expect(await consumeHarnessCandidates(slug)).toEqual([]); // 注入=消费
    expect(await appendHarnessCandidates(slug, 'sess-0003', ['先跑测试'])).toBe(1); // 消费后同文可再进
  });

  it('边界自守:正文换行压平、批内去重、会话标签只留安全字符(防注入多占行数配额)', async () => {
    const { appendHarnessCandidates, consumeHarnessCandidates } = await import('./harnessStore.js');
    const slug = 'inboxguard';
    expect(await appendHarnessCandidates(slug, ']\n## [a]', ['A\nB', 'A B'])).toBe(1); // 压平后批内重复
    const lines = await consumeHarnessCandidates(slug);
    expect(lines).toHaveLength(1); // 物理上也只有一行
    expect(lines[0]).toMatch(/^- \[\d{4}-\d{2}-\d{2} s:a\] A B$/); // 标签剩安全字符,正文单行
  });

  it('收件箱封顶:超出按尾部保留(旧候选淘汰)', async () => {
    const { appendHarnessCandidates, consumeHarnessCandidates } = await import('./harnessStore.js');
    const slug = 'inboxcap';
    for (let i = 0; i < 45; i++) await appendHarnessCandidates(slug, 's', [`候选 ${i}`]);
    const lines = await consumeHarnessCandidates(slug);
    expect(lines).toHaveLength(40);
    expect(lines[0]).toContain('候选 5'); // 头 5 条被淘汰
    expect(lines[39]).toContain('候选 44');
  });

  it('renderPendingHarnessCandidates:空清单空串;非空带 triage 指令+原样行', async () => {
    const { renderPendingHarnessCandidates } = await import('./harnessStore.js');
    expect(renderPendingHarnessCandidates([])).toBe('');
    const s = renderPendingHarnessCandidates(['- [2026-08-13 s:abc] 先跑测试']);
    expect(s).toContain('[Auto-collected candidates]');
    expect(s).toContain('manage_harness');
    expect(s).toContain('- [2026-08-13 s:abc] 先跑测试');
  });
});

describe('isRefineInvocation', () => {
  it('前缀命中;refineXX 不误吞;历史/普通消息不触发', async () => {
    const { isRefineInvocation } = await import('./harnessStore.js');
    expect(isRefineInvocation('/refine')).toBe(true);
    expect(isRefineInvocation('/refine 重点看部署那段')).toBe(true);
    expect(isRefineInvocation('  /refine')).toBe(true); // 前导空白容忍
    expect(isRefineInvocation('/refinery plans')).toBe(false);
    expect(isRefineInvocation('聊聊 /refine 是什么')).toBe(false);
    expect(isRefineInvocation('')).toBe(false);
  });
});

describe('renderHarnessSection', () => {
  it('空 → 空串;note/recipe 分组;正文换行压平', async () => {
    const { renderHarnessSection } = await import('./harnessStore.js');
    expect(renderHarnessSection([])).toBe('');
    const s = renderHarnessSection([
      { id: 'h-1a2b', kind: 'note', title: 'N', body: '两\n行', evidence: 'ev', createdAt: '', updatedAt: '', version: 1 },
      { id: 'h-3c4d', kind: 'recipe', title: 'R', body: 'r', createdAt: '', updatedAt: '', version: 1 },
    ]);
    expect(s).toContain('## My Working Notes');
    expect(s).toContain('- [h-1a2b] N — 两 行 (evidence: ev)');
    expect(s).toContain('Delegation recipes');
    expect(s).toContain('- [h-3c4d] R — r');
  });
});
