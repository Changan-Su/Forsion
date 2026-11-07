/**
 * live 场景 devscope(11-06,记忆按条标适用范围):真模型 × 真引擎,判据看系统提示和磁盘上的 MEMORY.md。
 *
 * 种子:本机名 / 账号里别台的名字写进隔离 home 的共享域(content-sync-device.json / content-sync-devices.json,和 Extend 写的同形);
 * 默认 Agent 的记忆里放四条:所有设备一条、本机一条、别台一条、别的系统一条。
 *   ① 读:问「这台电脑上论文模板在哪」→ 答本机那条的路径,不答别台的;系统提示里没有别台 / 别的系统那两条,有一行折起来的英文提示。
 *   ② 写「只在这台」:说明只是这台电脑的情况 → remember 带 appliesTo=this-computer,磁盘上那一行以 [本机名] 开头(引擎加的,不是模型拼的)。
 *   ③ 写「这个系统」:一条只和系统有关的环境事实(跑脚本前要 ulimit)→ appliesTo=this-os,那一行以 [macOS] / [Windows] 开头。
 *   ④ 写「所有设备」:一条对做事方式的要求 → 不带标签(记进画像也算对,画像不分设备)。
 * --devscope-neg:负对照 —— 不写设备表(别台的名字认不出来,`[Windows desktop]` 那条当正文进提示词),① 的「系统提示里没有别台那条」须红。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SLUG = 'xyra';

export async function deviceScopeLive({ run, api, shared, OUT, argv = [] }) {
  const neg = argv.includes('--devscope-neg');
  const mac = process.platform === 'darwin', win = process.platform === 'win32';
  const os = mac ? 'macOS' : win ? 'Windows' : 'Linux';
  const otherOs = mac ? 'Windows' : 'macOS';
  const self = `Harness ${mac ? 'Mac' : win ? 'PC' : 'Box'}`;
  const other = 'Windows desktop';
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'content-sync-device.json'), JSON.stringify({ id: 'harness-device', name: self }));
  if (!neg) writeFileSync(join(shared, 'content-sync-devices.json'), JSON.stringify({ devices: [{ id: 'harness-device', name: self }, { id: 'other-device', name: other }] }));

  const seed = [
    '- 用户写论文用 LaTeX',
    `- [${self}] 这台电脑上论文模板放在 ~/Papers/template-here`,
    `- [${other}] 论文模板放在 D:\\Papers\\template-there`,
    `- [${otherOs}] 用 Fluent 时路径不能带空格`,
  ].join('\n');
  const before = await api(`/agent/agents/${SLUG}/memory`);
  await api(`/agent/agents/${SLUG}/memory`, { method: 'PUT', body: JSON.stringify({ content: seed, expectedVersion: before.version }) });
  const memoryFile = join(shared, 'tangu', 'agents', SLUG, 'MEMORY.md');
  const lines = () => { try { return readFileSync(memoryFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; } };
  const sid = (k) => `live-devscope-${k}-${Date.now()}`;
  const cfg = { debugSystemPrompt: true };
  const remembers = (ev) => ev.toolArgs.filter((t) => t.name === 'remember').map((t) => { try { return JSON.parse(t.arguments); } catch { return {}; } });
  const steps = {};

  // ① 读
  const r1 = await run(sid('read'), '我的论文模板在这台电脑上放在哪？只回答路径。', 240_000, cfg);
  const sp = r1.systemPrompt || '';
  const foldLine = /\(\d+ more entr(?:y applies|ies apply) only to other computers:[^)]*\)/.exec(sp)?.[0] || '';
  steps.read = {
    ok: !r1.error && r1.content.includes('template-here') && !r1.content.includes('template-there')
      && !!sp && !sp.includes('template-there') && !sp.includes('Fluent') && sp.includes('template-here') && !!foldLine,
    answer: r1.content, foldLine, promptHasOther: sp.includes('template-there'), promptHasOtherOs: sp.includes('Fluent'), captured: !!sp, error: r1.error,
  };

  // ② 只在这台
  const r2 = await run(sid('device'), '记住：这台电脑上装的是 TeX Live 2026，用 latexmk 编译。这只是这台电脑的情况，我别的电脑不是这样。', 240_000, cfg);
  const c2 = remembers(r2);
  const l2 = lines().find((l) => /TeX Live 2026/.test(l)) || '';
  steps.device = {
    ok: !r2.error && c2.some((a) => a.action === 'add' && a.appliesTo === 'this-computer') && l2.replace(/^- /, '').startsWith(`[${self}] `),
    line: l2, calls: c2, modelWroteLabel: c2.some((a) => typeof a.fact === 'string' && a.fact.trim().startsWith('[')), error: r2.error,
  };

  // ③ 这个系统
  // 首跑(11-06)用的是「我所有的 Mac 上都用 Homebrew」:模型按设计记进了画像(person,关于人本身、本来就跨设备),不是 Agent 记忆 ——
  // 这里换成你跑求解脚本时的环境事实(Agent 自己做事要知道的),只和系统有关
  const r3 = await run(sid('os'), `记住：你在 ${os} 上跑 CFD 求解脚本之前要先执行 ulimit -n 4096，这是 ${os} 系统的限制，我任何一台 ${os} 电脑都一样，别的系统上不用。`, 240_000, cfg);
  const c3 = remembers(r3);
  const l3 = lines().find((l) => /ulimit/.test(l)) || '';
  steps.os = {
    ok: !r3.error && c3.some((a) => a.action === 'add' && a.appliesTo === 'this-os') && l3.replace(/^- /, '').startsWith(`[${os}] `),
    line: l3, calls: c3, error: r3.error,
  };

  // ④ 所有设备
  // 对你做事方式的要求 → Agent 记忆、所有设备(不带标签)。记进画像(person)也算对:画像本来就不分设备
  const r4 = await run(sid('all'), '记住：你给我写代码时，注释一律用英文。', 240_000, cfg);
  const c4 = remembers(r4);
  const l4 = lines().find((l) => /注释|comment/i.test(l)) || '';
  const toPerson = c4.some((a) => a.scope === 'person' && (a.action === 'add' || a.action === 'update'));
  steps.all = { ok: !r4.error && c4.some((a) => (a.action === 'add' || a.action === 'update') && (!a.appliesTo || a.appliesTo === 'all')) && (toPerson ? !l4 : !!l4 && !/^(- )?\[/.test(l4)), line: l4 || (toPerson ? '(画像)' : ''), calls: c4, error: r4.error };

  writeFileSync(join(OUT, 'devscope-evidence.json'), JSON.stringify({ platform: process.platform, neg, self, other, os, seed, steps, finalMemory: lines() }, null, 2));
  const mark = (k) => `${k} ${steps[k].ok ? '✓' : '✗'}`;
  return {
    ok: Object.values(steps).every((s) => s.ok),
    detail: `${neg ? '负对照(不写设备表) · ' : ''}${['read', 'device', 'os', 'all'].map(mark).join(' · ')};折叠行「${steps.read.foldLine || '无'}」;` +
      `② ${steps.device.line || '没写'};③ ${steps.os.line || '没写'};④ ${steps.all.line || '没写'}${steps.device.modelWroteLabel ? ';⚠️模型自己写了方括号' : ''}`,
    output: [`【read】${steps.read.answer}`, `【device】${r2.content}`, `【os】${r3.content}`, `【all】${r4.content}`].join('\n\n'),
    toolCalls: [r1, r2, r3, r4].flatMap((r) => r.toolCalls),
  };
}
