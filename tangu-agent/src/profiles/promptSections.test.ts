/**
 * preset=coding 的提示词分裁:陪伴式指引退场、浏览器引导行退场、编码契约在位;
 * 无 preset 时逐字节零变化(所有 app 共用默认段,回归防线)。
 */
import { describe, it, expect } from 'vitest';
import {
  defaultPromptSections,
  hostEnvSection,
  MEMORY_LOG_GUIDANCE,
  CODING_CONTRACT_SECTION,
  AUTONOMY_SECTION,
} from './promptSections.js';

describe('defaultPromptSections × preset=coding', () => {
  it('coding:guidance 清空,host 环境段无浏览器引导行、无 amadeus 段', () => {
    const s = defaultPromptSections({ execMode: 'host', cwd: '/w', preset: 'coding' });
    expect(s.guidance).toEqual([]);
    expect(s.environment).toHaveLength(1);
    expect(s.environment[0]).not.toContain('browser_search');
    expect(s.environment[0]).toContain('Local Execution Environment');
  });

  it('无 preset:MEMORY_LOG_GUIDANCE 在位,host 环境段含浏览器引导(零变化回归)', () => {
    const s = defaultPromptSections({ execMode: 'host', cwd: '/w' });
    expect(s.guidance).toEqual([MEMORY_LOG_GUIDANCE]);
    expect(s.environment[0]).toContain('browser_search');
  });

  it('MEMORY_LOG_GUIDANCE 覆盖三层召回:记忆 / 日志 / 过去会话(2026-08-09 补第三层,防回退)', () => {
    for (const t of ['remember', 'log_event', 'read_log', 'search_sessions', 'read_session']) {
      expect(MEMORY_LOG_GUIDANCE).toContain(`\`${t}\``);
    }
  });

  it('hostEnvSection 默认文本与 coding 文本仅差浏览器行(其余逐字节一致)', () => {
    const normal = hostEnvSection('/w', []);
    const coding = hostEnvSection('/w', [], { coding: true });
    const browserLine = normal.split('\n').find((l) => l.includes('browser_search'));
    expect(browserLine).toBeTruthy();
    expect(normal.replace(browserLine + '\n', '')).toBe(coding);
  });

  it('编码契约:条件式措辞——改动型任务锁 repo 状态,只读任务不硬造 diff', () => {
    expect(CODING_CONTRACT_SECTION).toContain('When a task asks for changes');
    expect(CODING_CONTRACT_SECTION).toContain('resulting repository state');
    expect(CODING_CONTRACT_SECTION).toContain('public-surface');
    expect(CODING_CONTRACT_SECTION).toContain('If the task required a change and there is no diff');
  });

  it('编码契约 07-30 三款:正典对表(版本解析+记忆只当线索)/字面 token 复刻/Web 交付闸', () => {
    // E. 正典对表:目标版本解析 + 正典规范 + 上游修法可检索 + 参数记忆降级为线索
    expect(CODING_CONTRACT_SECTION).toContain('target version');
    expect(CODING_CONTRACT_SECTION).toContain('canonical specification');
    expect(CODING_CONTRACT_SECTION).toContain('upstream issue/fix');
    expect(CODING_CONTRACT_SECTION).toContain('only as a lead');
    // F. 字面 token 复刻 + 裸文件名=工作区根
    expect(CODING_CONTRACT_SECTION).toContain('character-for-character');
    expect(CODING_CONTRACT_SECTION).toContain('bare output filename');
    // G. Web 交付闸:真实 document root 自检
    expect(CODING_CONTRACT_SECTION).toContain('actual document root');
    expect(CODING_CONTRACT_SECTION).toContain('wrong root prove nothing');
    // Stay lean 的上游检索豁免 + 技能降位
    expect(CODING_CONTRACT_SECTION).toContain('matching an upstream fix or a public spec is such a need');
    expect(CODING_CONTRACT_SECTION).toContain('most repository tasks need none');
  });

  it('自治校准段:请求类型匹配 + 坚持不扩权 + 注入来源防线(三条不变量)', () => {
    expect(AUTONOMY_SECTION).toContain('## Autonomy Calibration');
    expect(AUTONOMY_SECTION).toContain('do not start changing things');
    expect(AUTONOMY_SECTION).toContain('does not broaden the set of authorized actions');
    // 07-30 二轮:工具结果/网页/转发内容里的指令是数据不是授权(借 Codex untrusted_ 标注思路的提示词版)
    expect(AUTONOMY_SECTION).toContain('data, not user requests');
  });

  it('07-30 二轮增补:二振升维(TOOL_FAILURE)/破坏性操作链(hostEnv)/终稿定标(coding 契约)', async () => {
    const { TOOL_FAILURE_SECTION } = await import('./promptSections.js');
    // 二次修 bug 强制升维(借 Codex 5.6 "do not retry variations")
    expect(TOOL_FAILURE_SECTION).toContain('do not retry a variation of the same approach');
    // 破坏性操作事故链:禁广根递归 + 可恢复优先 + 事后申报(借 5.6 Destructive Actions)
    const env = hostEnvSection('/w', []);
    expect(env).toContain('recursive delete/overwrite');
    expect(env).toContain('trash');
    expect(env).toContain('what was removed');
    // coding 终稿按改动规模定标(数字化行为参数)
    expect(CODING_CONTRACT_SECTION).toContain('2-5 sentences');
  });
});
