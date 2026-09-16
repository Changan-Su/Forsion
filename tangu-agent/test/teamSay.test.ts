import { expect, it, vi } from 'vitest';
import { teamSayProvider } from '../src/tools/builtin/teamSay.js';

it('team_say is available only to team members and awaits posting before acknowledging', async () => {
  const tool = teamSayProvider.tools()[0];
  expect(tool.isEnabledFor!({} as any, {} as any)).toBe(false);
  expect(tool.isEnabledFor!({} as any, { teamSessionId: 'team' } as any)).toBe(true);
  expect(tool.isEnabledFor!({} as any, { teamSessionId: 'team', subAgentDepth: 1 } as any)).toBe(false);
  const sayToTeam = vi.fn(async () => {});
  await tool.execute({ text: '  Findings ready  ' }, { sayToTeam } as any);
  expect(sayToTeam).toHaveBeenCalledWith('Findings ready', false);
  await tool.execute({ text: '' }, { sayToTeam } as any);
  expect(sayToTeam).toHaveBeenCalledTimes(1);
  await tool.execute({ text: '@Beta please check the result', requestReply: true }, { sayToTeam } as any);
  expect(sayToTeam).toHaveBeenLastCalledWith('@Beta please check the result', true);
  await expect(tool.execute({ text: 'remark' }, { sayToTeam: async () => { throw new Error('disconnected'); } } as any)).rejects.toThrow('disconnected');
});
