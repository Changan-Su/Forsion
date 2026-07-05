import { describe, it, expect } from 'vitest';
import { reducer, initialState } from './events.js';
import type { UiState } from './types.js';

/** 群聊渲染的核心不变量:GROUP_NOTE 封存当前发言人的 live 气泡为一条 assistant 项,再追加分隔提示,并重置 live。 */
describe('reducer GROUP_NOTE (群聊发言人轮转)', () => {
  it('flushes the current speaker bubble before the next speaker header', () => {
    let s: UiState = reducer(initialState, { type: 'START_LIVE' });
    s = reducer(s, { type: 'APPEND_TEXT', delta: 'Alice 的发言' });
    s = reducer(s, { type: 'GROUP_NOTE', text: '🗣 Bob', tone: 'info' });

    // Alice 的气泡定稿为 assistant 项,Bob 的头作为 notice 紧随其后,live 清空待 Bob 流入。
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ kind: 'assistant' });
    expect(s.items[1]).toMatchObject({ kind: 'notice', text: '🗣 Bob' });
    expect(s.live).toEqual([]);
  });

  it('first speaker header adds no empty bubble (live started empty)', () => {
    let s: UiState = reducer(initialState, { type: 'START_LIVE' });
    s = reducer(s, { type: 'GROUP_NOTE', text: '🗣 Alice', tone: 'info' });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'notice', text: '🗣 Alice' });
  });

  it('DONE flushes the last speaker bubble', () => {
    let s: UiState = reducer(initialState, { type: 'START_LIVE' });
    s = reducer(s, { type: 'GROUP_NOTE', text: '🗣 Alice', tone: 'info' }); // header
    s = reducer(s, { type: 'APPEND_TEXT', delta: 'Alice says hi' });
    s = reducer(s, { type: 'DONE' });
    const assistants = s.items.filter((it) => it.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(s.live).toBeNull();
    expect(s.busy).toBe(false);
  });
});

describe('reducer TODO', () => {
  it('replaces the todo list and clears it on session reset', () => {
    let s: UiState = reducer(initialState, { type: 'TODO', todos: [{ content: 'a', status: 'pending' }] });
    expect(s.todos).toHaveLength(1);
    s = reducer(s, { type: 'RESET_SESSION' });
    expect(s.todos).toEqual([]);
  });
});
