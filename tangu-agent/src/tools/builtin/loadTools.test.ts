/**
 * load_tools × 情境 deferred(coding 预设):可解锁集合必须与目录/defs 过滤同一判定。
 * 2026-08-09 前只认静态 deferred:true——coding 目录里广而告之的工具(read_session/web_search 等)
 * 一律 "Unknown/not loadable",Codex 评审抓到的存量 bug。本文件钉死修后的行为。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import '../registry.js'; // 副作用:注册全部内置 provider(resolveTools 依赖注册表)
import { getToolDefinitions, listDeferredTools } from '../registry.js';
import { loadToolsProvider } from './loadTools.js';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
const profile = createTanguProfile({ sandboxMode: 'none' });
configureTangu({ host: stub, brain: stub, billing: stub, profile });
const tool = loadToolsProvider.tools()[0];
const baseCtx = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' };

describe('load_tools × CODING_PRESET_DEFERRED', () => {
  it('coding 预设:目录里的情境 deferred 工具(read_session/search_sessions/web_search)可解锁', async () => {
    const unlocked: string[] = [];
    const ctx = { ...baseCtx, preset: 'coding', unlockTools: (ns: string[]) => unlocked.push(...ns) } as any;
    const r = String(await tool.execute({ names: ['read_session', 'search_sessions', 'web_search'] }, ctx));
    expect(r).toContain('Loaded tool(s)');
    expect(r).not.toContain('Unknown/not loadable');
    expect(unlocked).toEqual(expect.arrayContaining(['read_session', 'search_sessions', 'web_search']));
  });

  it('already callable tools are reported as available, not unknown', async () => {
    const ctx = { ...baseCtx, unlockTools: () => {} } as any;
    const r = String(await tool.execute({ names: ['read_session'] }, ctx));
    expect(r).toContain('Already available');
    expect(r).not.toContain('Unknown/not loadable');
  });

  it('distinguishes a mixed batch of direct, deferred and unavailable tools', async () => {
    const unlocked: string[] = [];
    const ctx = { ...baseCtx, unlockTools: (ns: string[]) => unlocked.push(...ns) } as any;
    const r = String(await tool.execute({ names: ['read_session', 'calculator', 'not_a_tool'] }, ctx));
    expect(r).toContain('Already available: read_session');
    expect(r).toContain('Loaded tool(s): calculator');
    expect(r).toContain('Unavailable in this session: not_a_tool');
    expect(unlocked).toEqual(['calculator']);
  });
});


/**
 * E2(§五「延迟候选」):按 60 天 per-tool 使用率把低频面转 deferred —— browser 细粒度 ×8、
 * amadeus 日历 CRUD ×5、read_document / view_video / write_process_input / set_ui_setting /
 * self_brainstorm。本块钉的是「常驻面少了谁、目录里还看得见谁、一次 load_tools 能不能把一族取齐」,
 * 以及**没被延迟的入口**(desk_present / sketch / browser 三个入口)确实还在常驻面上。
 */
