/**
 * 「设置 → Git」:逐键 normalize(非法值丢弃不抛)、写口逐键校验(非法抛错不写)、null 回缺省;
 * 偏好随 `[Git state]` 注入(空提交说明 / 空前缀不出行)。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GIT_SETTINGS, COMMIT_INSTRUCTIONS_MAX, gitSettings, normalizeGitSettings, resetGitSettingsForTest, updateGitSettings } from './gitSettings.js';
import { gitPreferenceLines } from './runtimeContext.js';

beforeEach(() => resetGitSettingsForTest());
afterAll(() => resetGitSettingsForTest());

describe('normalizeGitSettings', () => {
  it('前缀只收 ref 安全字符且 ≤40;提交说明去 NUL、截断;开关只认布尔', () => {
    expect(normalizeGitSettings({ branchPrefix: ' feat/ ' })).toEqual({ branchPrefix: 'feat/' });
    expect(normalizeGitSettings({ branchPrefix: '' })).toEqual({ branchPrefix: '' });
    for (const bad of ['a b', 'x~y', 'a:b', 'x'.repeat(41), 7]) expect(normalizeGitSettings({ branchPrefix: bad })).toEqual({});
    expect(normalizeGitSettings({ commitInstructions: 'a\0b' }).commitInstructions).toBe('ab');
    expect(normalizeGitSettings({ commitInstructions: 'x'.repeat(5000) }).commitInstructions).toHaveLength(COMMIT_INSTRUCTIONS_MAX);
    expect(normalizeGitSettings({ forceWithLease: 'yes' })).toEqual({});
    expect(normalizeGitSettings(null)).toEqual({});
    expect(normalizeGitSettings([1])).toEqual({});
  });
});

describe('updateGitSettings', () => {
  it('逐键写、null 删键回缺省;非法值抛错且不落半截', () => {
    expect(gitSettings()).toEqual(DEFAULT_GIT_SETTINGS);
    expect(updateGitSettings({ branchPrefix: 'me/', forceWithLease: true })).toEqual({ ...DEFAULT_GIT_SETTINGS, branchPrefix: 'me/', forceWithLease: true });
    expect(() => updateGitSettings({ commitInstructions: 'ok', branchPrefix: 'a b' })).toThrow('invalid git.branchPrefix');
    expect(gitSettings().commitInstructions).toBe(''); // 同一个 patch 里合法的那键也没写进去
    expect(updateGitSettings({ branchPrefix: null }).branchPrefix).toBe(DEFAULT_GIT_SETTINGS.branchPrefix);
    expect(() => updateGitSettings({ unknown: 1 })).toThrow('invalid git.unknown');
  });
});

describe('gitPreferenceLines', () => {
  it('缺省只有分支前缀一行;提交说明有才出;前缀清空就不提', () => {
    expect(gitPreferenceLines()).toContain('start it with "tangu/"');
    expect(gitPreferenceLines()).not.toContain('Commit message instructions');
    updateGitSettings({ branchPrefix: '', commitInstructions: 'Write the subject in Chinese.' });
    const lines = gitPreferenceLines();
    expect(lines).not.toContain('branch name');
    expect(lines).toContain('Commit message instructions:\nWrite the subject in Chinese.');
    updateGitSettings({ commitInstructions: null });
    expect(gitPreferenceLines()).toBe('');
  });
});
