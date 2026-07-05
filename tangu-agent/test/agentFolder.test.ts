/**
 * 文件夹化 Agent + 每-Agent 记忆 + 迁移。用 TANGU_HOME 重定向到临时目录;
 * 迁移函数自带文件系统幂等闸门(不依赖模块级 readyChecked),故每个用例独立。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgentConfig, serializeAgentConfig, parseAgentFolder,
  migrateFlatToFolder, migrateGlobalMemoryToXyra, type NormalAgentDef,
  sanitizeLibraryName, writeLibraryFile, readLibraryFile, listLibraryFiles, deleteLibraryFile,
} from '../src/agents/agentRegistry.js';
import { enterRunContext } from '../src/seams/runContext.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-home-'));
  process.env.TANGU_HOME = home;
});
afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('config.toml ↔ NormalAgentDef round-trip', () => {
  it('maps codex-style keys + multiline developer_instructions + separate SOUL', () => {
    const def: NormalAgentDef = {
      slug: 'r', name: 'Round', description: 'd', model: 'm', tools: ['t1', 't2'],
      thinkingLevel: 'medium', maxIterations: 30, approvalMode: 'full-auto',
      createdBy: 'agent', createdAt: '2026-06-18T00:00:00.000Z',
      systemPrompt: 'do this\nand that', soul: '', libraryOrder: ['a.md', 'b.md'],
    };
    const toml = serializeAgentConfig(def);
    expect(toml).toContain('model_reasoning_effort');
    expect(toml).toContain('developer_instructions');
    const back = parseAgentConfig('r', toml, '# Soul\nbe calm');
    expect(back.name).toBe('Round');
    expect(back.systemPrompt).toBe('do this\nand that'); // 多行保真
    expect(back.tools).toEqual(['t1', 't2']);
    expect(back.thinkingLevel).toBe('medium');
    expect(back.approvalMode).toBe('full-auto');
    expect(back.maxIterations).toBe(30);
    expect(back.createdBy).toBe('agent');
    expect(back.libraryOrder).toEqual(['a.md', 'b.md']);
    expect(back.soul).toBe('# Soul\nbe calm'); // SOUL 独立于 config
  });

  it('multiline developer_instructions uses TOML literal (\'\'\') so hand-edits stay valid', () => {
    // christina 复现:用户手编的多行猫娘人设。基本串 "..." 直接换行会非法 TOML → 必须用 '''。
    const di = '扮演一个猫娘，说话喵喵喵\nLibrary里面有你的过往经历。';
    const def: NormalAgentDef = {
      slug: 'cat', name: 'Christina', description: 'd', model: 'gpt-5.5', tools: [],
      thinkingLevel: '', maxIterations: null, approvalMode: '', createdBy: 'user',
      createdAt: '2026-06-25T00:00:00.000Z', systemPrompt: di, soul: '', libraryOrder: [],
    };
    const toml = serializeAgentConfig(def);
    expect(toml).toContain("developer_instructions = '''"); // 多行字面串,非转义基本串
    expect(parseAgentConfig('cat', toml, '').systemPrompt).toBe(di); // 多行内容原样保真(parse 会 trim 首尾空白)
  });

  it('falls back to escaped string when value contains \'\'\'', () => {
    const di = "has ''' inside\nsecond line";
    const def: NormalAgentDef = {
      slug: 'q', name: 'Q', description: '', model: '', tools: [], thinkingLevel: '',
      maxIterations: null, approvalMode: '', createdBy: 'user', createdAt: '2026-06-25T00:00:00.000Z',
      systemPrompt: di, soul: '', libraryOrder: [],
    };
    expect(parseAgentConfig('q', serializeAgentConfig(def), '').systemPrompt).toBe(di);
  });

  it('tolerates garbage TOML → defaults', () => {
    const d = parseAgentConfig('x', 'not = valid = toml', '');
    expect(d.name).toBe('x');
    expect(d.systemPrompt).toBe('');
    expect(d.maxIterations).toBe(null);
  });
});

describe('per-agent memory resolves via run context', () => {
  it('remember/log land in the active agent folder; no slug → default xyra', async () => {
    enterRunContext('u', 'r1', 'code-reviewer');
    const b = createLocalMemoryBrain(); // 动态:按 currentAgentSlug 解析
    await b.appendMemoryEntry('u', '记一条评审偏好');
    const memPath = join(home, 'agents', 'code-reviewer', 'MEMORY.md');
    expect(existsSync(memPath)).toBe(true);
    expect(readFileSync(memPath, 'utf8')).toContain('记一条评审偏好');

    enterRunContext('u', 'r2'); // 无 agentSlug → 回退默认 agent
    const b2 = createLocalMemoryBrain();
    await b2.appendLogEntry('u', '默认 agent 日志', { date: '2026-06-25', time: '10:00' });
    expect(existsSync(join(home, 'agents', 'xyra', 'LOG', '2026-06-25.md'))).toBe(true);
    // code-reviewer 的记忆没被串写
    expect(existsSync(join(home, 'agents', 'xyra', 'MEMORY.md'))).toBe(false);
  });
});

describe('migration', () => {
  it('global memory → xyra: copy (non-destructive) + idempotent', async () => {
    mkdirSync(join(home, 'memory', 'log'), { recursive: true });
    writeFileSync(join(home, 'memory', 'MEMORY.md'), '老记忆', 'utf8');
    writeFileSync(join(home, 'memory', 'log', '2026-06-20.md'), '# 2026-06-20\n\n### 09:00\n@devA 旧日志\n', 'utf8');

    await migrateGlobalMemoryToXyra();
    expect(readFileSync(join(home, 'agents', 'xyra', 'MEMORY.md'), 'utf8')).toBe('老记忆');
    expect(existsSync(join(home, 'agents', 'xyra', 'LOG', '2026-06-20.md'))).toBe(true);
    expect(existsSync(join(home, 'memory', 'MEMORY.md'))).toBe(true); // 旧目录留备份

    // 二次调用是 no-op(xyra/MEMORY.md 已存在),不覆盖
    writeFileSync(join(home, 'memory', 'MEMORY.md'), '改了老的', 'utf8');
    await migrateGlobalMemoryToXyra();
    expect(readFileSync(join(home, 'agents', 'xyra', 'MEMORY.md'), 'utf8')).toBe('老记忆');
  });

  it('flat <slug>.md → <slug>/ folder, original left as .bak', async () => {
    mkdirSync(join(home, 'agents'), { recursive: true });
    writeFileSync(join(home, 'agents', 'legacy.md'), '---\nname: Legacy\nthinkingLevel: high\n---\n旧人格正文', 'utf8');

    await migrateFlatToFolder('legacy');
    expect(existsSync(join(home, 'agents', 'legacy', 'config.toml'))).toBe(true);
    expect(existsSync(join(home, 'agents', 'legacy.md.bak'))).toBe(true);
    expect(existsSync(join(home, 'agents', 'legacy.md'))).toBe(false);

    const def = await parseAgentFolder('legacy', join(home, 'agents', 'legacy'));
    expect(def.name).toBe('Legacy');
    expect(def.systemPrompt).toBe('旧人格正文'); // 旧正文 → developer_instructions
    expect(def.thinkingLevel).toBe('high');
  });
});

describe('Library 文件管理', () => {
  it('sanitizeLibraryName 拒绝路径穿越,收普通文件名', () => {
    expect(sanitizeLibraryName('notes.md')).toBe('notes.md');
    expect(sanitizeLibraryName('  a.txt ')).toBe('a.txt');
    for (const bad of ['', '../x', 'a/b', 'a\\b', '..', '../../etc/passwd', 'x\0y']) {
      expect(() => sanitizeLibraryName(bad)).toThrow();
    }
  });

  it('write/read/list/delete 文本与二进制往返', async () => {
    await writeLibraryFile('xyra', 'ref.md', { content: '# hello' });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    await writeLibraryFile('xyra', 'pic.png', { dataBase64: png, isBinary: true });

    const files = await listLibraryFiles('xyra');
    expect(files.map((f) => f.name).sort()).toEqual(['pic.png', 'ref.md']);
    expect(files.find((f) => f.name === 'pic.png')?.isBinary).toBe(true);
    expect(files.find((f) => f.name === 'ref.md')?.isBinary).toBe(false);

    const txt = await readLibraryFile('xyra', 'ref.md');
    expect(txt?.content).toBe('# hello');
    const bin = await readLibraryFile('xyra', 'pic.png');
    expect(bin?.isBinary).toBe(true);
    expect(bin?.dataBase64).toBe(png);
    expect(bin?.mimeType).toBe('image/png');

    await deleteLibraryFile('xyra', 'ref.md');
    expect((await listLibraryFiles('xyra')).map((f) => f.name)).toEqual(['pic.png']);
  });
});