describe('E2:低频工具转 deferred(work 缺省档)', () => {
  // work 档 + GUI 客户端面:与 scripts/dump-tooldefs.mjs 的 `tangu-none:host+gui` 同一上下文
  // (uiCommands 是界面三工具的能力握手闸,不给就是零覆盖)。
  const guiCtx = { ...baseCtx, client: 'desktop/0.0.0', uiCommands: [], approvalMode: 'auto-edit', unlockTools: () => {} } as any;
  const faceNames = (): string[] => getToolDefinitions(guiCtx).map((t: any) => t.function.name);
  const catalogNames = (): string[] => listDeferredTools(guiCtx).map((d) => d.name);

  // 「解锁了哪些」按**集合精确相等**判,不用 arrayContaining:后者放行「顺手多解锁一个别的 deferred
  // 工具」——连坐一旦越组,模型下一轮就白拿一份没要过的工具头(评审 #9)。
  const sortedSet = (names: string[]): string[] => [...new Set(names)].sort();
  // 「新定义追加在末尾」按**逐字节前缀**判:toContain(name) 对「插在中间」是绿的,而插在中间
  // 会把后面所有工具头的字节整体位移 → 上游前缀缓存从插入点起全 miss(评审 #9)。
  const defBytes = (ctx: any): string[] => getToolDefinitions(ctx).map((t: any) => JSON.stringify(t));
  const defName = (raw: string): string => JSON.parse(raw).function.name;

  const DEFERRED = [
    'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back',
    'browser_press', 'browser_console', 'browser_screenshot',
    'amadeus_list_calendars', 'amadeus_list_events', 'amadeus_create_event', 'amadeus_edit_event', 'amadeus_delete_event',
    'read_document', 'write_process_input', 'set_ui_setting', 'self_brainstorm',
  ];
  // view_video 按宿主 ffmpeg/ffprobe 门控(没装就整个不在场)——不进本名单,免得 CI 上假红;
  // 它的 deferred 契约由本文件末尾「view_video 按 ffmpeg 门控」那一块自带假 ffmpeg 钉死(评审 #3)。

  it('转 deferred 的工具离开常驻面,但仍在「Additional Tools」目录里,且每条都带一句话理由', () => {
    const face = faceNames();
    const catalog = listDeferredTools(guiCtx);
    for (const n of DEFERRED) {
      expect(face, `${n} 应离开常驻面`).not.toContain(n);
      const row = catalog.find((d) => d.name === n);
      expect(row, `${n} 应在目录里`).toBeTruthy();
      expect(row!.hint.length, `${n} 的目录行要给模型一句话理由`).toBeGreaterThan(20);
    }
  });

  it('入口与高频面留在常驻:browser 三入口 / desk_present / sketch / load_tools 本身', () => {
    const face = faceNames();
    for (const n of ['browser_search', 'browser_navigate', 'browser_task', 'desk_present', 'sketch', 'load_tools',
      'amadeus_list_notes', 'read_file', 'run_bash', 'delegate', 'list_ui_commands']) {
      expect(face, `${n} 必须留在常驻面`).toContain(n);
    }
  });

  it('deferGroup 连坐:解锁 browser/日历任一成员即整族到位(少一趟往返)', async () => {
    const unlockedB: string[] = [];
    await tool.execute({ names: ['browser_click'] }, { ...guiCtx, unlockTools: (ns: string[]) => unlockedB.push(...ns) } as any);
    expect(sortedSet(unlockedB)).toEqual(sortedSet([
      'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back',
      'browser_press', 'browser_console', 'browser_screenshot',
    ]));

    const unlockedC: string[] = [];
    await tool.execute({ names: ['amadeus_list_events'] }, { ...guiCtx, unlockTools: (ns: string[]) => unlockedC.push(...ns) } as any);
    expect(sortedSet(unlockedC)).toEqual(sortedSet([
      'amadeus_list_calendars', 'amadeus_list_events', 'amadeus_create_event', 'amadeus_edit_event', 'amadeus_delete_event',
    ]));
    // 连坐只在组内(精确相等已覆盖,这条留着点名最容易串的那一个)。
    expect(unlockedB).not.toContain('amadeus_create_event');
  });

  it('read_document 走 PRESET_TABLE 的 work 档名单(定义在 hostExec.ts,本轮不改那文件)也能被 load_tools 解锁', async () => {
    const unlocked: string[] = [];
    const r = String(await tool.execute({ names: ['read_document'] }, { ...guiCtx, unlockTools: (ns: string[]) => unlocked.push(...ns) } as any));
    expect(r).toContain('Loaded tool(s)');
    expect(r).not.toContain('Unknown/not loadable');
    expect(unlocked).toContain('read_document');
    // 解锁后回到 defs **末尾**:解锁前那份是解锁后那份的逐字节前缀,新定义只追加在后面。
    const before = defBytes(guiCtx);
    const after = defBytes({ ...guiCtx, unlockedTools: new Set(['read_document']) });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map(defName)).toContain('read_document');
  });

  // 子代理(delegate)被剥掉 unlockTools(subAgent.ts)→ 没有 load_tools 这条取回通道,deferred
  // 工具对它「看不见且取不回」。read_document 必须例外常驻:delegate 的描述明说可做 batch file
  // analysis,PDF/Office 正是那里的典型输入,而 read_file 读二进制文档只有乱码且不给指路 ——
  // 不开这个口子,委派出去的文档分析拿回来的是静默的垃圾。
  it('子代理:read_document 回到常驻面,且这个口子只开给它一个', () => {
    const subFace = getToolDefinitions({ ...guiCtx, subAgentDepth: 1, unlockTools: undefined } as any).map((t: any) => t.function.name);
    expect(subFace, 'read_document 必须对子代理常驻').toContain('read_document');
    expect(subFace, '无 unlockTools → 仍不暴露 load_tools').not.toContain('load_tools');
    expect(subFace, '口子只开 read_document:其余 deferred 照旧隐藏').not.toContain('browser_click');
    expect(subFace).not.toContain('amadeus_create_event');
    // 主循环(非子代理)不受影响:read_document 仍按需装载
    expect(faceNames(), '父级仍是按需装载').not.toContain('read_document');
    // coding 档走的是另一份名单(CODING_PRESET_DEFERRED),同样要对子代理放行(这一档本轮之前就漏)
    expect(getToolDefinitions({ ...guiCtx, preset: 'coding', subAgentDepth: 1, unlockTools: undefined } as any).map((t: any) => t.function.name)).toContain('read_document');
  });
});


