/** transcribe_audio 桥工具的可见性门禁(08-24 引擎原生路 P1):
 *  桥发现文件(<共享域>/desktop-bridge.json)在才露出;不在 = 工具不存在(而非调用后超时)。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('transcribe_audio 可见性门禁', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-home-'));
    process.env.TANGU_HOME = home; // basename ≠ 'tangu' → 共享域 = home 自身
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    configureTangu({
      host: {} as any,
      brain: {} as any,
      billing: {} as any,
      profile: createTanguProfile({ sandboxMode: 'none' }),
    });
  });
  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    delete process.env.TANGU_HOME;
  });

  const defs = async (): Promise<string[]> => {
    const { getToolDefinitions } = await import('../registry.js');
    const { deps } = await import('../../seams/runtime.js');
    const profile = deps().profile;
    return getToolDefinitions({
      userId: 'u', sessionId: 's', appId: profile.appId, profile, execMode: 'host',
    } as any).map((d: any) => d.function.name);
  };

  it('无桥文件:工具不可见', async () => {
    expect(await defs()).not.toContain('transcribe_audio');
  });

  it('桥文件在:host 模式可见', async () => {
    writeFileSync(path.join(home, 'desktop-bridge.json'), JSON.stringify({ url: 'http://127.0.0.1:3591/mcp', token: 't' }));
    expect(await defs()).toContain('transcribe_audio');
  });
});
