import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteTeamAvatar, getTeam, readTeamAvatar, saveTeam, saveTeamAvatar } from './teamRegistry.js';

describe('TEAM image avatar', () => {
  it('stores, reads, replaces metadata and removes an image avatar', async () => {
    const previous = process.env.TANGU_HOME;
    const home = mkdtempSync(join(tmpdir(), 'tangu-team-avatar-'));
    process.env.TANGU_HOME = home;
    try {
      await saveTeam({ name: 'Atlas', slug: 'atlas', avatar: '🧭', members: [{ slug: 'alpha' }, { slug: 'beta' }] });
      const filename = await saveTeamAvatar('atlas', Buffer.from('png-image').toString('base64'), 'image/png');
      expect(filename).toBe('avatar.png');
      expect((await getTeam('atlas'))?.avatar).toBe('avatar.png');
      expect(await readTeamAvatar('atlas')).toEqual({ data: Buffer.from('png-image'), mimeType: 'image/png' });

      await deleteTeamAvatar('atlas');
      expect((await getTeam('atlas'))?.avatar).toBe('');
      expect(await readTeamAvatar('atlas')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.TANGU_HOME;
      else process.env.TANGU_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