/**
 * plan mode × browser 控制族(Codex 评审 09-15 #2):PLAN_MODE_TOOLS 只放行 browser_snapshot /
 * browser_screenshot,click/type/scroll/back/press/console 整族在 resolveTools 里就被滤掉 ——
 * 它们在 plan mode 下**既不在目录里、也解锁不了**。browser_search 的描述因此只能承诺
 * 「目录里出现时再 load」,承诺「先 load_tools」会让模型在 plan mode 白烧一轮换回
 * "Unavailable in this session"。本块钉住这条契约的两端(措辞 × 真实工具面)。
 */
describe('plan mode:browser 控制族不可发现也不可解锁', () => {
  const guiCtx = { ...baseCtx, client: 'desktop/0.0.0', uiCommands: [], approvalMode: 'auto-edit', unlockTools: () => {} } as any;
  const planCtx = { ...guiCtx, planMode: true };

  it('目录里只剩 snapshot/screenshot;入口与 load_tools 仍常驻', () => {
    const catalog = listDeferredTools(planCtx).map((d) => d.name);
    expect(catalog, 'browser_snapshot 是 plan mode 白名单内的 deferred 工具').toContain('browser_snapshot');
    expect(catalog).toContain('browser_screenshot');
    for (const n of ['browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_press', 'browser_console']) {
      expect(catalog, `${n} 在 plan mode 不该出现在目录里`).not.toContain(n);
    }
    const face = getToolDefinitions(planCtx).map((t: any) => t.function.name);
    for (const n of ['browser_search', 'browser_navigate', 'load_tools']) {
      expect(face, `${n} 在 plan mode 必须常驻`).toContain(n);
    }
  });

  it('硬调 load_tools 取 browser_click:报 Unavailable,且一个都不解锁', async () => {
    const unlocked: string[] = [];
    const r = String(await tool.execute({ names: ['browser_click'] }, { ...planCtx, unlockTools: (ns: string[]) => unlocked.push(...ns) } as any));
    expect(r).toContain('Unavailable in this session: browser_click');
    expect(r).not.toContain('Loaded tool(s)');
    expect(unlocked).toEqual([]);
  });

  it('deferGroup 连坐不越过 plan 过滤:解锁 snapshot 只带出 screenshot', async () => {
    const unlocked: string[] = [];
    await tool.execute({ names: ['browser_snapshot'] }, { ...planCtx, unlockTools: (ns: string[]) => unlocked.push(...ns) } as any);
    expect(unlocked.slice().sort(), 'plan mode 过滤掉的成员不该被连坐带进来')
      .toEqual(['browser_screenshot', 'browser_snapshot']);
  });

  it('browser_search 的描述按「目录里出现时」措辞,不承诺一定解得开', () => {
    const desc = String((getToolDefinitions(planCtx) as any[]).find((t: any) => t.function.name === 'browser_search')?.function?.description || '');
    expect(desc).toContain('Additional Tools');
    expect(desc, '不许再承诺 "with load_tools first"').not.toContain('with load_tools first');
  });
});


