/** 交接(底层第 3 步)的纯逻辑:交哪些工具、指令文件的预算和稳定性、指令目录里的软链接。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentsHomeDir, dshHomeInstructionsBytes, handedToolNames, instructionsBudget, INSTRUCTIONS_CHAIN_BYTES, INSTRUCTIONS_MAX_BYTES,
  notHandedReason, renderAgentInstructions, skillLinkName, userAgentsHome, userSkillDirs, writeAgentsHome,
} from './agentHandoff.js';
import { COMPUTER_USE_CONCURRENCY_KEY } from '../tools/toolRegistry.js';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tangu-handoff-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const tool = (name: string, extra: any = {}) => [name, { name, definition: { function: { name, description: '', parameters: {} } }, ...extra }] as const;

describe('交哪些工具', () => {
  it('去掉引擎自带的、Tangu 循环里的、靠截图的、会在以后起 run 的;其余照解析顺序交', () => {
    const tools = new Map<string, any>([
      tool('remember'), tool('read_file'), tool('run_bash'), tool('amadeus_list_events'), tool('use_skill'), tool('todo_write'),
      tool('browser_navigate'), tool('phone_open'), tool('view_image'), tool('manage_schedule'), tool('start_session'),
      tool('cu_click', { capabilities: { concurrencyKey: COMPUTER_USE_CONCURRENCY_KEY } }), tool('generate_image'), tool('delegate'),
      tool('forsion_wait'),
    ]);
    expect(handedToolNames(tools)).toEqual(['remember', 'amadeus_list_events', 'generate_image', 'delegate']);
    expect(notHandedReason({ name: 'read_file' })).toBe('harness');
    expect(notHandedReason({ name: 'load_tools' })).toBe('loop');
    expect(notHandedReason({ name: 'browser_tabs' })).toBe('screenshot');
    expect(notHandedReason({ name: 'manage_automation' })).toBe('later-run');
  });
});

describe('指令文件', () => {
  const sections = [
    { key: 'persona', text: '## Persona\nkind' },
    { key: 'tools', text: '## Forsion tools\nuse them' },
    { key: 'memory', text: '## Memory\n' + 'm'.repeat(5000) },
    { key: 'folder', text: '## Folder\nhere' },
  ];

  it('输入不变时逐字节相同(续接时引擎拿它对账)', () => {
    const a = renderAgentInstructions('head', sections, 64_000).text;
    const b = renderAgentInstructions('head', sections, 64_000).text;
    expect(a).toBe(b);
    expect(a.indexOf('## Persona')).toBeLessThan(a.indexOf('## Forsion tools'));
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('放不下的那段截断、之后的略去并写明,总量不超过预算(按 UTF-8 字节)', () => {
    const cjk = [{ key: 'persona', text: '人设'.repeat(800) }, { key: 'memory', text: '记忆'.repeat(4000) }, { key: 'folder', text: 'folder' }];
    const r = renderAgentInstructions('head', cjk, 12_000);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(12_000);
    expect(r.truncated).toEqual(['memory']);
    expect(r.omitted).toEqual(['folder']);
    expect(r.text).toContain('Left out by Forsion');
    expect(r.text).not.toContain('�');
  });

  it('预算 = 整条链减去用户写给 DSH 的那份(不挤掉用户自己的全局指令),有上限和下限', () => {
    expect(instructionsBudget(0)).toBe(INSTRUCTIONS_MAX_BYTES);
    expect(instructionsBudget(30_000)).toBe(INSTRUCTIONS_CHAIN_BYTES - 30_000 - 2_048);
    expect(instructionsBudget(1_000_000)).toBe(4_096);
    writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(1234));
    expect(dshHomeInstructionsBytes({ DSH_HOME: root } as any)).toBe(1234);
    expect(dshHomeInstructionsBytes({ DSH_HOME: path.join(root, 'nope') } as any)).toBe(0);
  });

  it('用户自己的共用根:设了 DSH_AGENTS_HOME 用它,否则 ~/.agents', () => {
    expect(userAgentsHome({ DSH_AGENTS_HOME: root } as any)).toBe(root);
    expect(userAgentsHome({ HOME: '/nowhere' } as any).endsWith(`${path.sep}.agents`)).toBe(true);
  });
});

describe('指令目录', () => {
  it('每场对话一个固定目录,会话 id 里的怪字符换掉', () => {
    process.env.TANGU_HOME = root;
    try {
      expect(agentsHomeDir('dsh', 'a/b..c')).toBe(path.join(root, 'engines', 'dsh', 'agents', 'a_b..c'));
      expect(agentsHomeDir('dsh', 'S1')).toBe(agentsHomeDir('dsh', 'S1'));
    } finally { delete process.env.TANGU_HOME; }
  });

  it('AGENTS.md 内容变了才重写;技能用软链接,只增删自己的,真实文件 / 目录不动也不被同名链接盖掉', () => {
    const dir = path.join(root, 'home');
    const skillA = path.join(root, 'src', 'a'), skillB = path.join(root, 'src', 'b'), skillC = path.join(root, 'src', 'c');
    for (const d of [skillA, skillB, skillC]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'SKILL.md'), '---\nname: x\n---\n'); }
    expect(writeAgentsHome(dir, 'one\n', [{ name: 'a', target: skillA }, { name: 'b', target: skillB }]).wrote).toBe(true);
    const mtime = statSync(path.join(dir, 'AGENTS.md')).mtimeMs;
    // 模型自己往 skills/ 里写的真目录;以及一个和下面同名的真目录
    mkdirSync(path.join(dir, 'skills', 'mine'));
    writeFileSync(path.join(dir, 'skills', 'mine', 'SKILL.md'), 'own');
    mkdirSync(path.join(dir, 'skills', 'c'));
    expect(writeAgentsHome(dir, 'one\n', [{ name: 'a', target: skillA }, { name: 'c', target: skillC }]).wrote).toBe(false);
    expect(statSync(path.join(dir, 'AGENTS.md')).mtimeMs).toBe(mtime);
    expect(readlinkSync(path.join(dir, 'skills', 'a'))).toBe(skillA);
    expect(existsSync(path.join(dir, 'skills', 'b'))).toBe(false); // 不再要的链接删掉
    expect(readFileSync(path.join(dir, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('own');
    expect(lstatSync(path.join(dir, 'skills', 'c')).isSymbolicLink()).toBe(false);
    expect(writeAgentsHome(dir, 'two\n', []).wrote).toBe(true);
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('two\n');
  });

  it('用户共用根里的技能:只认带 SKILL.md 的文件夹;链接名去掉怪字符、重名加序号', () => {
    mkdirSync(path.join(root, 'skills', 'good'), { recursive: true });
    writeFileSync(path.join(root, 'skills', 'good', 'SKILL.md'), 'x');
    mkdirSync(path.join(root, 'skills', 'empty'), { recursive: true });
    expect(userSkillDirs(root).map((s) => s.name)).toEqual(['good']);
    expect(userSkillDirs(path.join(root, 'none'))).toEqual([]);
    const taken = new Set<string>();
    expect(skillLinkName('local:pdf', taken)).toBe('pdf');
    expect(skillLinkName('local:plugin:x/pdf', taken)).toBe('pdf-2');
    expect(skillLinkName('local:我的 技能', taken)).toBe('skill');
  });
});
