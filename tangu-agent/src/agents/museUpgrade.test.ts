/** Muse 原装旧指令的一次性升级:老装机的 Muse 拿着「其余一律只读」的指令,从不写日程(Calendar 因此恒空)。
 *  独立文件 → TANGU_HOME 与名册缓存不被别的用例污染。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LEGACY_MUSE_PROMPTS, LEGACY_MUSE_DESCRIPTION } from './legacyPersonas.js';
import { DEFAULT_MUSE_PROMPT } from '../services/specialAgentsConfig.js';

const toml = (prompt: string, description = LEGACY_MUSE_DESCRIPTION): string =>
  `name = "Muse"\nversion = "1.0.0"\ndescription = ${JSON.stringify(description)}\ncreated_by = "system"\nmodel = "user-picked-model"\napproval_mode = "readonly"\nactivity_access = true\ndeveloper_instructions = ${JSON.stringify(prompt)}\n`;

describe('ensureMuseAgent · 原装旧指令升级', () => {
  let home: string;
  const cfgPath = (): string => path.join(home, 'agents', 'muse', 'config.toml');
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-muse-'));
    process.env.TANGU_HOME = home;
    mkdirSync(path.join(home, 'agents', 'muse'), { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  it('三版历史原装都换成现行预设(含 manage_schedule),用户配置一个不丢', async () => {
    const { ensureMuseAgent, parseAgentFolder } = await import('./agentRegistry.js');
    expect(DEFAULT_MUSE_PROMPT).toContain('manage_schedule');
    for (const legacy of LEGACY_MUSE_PROMPTS) {
      writeFileSync(cfgPath(), toml(legacy));
      await ensureMuseAgent();
      const def = await parseAgentFolder('muse', path.join(home, 'agents', 'muse'));
      expect(def.systemPrompt).toBe(DEFAULT_MUSE_PROMPT);
      expect(def.description).not.toBe(LEGACY_MUSE_DESCRIPTION);
      expect(def.model).toBe('user-picked-model');
      expect(def.approvalMode).toBe('readonly');
      expect(def.activityAccess).toBe(true);
      expect(def.createdBy).toBe('system');
    }
  });

  it('用户改过一个字就不算原装:指令原样保留,文件不重写', async () => {
    const { ensureMuseAgent } = await import('./agentRegistry.js');
    const custom = `${LEGACY_MUSE_PROMPTS[2]} Also water the plants.`;
    writeFileSync(cfgPath(), toml(custom, 'My own Muse'));
    const before = await fs.readFile(cfgPath(), 'utf-8');
    await ensureMuseAgent();
    expect(await fs.readFile(cfgPath(), 'utf-8')).toBe(before);
  });
});