/**
 * view_video 的 deferred 行为(Codex 评审 09-15 #3):该工具**还**按宿主 ffmpeg/ffprobe 门控,
 * 没装就整个不在场 —— 只断言「不在常驻面」会在无 ffmpeg 的 CI 上假绿(把 deferred:true 删掉也照样绿)。
 * 这里在临时目录放一对可被发现的假 ffmpeg/ffprobe 并前置进 PATH(viewVideo 的 findBin 只做
 * existsSync、不执行也不缓存),把能力门禁钉成真,再断言「离开常驻面 / 在目录里 / 能被 load_tools 解锁」。
 * 注:开发机上 extraBinDirs() 通常已能找到 homebrew 的 ffmpeg,假 PATH 在本地是冗余的 ——
 * 它挣的是 CI 那一份,别为此去动 extraBinDirs。
 */
describe('E2:view_video 按 ffmpeg 门控 + deferred(补齐 DEFERRED 名单外的那一条)', () => {
  const guiCtx = { ...baseCtx, client: 'desktop/0.0.0', uiCommands: [], approvalMode: 'auto-edit', unlockTools: () => {} } as any;
  let binDir = '';
  let prevPath: string | undefined;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'tangu-fakebin-'));
    const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe'];
    for (const n of names) writeFileSync(join(binDir, n), '', { mode: 0o755 });
    prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
  });
  afterAll(() => {
    // 同文件里别的块共用 process.env,必须逐字还原
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  it('ffmpeg 可见时:view_video 离开常驻面,仍在目录里,且可被 load_tools 解锁', async () => {
    // 能力条件先行:门禁关着的话「不在常驻面」是空真的,后面整条断言链都测不到 deferred 契约。
    // 先证「门开着」(目录里看得见),再去断言它为什么不在常驻面(评审 #9)。
    const row = listDeferredTools(guiCtx).find((d) => d.name === 'view_video');
    expect(row, '有 ffmpeg 就必须在「Additional Tools」目录里 —— 没有则是能力门禁把它整个滤掉了').toBeTruthy();
    expect(row!.hint.length, 'view_video 的目录行要给模型一句话理由').toBeGreaterThan(20);

    const face = getToolDefinitions(guiCtx).map((t: any) => t.function.name);
    expect(face, 'view_video 应按需装载(删掉 deferred:true 这里就该红)').not.toContain('view_video');

    const unlocked: string[] = [];
    const r = String(await tool.execute({ names: ['view_video'] }, { ...guiCtx, unlockTools: (ns: string[]) => unlocked.push(...ns) } as any));
    expect(r).toContain('Loaded tool(s)');
    expect(r).not.toContain('Unavailable in this session');
    expect(unlocked.slice().sort(), 'view_video 没有 deferGroup:只解锁它自己').toEqual(['view_video']);

    // 解锁后回到 defs **末尾**:解锁前那份是解锁后那份的逐字节前缀(插在中间 → 后面全体位移 → 前缀缓存全 miss)。
    const defBytes = (ctx: any): string[] => getToolDefinitions(ctx).map((t: any) => JSON.stringify(t));
    const before = defBytes(guiCtx);
    const after = defBytes({ ...guiCtx, unlockedTools: new Set(['view_video']) });
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length).map((raw) => JSON.parse(raw).function.name)).toContain('view_video');
  });

  // 负对照:同一份 ctx 只把 hostExec 能力关掉(isEnabledFor 的另一半门禁)—— view_video 应当
  // **整个不在场**:既不在常驻面,也不在目录里。没有这条,上面那句「不在常驻面」分不清是
  // deferred:true 起的作用还是能力门禁把它滤没了。
  it('负对照:hostExec 能力关掉 → view_video 连目录都进不去(不是靠 deferred 才不在常驻面)', () => {
    const noExec = { ...profile, capabilities: { ...profile.capabilities, hostExec: false } } as any;
    const offCtx = { ...guiCtx, profile: noExec, execMode: 'sandbox' };
    expect(getToolDefinitions(offCtx).map((t: any) => t.function.name)).not.toContain('view_video');
    expect(listDeferredTools(offCtx).map((d) => d.name)).not.toContain('view_video');
  });
});


