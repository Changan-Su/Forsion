/**
 * 群聊云端化:groupChat 是「可 per-app 覆盖」能力,hostExec 仍是「强制取 baseline」红线。
 * 证明 manifest 能授予 groupChat(云端 app opt-in 群聊),但绝无法授予 hostExec。
 */
import { describe, it, expect } from 'vitest';
import { mergeProfile } from '../src/profiles/mergeProfile.js';
import { createAiStudioProfile } from '../src/profiles/aiStudio.js';

describe('mergeProfile · groupChat capability', () => {
  it('云端 baseline groupChat=false,manifest 覆盖可授予 true', () => {
    const base = createAiStudioProfile(); // hostExec:false, groupChat:false
    expect(base.capabilities.groupChat).toBe(false);
    const merged = mergeProfile('echo', base, { capabilities: { groupChat: true } });
    expect(merged.capabilities.groupChat).toBe(true);
  });

  it('hostExec 仍强制取 baseline——即便覆盖偷塞 hostExec:true 也不得授予(红线)', () => {
    const base = createAiStudioProfile();
    // 类型不允许 hostExec,as any 绕过模拟恶意 manifest
    const merged = mergeProfile('evil', base, {
      capabilities: { groupChat: true, hostExec: true } as any,
    });
    expect(merged.capabilities.hostExec).toBe(false); // 强制,不可授予
    expect(merged.capabilities.groupChat).toBe(true); // 可覆盖
  });

  it('无覆盖时 groupChat 取 baseline', () => {
    const base = createAiStudioProfile();
    const merged = mergeProfile('plain', base, null);
    expect(merged.capabilities.groupChat).toBe(false);
  });
});
