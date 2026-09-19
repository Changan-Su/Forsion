/** 思考档默认值 low → medium 的一次性迁移:只翻 Arioso / Aria 上播种写下的 low,翻一次;自建 Agent 与之后的手动选择不碰。
 *  独立文件 → TANGU_HOME 与名册缓存不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const toml = (name: string, effort: string): string => `name = "${name}"\nversion = "1.1.0"\nmodel = "user-picked-model"\nmodel_reasoning_effort = "${effort}"\ndeveloper_instructions = """custom prompt"""\n`;

describe('migrateDefaultEffortOnce', () => {
  let home: string;
  const cfg = (slug: string): string => path.join(home, 'agents', slug, 'config.toml');
  const effort = async (slug: string): Promise<string> => /model_reasoning_effort = "(\w+)"/.exec(await fs.readFile(cfg(slug), 'utf-8'))?.[1] || '';
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-effort-'));
    process.env.TANGU_HOME = home;
    for (const [slug, level] of [['xyra', 'low'], ['aria', 'low'], ['recita', 'high'], ['my-bot', 'low']] as const) {
      mkdirSync(path.join(home, 'agents', slug), { recursive: true });
      writeFileSync(cfg(slug), toml(slug, level));
    }
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('Arioso / Aria 的 low 翻成 medium,其余字段不动;别的档位与自建 Agent 不碰', async () => {
    const { migrateDefaultEffortOnce, DEFAULT_AGENTS } = await import('./agentRegistry.js');
    expect(DEFAULT_AGENTS.filter((a) => ['xyra', 'aria'].includes(a.slug)).map((a) => a.thinkingLevel)).toEqual(['medium', 'medium']);
    await migrateDefaultEffortOnce();
    expect(await effort('xyra')).toBe('medium');
    expect(await effort('aria')).toBe('medium');
    expect(await effort('recita')).toBe('high');
    expect(await effort('my-bot')).toBe('low');
    const raw = await fs.readFile(cfg('xyra'), 'utf-8');
    expect(raw).toContain('user-picked-model');
    expect(raw).toContain('custom prompt');
  });

  it('只翻一次:之后用户调回 low 永久保留', async () => {
    const { migrateDefaultEffortOnce } = await import('./agentRegistry.js');
    writeFileSync(cfg('xyra'), toml('xyra', 'low'));
    await migrateDefaultEffortOnce();
    expect(await effort('xyra')).toBe('low');
  });
});