/**
 * load_tools 的 sticky 契约(评审 09-15 #5):一次把目录里**剩下全部** deferred 工具解锁掉之后,
 * lockedCount===0 —— 旧判据会把 load_tools 从 defs **中间**删掉,解锁项又追加在末尾,于是工具 JSON
 * 从 load_tools 原来的位置起整体错位:「解锁前那份是解锁后那份的逐字节前缀」这条承诺当场作废,
 * 上游前缀缓存从该点全 miss。旧测试只解锁一个、环境里还剩别的未解锁项,踩不到这个反例。
 */
describe('load_tools sticky:解锁光了也不从 defs 中间消失', () => {
  it('一次解锁全部目录项:load_tools 仍在原位,前后两份仍是逐字节前缀关系', () => {
    // 同一个 ctx 对象跨两次取 defs —— 三个 loop(agentLoop / groupChat / subAgent)都是这么用的,
    // sticky 标志就落在这份 run 级 ctx 上。
    const ctx = { ...baseCtx, client: 'desktop/0.0.0', uiCommands: [], approvalMode: 'auto-edit', unlockTools: () => {} } as any;
    const bytes = (): string[] => getToolDefinitions(ctx).map((t: any) => JSON.stringify(t));
    const nameOf = (raw: string): string => JSON.parse(raw).function.name;

    const before = bytes();
    expect(before.map(nameOf), '前提:有未解锁项时 load_tools 本来就在').toContain('load_tools');
    const all = listDeferredTools(ctx).map((d) => d.name);
    expect(all.length, '前提:目录里得真有按需工具可解锁').toBeGreaterThan(3);

    ctx.unlockedTools = new Set(all); // 一次解锁**全部**(lockedCount 归零的那一刻)
    const after = bytes();
    expect(after.map(nameOf), 'load_tools 不该因为「没东西可解锁了」被撤走').toContain('load_tools');
    expect(after.slice(0, before.length), '解锁前那份必须仍是解锁后那份的逐字节前缀').toEqual(before);
    expect(new Set(after.slice(before.length).map(nameOf)), '新增的恰好是全部被解锁项,且都在末尾').toEqual(new Set(all));
  });

  it('负对照:本 run 从未露过面的 ctx(无 unlockTools)不会因 sticky 平白多出 load_tools', () => {
    const noUnlock = { ...baseCtx, client: 'desktop/0.0.0', uiCommands: [], approvalMode: 'auto-edit' } as any;
    expect(getToolDefinitions(noUnlock).map((t: any) => t.function.name)).not.toContain('load_tools');
    // 解锁光了也一样:sticky 只让**露过面的**留下,不会凭空把它塞给不支持解锁的调用方。
    noUnlock.unlockedTools = new Set(listDeferredTools(noUnlock).map((d) => d.name));
    expect(getToolDefinitions(noUnlock).map((t: any) => t.function.name)).not.toContain('load_tools');
  });
});
