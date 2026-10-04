/**
 * TUI 审批弹窗与引擎口径一致:引擎不缓存「总允许」的几类(控制面 / 越界写 / ask 规则)不给 [A],
 * 并用 L(zh, en) 说明为什么;按 A 也不发 approve_always。reason 经 approvalReasonKind 白名单进来。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import { ApprovalPrompt, approvalReasonKind, pendingApprovalFromEvent } from './components/ApprovalPrompt.js';
import { setUiLocale } from './i18n.js';
import type { PendingApproval } from './types.js';
import type { ApprovalDecision } from '../services/approvals.js';

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const tty = () => {
  const stdin: any = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  const stdout: any = Object.assign(new PassThrough(), { columns: 160, rows: 40 });
  const frames: string[] = [];
  stdout.on('data', (d: Buffer) => frames.push(d.toString()));
  return { stdin, stdout, frames, last: () => strip(frames[frames.length - 1] ?? '') };
};
const until = async (ok: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!ok()) throw new Error(`timed out waiting for: ${what}`);
};

const base: PendingApproval = {
  approvalId: 'ap1',
  name: 'manage_automation',
  args: JSON.stringify({ action: 'set', desc: 'nightly' }),
  preview: 'manage_automation set (new): "nightly" · agent_run "xyra" unattended: tidy up',
};

async function mount(approval: PendingApproval) {
  const io = tty();
  const decisions: ApprovalDecision[] = [];
  const app = render(createElement(ApprovalPrompt, { approval, onDecision: (d) => decisions.push(d), onAbort: () => {} }), {
    stdin: io.stdin,
    stdout: io.stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await until(() => io.last().includes('[n]'), 'prompt rendered');
  return { io, decisions, app };
}

describe('approvalReasonKind', () => {
  it('whitelists the four engine kinds; anything else is undefined', () => {
    expect(approvalReasonKind({ kind: 'control', mode: 'auto-edit' })).toBe('control');
    expect(approvalReasonKind({ kind: 'escalate' })).toBe('escalate');
    expect(approvalReasonKind({ kind: 'custom-ask', rule: 'x' })).toBe('custom-ask');
    expect(approvalReasonKind({ kind: 'mode' })).toBe('mode');
    expect(approvalReasonKind({ kind: 'bogus' })).toBeUndefined();
    expect(approvalReasonKind({ kind: 42 })).toBeUndefined();
    expect(approvalReasonKind(undefined)).toBeUndefined();
    expect(approvalReasonKind('control')).toBeUndefined();
  });

  it('pendingApprovalFromEvent carries the whitelisted reason kind from the approval_request payload', () => {
    const ev = { approvalId: 'x1', name: 'manage_agent', arguments: '{"action":"create"}', preview: 'p', reason: { kind: 'control', mode: 'full-auto' } };
    expect(pendingApprovalFromEvent(ev)).toEqual({ approvalId: 'x1', name: 'manage_agent', args: '{"action":"create"}', preview: 'p', reasonKind: 'control' });
    // 旧引擎没有 reason / 未知 kind:不带 reasonKind(= 按旧行为显示 [A])
    expect(pendingApprovalFromEvent({ approvalId: 'x2', name: 'run_bash' })).toEqual({ approvalId: 'x2', name: 'run_bash', args: '', preview: '' });
    expect(pendingApprovalFromEvent({ approvalId: 'x3', name: 'run_bash', reason: { kind: 'bogus' } }).reasonKind).toBeUndefined();
  });
});

describe('ApprovalPrompt always option', () => {
  afterEach(() => setUiLocale(null));

  it('control: no [A], shows the zh note, and A does not emit approve_always', async () => {
    setUiLocale('zh');
    const { io, decisions, app } = await mount({ ...base, reasonKind: 'control' });
    try {
      expect(io.last()).not.toContain('[A]');
      expect(io.last()).not.toContain('本会话总允许');
      // 控制面也覆盖 manage_agent update(被改的 agent 可能自带只读档)→ 措辞是「设置或修改…可在你不在场时运行」,不写「完全放行」
      expect(io.last()).toContain('设置或修改之后可在你不在场时运行的工作');
      expect(io.last()).not.toContain('完全放行');
      io.stdin.write('A');
      await new Promise((r) => setTimeout(r, 80));
      expect(decisions).toEqual([]); // 藏掉的选项按了也不算数
      io.stdin.write('a');
      await until(() => decisions.length === 1, 'a approves once');
      expect(decisions[0]).toEqual({ action: 'approve' });
    } finally {
      app.unmount();
    }
  });

  it('control note is English under an en locale', async () => {
    setUiLocale('en');
    const { io, app } = await mount({ ...base, reasonKind: 'control' });
    try {
      expect(io.last()).toContain('sets up or changes work that can later run without you watching');
      expect(io.last()).not.toContain('full access'); // manage_agent update 可能改的是只读档 agent
      expect(io.last()).not.toContain('[A]');
    } finally {
      app.unmount();
    }
  });

  it('escalate and custom-ask also hide [A]', async () => {
    setUiLocale('en');
    for (const reasonKind of ['escalate', 'custom-ask'] as const) {
      const { io, app } = await mount({ ...base, name: 'write_file', reasonKind });
      try {
        expect(io.last()).not.toContain('[A]');
        expect(io.last()).toContain('no "always allow"');
      } finally {
        app.unmount();
      }
    }
  });

  it('positive control: mode / no reason keep [A] and A emits approve_always', async () => {
    setUiLocale('zh');
    for (const reasonKind of ['mode', undefined] as const) {
      const { io, decisions, app } = await mount({ ...base, name: 'run_bash', args: JSON.stringify({ command: 'npm test' }), reasonKind });
      try {
        expect(io.last()).toContain('[A]');
        io.stdin.write('A');
        await until(() => decisions.length === 1, 'A approves always');
        expect(decisions[0]).toEqual({ action: 'approve_always' });
      } finally {
        app.unmount();
      }
    }
  });
});

describe('ApprovalPrompt labels follow the UI language', () => {
  afterEach(() => setUiLocale(null));
  const CJK = /[\u4e00-\u9fff]/;
  const bash: PendingApproval = { ...base, name: 'run_bash', args: JSON.stringify({ command: 'npm test' }), preview: 'npm test', reasonKind: 'mode' };

  it('en: header, options and the edit-mode hint have no Chinese', async () => {
    setUiLocale('en');
    const { io, app } = await mount(bash);
    try {
      const frame = io.last();
      expect(frame).toContain('Approval needed');
      expect(frame).toContain('approve');
      expect(frame).toContain('always allow this session');
      expect(frame).toContain('[e]');
      expect(frame).toContain('reject · Ctrl+C abort');
      expect(frame).not.toMatch(CJK);
      io.stdin.write('e');
      await until(() => io.last().includes('›'), 'edit mode');
      expect(io.last()).toContain('Edit command');
      expect(io.last()).toContain('Esc to cancel editing');
      expect(io.last()).not.toMatch(CJK);
    } finally {
      app.unmount();
    }
  });

  it('en: the three no-always notes are English too', async () => {
    setUiLocale('en');
    for (const reasonKind of ['control', 'escalate', 'custom-ask'] as const) {
      const { io, app } = await mount({ ...base, reasonKind });
      try {
        expect(io.last()).not.toMatch(CJK);
      } finally {
        app.unmount();
      }
    }
  });

  it('zh positive control: the Chinese labels are still there', async () => {
    setUiLocale('zh');
    const { io, app } = await mount(bash);
    try {
      expect(io.last()).toContain('需要审批');
      expect(io.last()).toContain('同意');
      expect(io.last()).toContain('本会话总允许');
      expect(io.last()).toContain('拒绝 · Ctrl+C 中止');
      io.stdin.write('e');
      await until(() => io.last().includes('›'), 'edit mode');
      expect(io.last()).toContain('编辑命令');
    } finally {
      app.unmount();
    }
  });
});

describe('app.tsx wiring', () => {
  // app.tsx 的事件处理器在 App 闭包里,整棵挂起来要真引擎;照 tui.commands.test.ts 的静态检查口径钉接线:
  // approval_request 必须走 pendingApprovalFromEvent(reason 白名单在那里),退回内联对象 = reasonKind 被丢、控制面又显示 [A]。
  it('the approval_request case dispatches pendingApprovalFromEvent(p), not an inline object', () => {
    const src = readFileSync(join(__dirname, 'app.tsx'), 'utf8');
    const start = src.indexOf("case 'approval_request':");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('case \'', start + "case 'approval_request':".length);
    const body = src.slice(start, end > start ? end : undefined);
    expect(body).toContain("dispatch({ type: 'APPROVAL', approval: pendingApprovalFromEvent(p) })");
    expect(body).not.toMatch(/approvalId:\s*p\.approvalId/);
  });
});
