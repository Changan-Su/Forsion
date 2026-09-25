/**
 * TUI 命令 / 选择器 / 快捷键的核心逻辑:选择器过滤与光标、Shift+Tab 思考档循环、输入历史落盘、
 * 命令别名归一、run 配置(agentConfig / 会话存值 / resume / agent 激活 / 完全放行确认 / 起跑中止窗口)、
 * 插话认领与收尾抢救、/diff 采集。坏了任何一条,对应的交互就会静默跑偏。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createElement, Fragment } from 'react';
import { render } from 'ink';
import { SelectPrompt } from './components/SelectPrompt.js';
import { StatusBar } from './components/StatusBar.js';
import { InputBox } from './components/InputBox.js';
import { filterItems, initialIndex, moveIndex, scrollStart, type PickerItem } from './picker.js';
import { nextThinkingLevel, parseThinkingArg } from './thinking.js';
import { createHistoryStore, loadHistory, pushHistory, persistHistoryLine, HISTORY_LIMIT } from './history.js';
import { canonicalCommandName } from '../core/commandCatalog.js';
import { tuiCommands, matchCommands, hotkeyLines } from './commands.js';
import { reducer, initialState } from './events.js';
import { detectZh, setUiLocale } from './i18n.js';
import { approvalLabel, thinkingLabel } from './components/StatusBar.js';
import { collectGitDiff, truncateLines } from './gitDiff.js';
import {
  parseSlash, buildRunAgentConfig, runSessionPatch, resumePlan, agentActivation, needsFullAutoConfirm, fullAutoConfirmPicker,
  resolveModelArg, claimInjectedSteers, rescueSteers, launchRun, TUI_APPROVAL_KEY, type MutableConfig, type QueuedMessage,
} from './runConfig.js';
import { commandsFor } from '../core/commandCatalog.js';
import type { CatalogModel } from '../services/modelCatalog.js';

const items = (labels: string[], extra: Partial<PickerItem<string>>[] = []): PickerItem<string>[] =>
  labels.map((label, i) => ({ label, value: label, ...(extra[i] || {}) }));

describe('picker helpers', () => {
  it('filters case-insensitively on label + keywords, folding spaces/underscores like resolveModelQuery', () => {
    const list = items(['codex/gpt-5.6-luna', 'claude-opus-5', 'Kimi-K2'], [{}, { keywords: 'Claude Opus 5' }, {}]);
    expect(filterItems(list, '').length).toBe(3);
    expect(filterItems(list, 'KIMI').map((i) => i.label)).toEqual(['Kimi-K2']);
    expect(filterItems(list, 'opus 5').map((i) => i.label)).toEqual(['claude-opus-5']);
    expect(filterItems(list, 'codex_gpt').length).toBe(0); // 斜杠不折叠
    expect(filterItems(list, 'zzz')).toEqual([]);
  });

  it('hint does not participate in filtering', () => {
    const list = items(['a', 'b'], [{ hint: 'thinking high' }, {}]);
    expect(filterItems(list, 'high')).toEqual([]);
  });

  it('moves and clamps at both ends, skipping disabled items', () => {
    const list = items(['a', 'b', 'c', 'd'], [{}, { disabled: true }, {}, {}]);
    expect(moveIndex(list, 0, 1)).toBe(2); // 跳过 disabled 的 b
    expect(moveIndex(list, 2, -1)).toBe(0);
    expect(moveIndex(list, 3, 1)).toBe(3); // 到底不回绕
    expect(moveIndex(list, 0, -1)).toBe(0);
    expect(moveIndex(list, 0, 10)).toBe(3); // 翻页也钳住
    expect(moveIndex([], 0, 1)).toBe(0);
  });

  it('initial cursor: preferred value, then current, then first enabled', () => {
    const list = items(['a', 'b', 'c'], [{ disabled: true }, {}, { current: true }]);
    expect(initialIndex(list)).toBe(2);
    expect(initialIndex(list, 'b')).toBe(1);
    expect(initialIndex(list, 'a')).toBe(2); // disabled 的偏好值不认
    expect(initialIndex(items(['x', 'y'], [{ disabled: true }, {}]))).toBe(1);
  });

  it('scroll window only moves when the cursor leaves it', () => {
    expect(scrollStart(0, 5, 8, 10)).toBe(0); // 不足一页
    expect(scrollStart(0, 9, 30, 10)).toBe(0);
    expect(scrollStart(0, 10, 30, 10)).toBe(1);
    expect(scrollStart(5, 7, 30, 10)).toBe(5); // 窗口内不抖
    expect(scrollStart(5, 3, 30, 10)).toBe(3);
    expect(scrollStart(25, 29, 30, 10)).toBe(20); // 末页钳住
  });
});

describe('thinking level helpers', () => {
  it('Shift+Tab cycles only supported levels and wraps', () => {
    const sup = ['off', 'low', 'medium', 'high'] as const;
    expect(nextThinkingLevel('off', [...sup])).toBe('low');
    expect(nextThinkingLevel('medium', [...sup])).toBe('high');
    expect(nextThinkingLevel('high', [...sup])).toBe('off'); // 回绕
    expect(nextThinkingLevel('xhigh', [...sup])).toBe('off'); // 当前档不被支持:其后无更高档 → 第一档
    expect(nextThinkingLevel('minimal', [...sup])).toBe('low'); // 当前档不被支持:跳到其后第一个支持的
  });

  it('unknown capability cycles all seven levels', () => {
    expect(nextThinkingLevel('off', undefined)).toBe('minimal');
    expect(nextThinkingLevel('max', [])).toBe('off');
  });

  it('parses /think args incl. engine aliases; rejects junk instead of silently defaulting', () => {
    expect(parseThinkingArg('off')).toBe('off');
    expect(parseThinkingArg(' HIGH ')).toBe('high');
    expect(parseThinkingArg('none')).toBe('off');
    expect(parseThinkingArg('ultra')).toBe('max');
    expect(parseThinkingArg('bogus')).toBeNull();
    expect(parseThinkingArg('')).toBeNull();
  });
});

describe('input history persistence', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tangu-tui-hist-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('push: skips blank / leading-space / consecutive duplicates; caps at the limit', () => {
    let h: string[] = [];
    h = pushHistory(h, 'a');
    h = pushHistory(h, 'a');
    h = pushHistory(h, ' secret');
    h = pushHistory(h, '   ');
    h = pushHistory(h, 'b');
    h = pushHistory(h, 'a');
    expect(h).toEqual(['a', 'b', 'a']);
    let big: string[] = [];
    for (let i = 0; i < 7; i++) big = pushHistory(big, `m${i}`, 5);
    expect(big).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
    expect(HISTORY_LIMIT).toBe(500);
  });

  it('persists across stores (sessions), keeps multi-line entries intact, file is private', () => {
    const file = join(dir, 'tui_history');
    const s1 = createHistoryStore(file);
    s1.add('first');
    s1.add('line one\nline two');
    s1.add(' not saved');
    s1.add('first'); // 非连续重复:照记
    const s2 = createHistoryStore(file); // 新会话
    expect(s2.list()).toEqual(['first', 'line one\nline two', 'first']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('secret-looking lines stay in memory for this session but never hit disk', () => {
    const file = join(dir, 'tui_history_secret');
    const s = createHistoryStore(file);
    const key = 'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123';
    s.add(key);
    expect(s.list()).toContain(key);
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').not.toContain('sk-abcdef');
  });

  it('merges with lines written by another instance instead of overwriting them', () => {
    const file = join(dir, 'tui_history_merge');
    const a = createHistoryStore(file);
    persistHistoryLine('from-other-tangu', file); // 另一个进程写了一行
    a.add('mine');
    expect(loadHistory(file)).toEqual(['from-other-tangu', 'mine']);
  });

  it('tolerates hand-edited plain lines', () => {
    const file = join(dir, 'tui_history_plain');
    writeFileSync(file, 'plain line\n"json line"\n');
    expect(loadHistory(file)).toEqual(['plain line', 'json line']);
  });
});

describe('command catalog wiring', () => {
  it('aliases canonicalize to the handled command', () => {
    expect(canonicalCommandName('/permissions')).toBe('/approval');
    expect(canonicalCommandName('/effort')).toBe('/think');
    expect(canonicalCommandName('/PERMISSIONS')).toBe('/approval');
    expect(canonicalCommandName('/list')).toBe('/sessions');
    expect(canonicalCommandName('/switch')).toBe('/resume');
    expect(canonicalCommandName('/nope')).toBe('/nope');
  });

  it('every catalog command on the tui surface has a handler in app.tsx (no silent "unknown command")', () => {
    const src = readFileSync(join(__dirname, 'app.tsx'), 'utf8');
    const handled = new Set([...src.matchAll(/case '(\/[a-z-]+)'/g)].map((m) => m[1]));
    const missing = tuiCommands().map((c) => c.name).filter((n) => !handled.has(n));
    expect(missing).toEqual([]);
  });

  it('runSlash dispatches on parseSlash (aliases like /permissions reach a handled case)', () => {
    const src = readFileSync(join(__dirname, 'app.tsx'), 'utf8');
    // runSlash 若退回按原始 token switch,/permissions、/effort 会变成「未知命令」—— 钉住它走 parseSlash。
    expect(src).toMatch(/const \{ cmd, rest \} = parseSlash\(line\);/);
    const handled = new Set([...src.matchAll(/case '(\/[a-z-]+)'/g)].map((m) => m[1]));
    const aliases = commandsFor('tui').flatMap((c) => c.aliases ?? []);
    expect(aliases.length).toBeGreaterThan(0);
    for (const a of aliases) expect(handled.has(parseSlash(`${a.toUpperCase()} x`).cmd)).toBe(true);
    expect(parseSlash('/permissions full-auto')).toEqual({ cmd: '/approval', rest: 'full-auto' });
    expect(parseSlash('  /EFFORT   high ')).toEqual({ cmd: '/think', rest: 'high' });
    expect(parseSlash('/compact\nkeep the API notes')).toEqual({ cmd: '/compact', rest: 'keep the API notes' });
    expect(parseSlash('/mine arg')).toEqual({ cmd: '/mine', rest: 'arg' });
  });

  it('/help does not advertise numbered /model selection (the picker shows no numbers)', () => {
    setUiLocale('en');
    try {
      const model = tuiCommands().find((c) => c.name === '/model')!;
      expect(model.desc).toContain('/model [name|=id]');
      expect(model.desc).not.toContain('#');
    } finally {
      setUiLocale(null);
    }
  });

  it('TUI exposes the new commands and completion resolves aliases', () => {
    const names = tuiCommands().map((c) => c.name);
    for (const n of ['/model', '/think', '/approval', '/rename', '/diff', '/hotkeys', '/resume']) expect(names).toContain(n);
    expect(matchCommands('/permissions').map((c) => c.name)).toContain('/approval');
    expect(hotkeyLines().map(([k]) => k)).toEqual(expect.arrayContaining(['Shift+Tab', 'Ctrl+P', 'Enter']));
  });
});

describe('run config (runConfig.ts)', () => {
  const cfg = (over: Partial<MutableConfig> = {}): MutableConfig => ({
    model: 'm', cwd: '/w', execMode: 'host', approvalMode: 'auto-edit', thinkingLevel: 'medium', ...over,
  });

  it('agentConfig always carries thinkingLevel (incl. off) and approvalMode; group chat only with ≥2 agents', () => {
    const ac = buildRunAgentConfig(cfg({ thinkingLevel: 'off', approvalMode: 'readonly', activeAgentSlug: 'ann' }), ['a']);
    // 'off' 缺键时引擎回落 medium(agentLoop: agentConfig.thinkingLevel || 'medium')—— 必须显式下发。
    expect(ac).toMatchObject({ thinkingLevel: 'off', approvalMode: 'readonly', agentSlug: 'ann', execMode: 'host', cwd: '/w' });
    expect(ac.groupChat).toBeUndefined();
    expect(buildRunAgentConfig(cfg(), ['a', 'b'])).toMatchObject({ groupChat: true, groupAgents: ['a', 'b'] });
    expect(buildRunAgentConfig(cfg({ planMode: false }), null).planMode).toBeUndefined();
  });

  it('session write never touches the shared approvalMode key (Desktop re-reads it live at approval time)', () => {
    const p = runSessionPatch(cfg({ approvalMode: 'full-auto', thinkingLevel: 'off' }));
    expect(p).not.toHaveProperty('approvalMode');
    expect(p[TUI_APPROVAL_KEY]).toBe('full-auto');
    expect(p).toMatchObject({ thinkingLevel: 'off', maxIterations: null, planMode: null });
    expect(runSessionPatch(cfg({ maxIterations: 12, planMode: true }))).toMatchObject({ maxIterations: 12, planMode: true });
    // app.tsx 的两处会话写(起 run / 切档)都得走专属键 —— 源码里不许再出现把 approvalMode 写进会话的调用。
    const src = readFileSync(join(__dirname, 'app.tsx'), 'utf8');
    expect(src).not.toMatch(/patchSessionAgentConfig\([^)]*\{\s*approvalMode/);
  });

  it('resume: TUI key wins over the shared one; full-auto is held back unless already full-auto', () => {
    const cur = { approvalMode: 'auto-edit' as const, thinkingLevel: 'medium' as const };
    const r1 = resumePlan({ modelId: 'x', agentConfig: { [TUI_APPROVAL_KEY]: 'readonly', approvalMode: 'custom', thinkingLevel: 'none', maxIterations: 999, planMode: true, agentSlug: 'ann' } }, cur);
    expect(r1.patch).toMatchObject({ model: 'x', approvalMode: 'readonly', thinkingLevel: 'off', maxIterations: 200, planMode: true });
    expect(r1.agentSlug).toBe('ann');
    expect(r1.heldBackFullAuto).toBe(false);
    expect(resumePlan({ agentConfig: { approvalMode: 'custom' } }, cur).patch.approvalMode).toBe('custom'); // 桌面会话:参考共享档
    const held = resumePlan({ agentConfig: { [TUI_APPROVAL_KEY]: 'full-auto' } }, cur);
    expect(held.heldBackFullAuto).toBe(true);
    expect(held.patch).not.toHaveProperty('approvalMode');
    expect(resumePlan({ agentConfig: { approvalMode: 'full-auto' } }, cur).heldBackFullAuto).toBe(true);
    const kept = resumePlan({ agentConfig: { approvalMode: 'full-auto' } }, { ...cur, approvalMode: 'full-auto' });
    expect(kept).toMatchObject({ heldBackFullAuto: false, patch: { approvalMode: 'full-auto' } });
    const junk = resumePlan({ agentConfig: { approvalMode: 'yolo', thinkingLevel: 'bogus', maxIterations: -3 } }, cur);
    expect(junk.patch).not.toHaveProperty('approvalMode');
    expect(junk.patch).toMatchObject({ thinkingLevel: 'medium', maxIterations: undefined, planMode: false });
    expect(resumePlan({ agentConfig: null }, cur)).toMatchObject({ heldBackFullAuto: false, agentSlug: undefined });
  });

  it('/agent never applies the definition\'s approval mode directly; full-auto needs confirmation', () => {
    const def = { slug: 'ann', systemPrompt: 'sp', model: '', thinkingLevel: '' as const, maxIterations: null, approvalMode: 'full-auto' as const };
    const a = agentActivation(def, cfg({ maxIterations: 7 }));
    expect(a.patch).not.toHaveProperty('approvalMode');
    expect(a.patch).toMatchObject({ seedSystem: 'sp', activeAgentSlug: 'ann', model: 'm', thinkingLevel: 'medium', maxIterations: 7 });
    expect(a.approvalRequest).toBe('full-auto');
    expect(needsFullAutoConfirm('auto-edit', a.approvalRequest!)).toBe(true);
    expect(agentActivation({ ...def, approvalMode: '' as any }, cfg()).approvalRequest).toBeUndefined(); // 未设 = ''
    expect(agentActivation({ ...def, approvalMode: 'auto-edit' }, cfg()).approvalRequest).toBeUndefined(); // 与当前相同
    expect(agentActivation({ ...def, approvalMode: 'readonly', model: 'm2', thinkingLevel: 'high' }, cfg())).toMatchObject({ approvalRequest: 'readonly', patch: { model: 'm2', thinkingLevel: 'high' } });
    expect(needsFullAutoConfirm('full-auto', 'full-auto')).toBe(false);
    expect(needsFullAutoConfirm('readonly', 'custom')).toBe(false);
  });

  it('/model args: numbers are rejected, =id is the unverified escape hatch, a failed catalog fetch is reported', () => {
    const models = [{ id: 'gpt-5.2' }, { id: 'claude-opus-5' }].map((m) => ({ ...m, name: m.id, provider: 'p' })) as unknown as CatalogModel[];
    expect(resolveModelArg('2', models, null)).toEqual({ kind: 'numeric' }); // 恰好只有一个 id 含「2」也不许当子串切过去
    expect(resolveModelArg('=my/raw-id', models, null)).toEqual({ kind: 'unverified', id: 'my/raw-id' });
    expect(resolveModelArg('=', models, null)).toEqual({ kind: 'usage' });
    expect(resolveModelArg('whatever', [], 'offline')).toEqual({ kind: 'unverified', id: 'whatever' });
    expect(resolveModelArg('opus', models, null)).toMatchObject({ kind: 'hit', model: { id: 'claude-opus-5' } });
    expect(resolveModelArg('gemini-3', models, 'HTTP 503')).toEqual({ kind: 'none', catalogError: 'HTTP 503' });
    expect(resolveModelArg('gemini-3', models, null)).toEqual({ kind: 'none', catalogError: null });
  });

  it('steer bookkeeping: injected steers show the typed text; missed ones jump ahead of queued follow-ups', () => {
    const q = (id: string): QueuedMessage => ({ id, display: `typed ${id}`, message: `expanded ${id}` });
    const { texts, remaining } = claimInjectedSteers([q('a'), q('b')], [{ id: 'b', content: 'expanded b' }, { id: 'hook', content: 'from a stop hook' }]);
    expect(texts).toEqual(['typed b', 'from a stop hook']);
    expect(remaining.map((m) => m.id)).toEqual(['a']);
    const cancelled: string[] = [];
    const r = rescueSteers([q('s1'), q('s2')], [q('f1')], (id) => (cancelled.push(id), id === 's2')); // s1 已被引擎消费
    expect(cancelled).toEqual(['s1', 's2']);
    expect(r.rescued).toBe(1);
    expect(r.followUps.map((m) => m.id)).toEqual(['s2', 'f1']);
  });

  it('launchRun: Esc before the run exists skips it; Esc during createRun aborts right after enqueue', async () => {
    const log: string[] = [];
    let abort = false;
    const steps = (flipDuring?: 'persist' | 'create') => ({
      persist: async () => { log.push('persist'); if (flipDuring === 'persist') abort = true; },
      create: async () => { log.push('create'); if (flipDuring === 'create') abort = true; },
      enqueue: () => log.push('enqueue'),
      abort: () => log.push('abort'),
      abortRequested: () => abort,
    });
    expect(await launchRun(steps())).toBe('started');
    expect(log).toEqual(['persist', 'create', 'enqueue']);
    log.length = 0;
    expect(await launchRun(steps('persist'))).toBe('aborted');
    expect(log).toEqual(['persist']); // 没建 run 行,也没入队
    log.length = 0;
    abort = false;
    expect(await launchRun(steps('create'))).toBe('started');
    expect(log).toEqual(['persist', 'create', 'enqueue', 'abort']); // 入队同步注册了 AbortController,这次 abort 抓得到
  });
});

describe('status labels + i18n', () => {
  afterAll(() => setUiLocale(null));

  it('detects zh from env first, then Intl; C/POSIX count as unset', () => {
    expect(detectZh({ LANG: 'zh_CN.UTF-8' }, 'en-US')).toBe(true);
    expect(detectZh({ LANG: 'en_US.UTF-8' }, 'zh-CN')).toBe(false);
    expect(detectZh({ LC_ALL: 'C' }, 'zh-Hans-CN')).toBe(true);
    expect(detectZh({ TANGU_LANG: 'en', LANG: 'zh_CN.UTF-8' }, 'zh-CN')).toBe(false);
    expect(detectZh({}, 'en-GB')).toBe(false);
  });

  it('approval labels come from APPROVAL_MODE_META (custom is no longer shown as auto-edit)', () => {
    setUiLocale('zh');
    expect(approvalLabel('custom')).toBe('自定义');
    expect(approvalLabel('full-auto')).toBe('完全放行');
    setUiLocale('en');
    expect(approvalLabel('readonly')).toBe('Ask for approval');
    expect(approvalLabel('weird')).toBe('weird');
  });

  it('thinking label shows requested→effective only when they differ', () => {
    expect(thinkingLabel('max', 'high')).toBe('max→high');
    expect(thinkingLabel('high', 'high')).toBe('high');
    expect(thinkingLabel('off')).toBe('off');
  });
});

describe('reducer TURN_BOUNDARY (steer lands in order)', () => {
  it('seals the partial assistant bubble, then appends the steer as a user bubble and keeps streaming', () => {
    let s = reducer(initialState, { type: 'START_LIVE' });
    s = reducer(s, { type: 'APPEND_TEXT', delta: 'working on it' });
    s = reducer(s, { type: 'TURN_BOUNDARY', userTexts: ['also check the tests'] });
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'user']);
    expect(s.items[1]).toMatchObject({ kind: 'user', text: 'also check the tests' });
    expect(s.live).toEqual([]);
    expect(s.busy).toBe(true);
    s = reducer(s, { type: 'APPEND_TEXT', delta: 'done' });
    s = reducer(s, { type: 'DONE' });
    expect(s.items.map((i) => i.kind)).toEqual(['assistant', 'user', 'assistant']);
  });

  it('ADD_NOTICE keeps the diff variant', () => {
    const s = reducer(initialState, { type: 'ADD_NOTICE', text: '+a', variant: 'diff' });
    expect(s.items[0]).toMatchObject({ kind: 'notice', variant: 'diff' });
  });
});

describe('/diff collection', () => {
  const hasGit = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it('truncateLines keeps the head and counts the rest', () => {
    expect(truncateLines('a\nb\nc\n', 2)).toEqual({ text: 'a\nb', dropped: 1 });
    expect(truncateLines('a\nb', 5)).toEqual({ text: 'a\nb', dropped: 0 });
  });

  it.skipIf(!hasGit)('reports not_repo / clean / tracked + untracked changes', async () => {
    setUiLocale('en');
    const root = mkdtempSync(join(tmpdir(), 'tangu-tui-diff-'));
    try {
      const plain = join(root, 'plain');
      const repo = join(root, 'repo');
      execFileSync('mkdir', ['-p', plain, repo]);
      expect((await collectGitDiff(plain)).kind).toBe('not_repo');
      const g = (...args: string[]): void => {
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
      };
      g('init', '-q');
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      g('add', 'a.txt');
      g('commit', '-q', '-m', 'init');
      expect((await collectGitDiff(repo)).kind).toBe('clean');
      writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
      writeFileSync(join(repo, 'new.txt'), 'brand new\n');
      const r = await collectGitDiff(repo);
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') return;
      expect(r.text).toContain(' M a.txt');
      expect(r.text).toContain('?? new.txt');
      expect(r.text).toContain('+two');
      expect(r.text).toContain('+brand new'); // 未跟踪文件的内容也在
      const capped = await collectGitDiff(repo, 3);
      expect(capped.kind === 'ok' && capped.text).toMatch(/more lines not shown/);
      // 从子目录跑:仓根的未跟踪文件同样要展开内容(ls-files 只列 cwd 以下,曾经只在 status 里露个名字)。
      execFileSync('mkdir', ['-p', join(repo, 'sub')]);
      writeFileSync(join(repo, 'sub', 'inner.txt'), 'inner\n');
      const fromSub = await collectGitDiff(join(repo, 'sub'));
      expect(fromSub.kind).toBe('ok');
      if (fromSub.kind !== 'ok') return;
      expect(fromSub.text).toContain('+brand new');
      expect(fromSub.text).toContain('+inner');
      expect(fromSub.text).toContain('+two');
    } finally {
      rmSync(root, { recursive: true, force: true });
      setUiLocale(null);
    }
  });

  it('tells "git missing" apart from "cwd deleted" (both surface as spawn ENOENT)', async () => {
    const gone = join(tmpdir(), `tangu-tui-gone-${process.pid}-${Date.now()}`);
    expect((await collectGitDiff(gone)).kind).toBe('no_cwd');
    const prevPath = process.env.PATH;
    process.env.PATH = join(tmpdir(), 'tangu-no-such-bin-dir');
    try {
      expect((await collectGitDiff(tmpdir())).kind).toBe('no_git');
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe('Ink wiring (real key sequences through a fake TTY)', () => {
  let home: string;
  const prevHome = process.env.TANGU_HOME;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'tangu-tui-home-'));
    process.env.TANGU_HOME = home; // InputBox 的历史单例懒加载:别写进开发者真实的 ~/.tangu
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.TANGU_HOME;
    else process.env.TANGU_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    setUiLocale(null);
  });

  const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const tty = () => {
    const stdin: any = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const stdout: any = Object.assign(new PassThrough(), { columns: 100, rows: 40 });
    // debug 模式下 Ink 每次渲染整帧写一次 → 一次 data = 一帧。
    const frames: string[] = [];
    stdout.on('data', (d: Buffer) => frames.push(d.toString()));
    return { stdin, stdout, frames, text: () => strip(frames.join('')), last: () => strip(frames[frames.length - 1] ?? '') };
  };
  /** 等条件成立;超时即失败(旧版超时静默往下走,断言才报一个莫名的值)。 */
  const until = async (ok: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!ok()) throw new Error(`timed out waiting for: ${what}`);
  };
  /**
   * 按一个键并等它**被处理完**(条件成立)再返回。不能按固定时长睡:CI 慢时两次 write 会并成一个 chunk,
   * Ink 把整块当一次按键解析(`\x1b[B\x0e` = 一个认不出的键),光标就少走一步。
   */
  const press = async (io: ReturnType<typeof tty>, seq: string, done: () => boolean, what: string): Promise<void> => {
    io.stdin.write(seq);
    await until(done, what);
  };
  const cursorOn = (io: ReturnType<typeof tty>, label: string) => (): boolean => new RegExp(`› +(✓ )?${label}\\b`).test(io.last());

  it('SelectPrompt: ↓ / Ctrl+N move, typing filters, Enter selects, Esc cancels', async () => {
    setUiLocale('en');
    const io = tty();
    const picked: string[] = [];
    let cancelled = false;
    const list = Array.from({ length: 15 }, (_, i) => ({ label: `model-${i}`, value: `m${i}`, current: i === 2 }));
    const app = render(
      createElement(SelectPrompt<string>, { title: 'Pick', items: list, onSelect: (v) => picked.push(v), onCancel: () => (cancelled = true) }),
      { stdin: io.stdin, stdout: io.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    try {
      await until(cursorOn(io, 'model-2'), 'initial cursor on the current item');
      expect(io.last()).toContain('more below'); // 15 项只露 10 行
      await press(io, '\x1b[B', cursorOn(io, 'model-3'), '↓ moves to model-3'); // ↓
      await press(io, '\x0e', cursorOn(io, 'model-4'), 'Ctrl+N moves to model-4'); // Ctrl+N
      await press(io, '\r', () => picked.length === 1, 'Enter selects');
      expect(picked).toEqual(['m4']); // 从当前项(2)起下移两格
      await press(io, '14', () => /Filter › 14/.test(io.last()) && cursorOn(io, 'model-14')(), 'typing filters to model-14');
      await press(io, '\r', () => picked.length === 2, 'Enter selects the filtered item');
      expect(picked[1]).toBe('m14');
      await press(io, '\x1b', () => cancelled, 'Esc cancels');
    } finally {
      app.unmount();
    }
  });

  it('InputBox: Shift+Tab cycles thinking (not Tab-completion), Ctrl+P opens the model picker; StatusBar shows labels', async () => {
    setUiLocale('zh');
    const io = tty();
    let cycles = 0;
    let pickers = 0;
    const sent: string[] = [];
    const app = render(
      createElement(
        Fragment,
        null,
        createElement(StatusBar, { model: 'm', cwd: '/tmp', execMode: 'host', approvalMode: 'custom', status: { state: 'idle', iteration: 0 }, tokens: 1, busy: false, thinking: 'max→high', planMode: true, agentSlug: 'xyra' }),
        createElement(InputBox, { busy: false, cwd: '/tmp', onSubmit: (t: string) => sent.push(t), onAbort: () => {}, onExit: () => {}, onCycleThinking: () => cycles++, onOpenModelPicker: () => pickers++ }),
      ),
      { stdin: io.stdin, stdout: io.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    try {
      await until(() => io.text().includes('自定义'), 'status bar rendered');
      expect(io.text()).toContain('max→high');
      expect(io.text()).toContain('@xyra');
      await press(io, '\x1b[Z', () => cycles === 1, 'Shift+Tab cycles thinking'); // Shift+Tab
      await press(io, '\x10', () => pickers === 1, 'Ctrl+P opens the model picker'); // Ctrl+P
      await press(io, 'hi', () => /› hi/.test(io.last()), 'typed text shows up in the input line'); // 别只查 'hi':状态栏的 max→high 就含它
      await press(io, '\r', () => sent.length === 1, 'Enter submits');
      expect(cycles).toBe(1);
      expect(pickers).toBe(1);
      expect(sent).toEqual(['hi']);
      expect(loadHistory(join(home, 'tui_history'))).toEqual(['hi']); // 历史落在 TANGU_HOME
    } finally {
      app.unmount();
    }
  });

  it('SelectPrompt: keys that land before the next render are not lost (handler reads live state)', async () => {
    // objectMode stdin:同一 tick 推两块 → Ink 的 readable 循环连着 read 两次、中间不重渲染 ——
    // 正是快速连打 / 按住 ↓ 时发生的事。旧实现读闭包里的旧 cursor / query:光标少走一步、过滤丢字。
    setUiLocale('en');
    const stdin: any = Object.assign(new Readable({ objectMode: true, read() {} }), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
    const out = tty();
    const picked: string[] = [];
    const list = Array.from({ length: 30 }, (_, i) => ({ label: `model-${i}`, value: `m${i}` }));
    const app = render(
      createElement(SelectPrompt<string>, { title: 'Pick', items: list, onSelect: (v) => picked.push(v), onCancel: () => {} }),
      { stdin, stdout: out.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    try {
      await until(cursorOn(out, 'model-0'), 'initial render');
      await new Promise((r) => setTimeout(r, 20)); // 让 useInput 挂上监听
      stdin.push('\x1b[B');
      stdin.push('\x0e');
      await until(cursorOn(out, 'model-2'), 'both moves applied');
      stdin.push('2');
      stdin.push('5');
      await until(() => /Filter › 25/.test(out.last()), 'both typed characters kept');
      stdin.push('\r');
      await until(() => picked.length === 1, 'Enter selects');
      expect(picked).toEqual(['m25']);
    } finally {
      app.unmount();
    }
  });

  it('"Enable full access?" defaults to Cancel: a reflexive Enter does not grant it', async () => {
    setUiLocale('en');
    const io = tty();
    const picked: string[] = [];
    const conf = fullAutoConfirmPicker();
    const app = render(
      createElement(SelectPrompt<string>, { ...conf, onSelect: (v) => picked.push(v), onCancel: () => {} }),
      { stdin: io.stdin, stdout: io.stdout, debug: true, exitOnCtrlC: false, patchConsole: false },
    );
    try {
      await until(cursorOn(io, 'Cancel'), 'cursor starts on Cancel');
      await press(io, '\r', () => picked.length === 1, 'Enter selects');
      expect(picked).toEqual(['cancel']);
      await press(io, '\x1b[B', cursorOn(io, 'Yes'), '↓ moves to Yes');
      await press(io, '\r', () => picked.length === 2, 'Enter selects Yes');
      expect(picked[1]).toBe('yes');
    } finally {
      app.unmount();
    }
  });
});
