/**
 * 工作预设表(PRESET_TABLE):agentLoop / toolRegistry / sketch / skillLoadout 按 preset 分档时的**唯一真源**,
 * 取代散落的 `if (preset === 'coding')`。加第 N 枚 preset = 加一行,不许在 agentLoop 里为它单开分支
 * (方案 §7.2:任何需要单开 if 的需求,说明它不该是 preset,先问它是不是正交轴)。
 *
 * ⚠️ 本文件零运行时依赖(纯数据):toolTypes/appProfile 只 import type;toolRegistry/sketch 值引用它,
 *    它绝不能反向引用工具/提示词模块,否则成环。提示词侧的分档函数住 profiles/promptSections.ts。
 *
 * preset 是**会话事实**(借 DSH agent-preset-locked):建会话时定、空白会话可改、跑过一轮后锁定——
 * 解析与锁在 agentLoop.runLoop 开头读写会话 agent_config 的那一块(与 agentSlug 写穿同处)。
 */

export type Preset = 'coding' | 'chat';

/** 把任意输入收成合法 preset;非法/缺省 = undefined(= work,行为零变化)。 */
export function parsePreset(v: unknown): Preset | undefined {
  return v === 'coding' || v === 'chat' ? v : undefined;
}

export interface PresetSpec {
  /** 工具面(硬闸,在 toolRegistry.resolveTools 的 add() 里生效;工具根本不进 out map → defs 没有、目录没有、load_tools 解锁不了)。 */
  toolFace: {
    /** 正向常驻+按需集合:非空时不在集合里的工具一律拒(默认拒:明天新加的工具不会自动漏进来)。空 = 不约束。 */
    face: ReadonlySet<string>;
    /** true = `t.mode === 'host'` 整族拒,**不靠名单**(host 侧同名的 read_file/write_file 打真实磁盘)。 */
    rejectHostMode: boolean;
    /** execMode==='host' 时额外拒的 mode:'both' 工具(按 cwd 爬用户真实磁盘的只读工具)。 */
    hostDiskHidden: ReadonlySet<string>;
    /** 情境 deferred:仍列「Additional Tools」目录、load_tools 可解锁,只是不占常驻 defs。 */
    deferred: ReadonlySet<string>;
  };
  /** 默认 agent 的陪伴人格(systemPrompt/SOUL/HARNESS)是否抑制。 */
  persona: 'keep' | 'suppress';
  /** 是否注入 PERSISTENCE_SECTION(「别停,做完」)。 */
  persistence: boolean;
  /** responseStyleSection 是否关掉进度播报(preamble)。 */
  noPreamble: boolean;
  /** sketch 工具 + SKETCH_SECTION(段与工具同门禁,见 sketch.ts)。 */
  sketch: boolean;
  /** 用户可扩展技能体系(技能目录段 + use_skill)。 */
  skills: boolean;
  /** host 附加段(Personal Folder / Upcoming Schedule)。 */
  hostExtras: boolean;
  /** host execMode 下的工作区上下文注入(项目级 AGENTS.md/CLAUDE.md、cwd 顶层文件清单、git 状态)。
   *  chat 关:D11 形态(ii)下这些读的全是用户真实磁盘(creview 09-07 E3);与 hostExtras 分列,coding 的项目上下文不受影响。 */
  hostWorkspace: boolean;
  /** 计划模式可用(chat 关:exit_plan_mode 不在其工具面,开了就死锁)。 */
  planMode: boolean;
  /** 群聊编排可用(chat 关:runGroupChat 里的参与者拿的是不带 preset 的全量工具面,会绕过 chat 硬闸)。 */
  groupChat: boolean;
  /** 自定义工具(HTTP/JS)与 MCP 工具是否装载(chat 关:外部副作用不可知,照 planMode 的姿势整体跳过)。 */
  externalTools: boolean;
  /** 可见正文 verbosity(仅 Responses 直连上 wire)。 */
  verbosity?: 'low';
}

/** coding 预设下追加转 deferred 的产品面工具(仍在「Additional Tools」目录里,load_tools 可解锁):
 *  WB-Bench 取证——48 工具全暴露时,封闭 bench 里模型调了 107 次 web、80 次 log_event、139 次
 *  use_skill,纯烧迭代/带偏任务。coding 任务的常驻面只留文件/shell/进程/todo/委派。 */
export const CODING_PRESET_DEFERRED: ReadonlySet<string> = new Set([
  'browser_search', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_back', 'browser_press', 'browser_console', 'browser_screenshot',
  'browser_task', 'web_search', 'web_fetch',
  'amadeus_list_notes', 'amadeus_list_calendars', 'amadeus_list_events',
  'amadeus_create_event', 'amadeus_edit_event', 'amadeus_delete_event',
  'inbox_send', 'display_file', 'read_session', 'search_sessions', 'read_document',
  'remember', 'log_event', 'read_log',
]);

/** chat 常驻面(方案 §3.2 A 档):10 个 + GUI 端的 sketch。⚠️ 白名单只保证「不被 chat 砍掉」,不保证在场——
 *  run_python/pip_install 另受 profile.features.sandbox 门禁,sketch 另受 ctx.client 门禁,
 *  read_file/write_file/list_files 只认 mode:'sandbox' 的工作区版(host 版被 rejectHostMode 整族拒)。 */
export const CHAT_PRESET_RESIDENT: ReadonlySet<string> = new Set([
  'run_python', 'web_fetch', 'web_search', 'read_file', 'display_file', 'pip_install', 'write_file',
  'load_tools', 'list_files', 'get_datetime', 'sketch', 'remember',
]);

/** chat 按需面(方案 §3.3 B 档):目录一行,load_tools 可解锁。
 *  calculator / generate_image 是静态 deferred(方案分区时在快照里不可见),纯计算/生图无副作用,一并列入。 */
export const CHAT_PRESET_DEFERRED: ReadonlySet<string> = new Set([
  'search_sessions', 'read_session', 'todo_write', 'todo_read', 'search_files', 'glob_files',
  'amadeus_list_notes', 'amadeus_read_note', 'amadeus_list_calendars', 'amadeus_list_events',
  'calculator', 'generate_image', 'read_log', 'log_event',
]);

/** D11 形态:chat 落在 host execMode 时(桌面 standalone 的 rootless 会话仍是 sandbox,这里是纵深防御),
 *  search_files/glob_files 按 cwd 爬用户真实磁盘且由模型发起 → 一并拒;generate_image 是 mode:'both' 却在 host 下
 *  往 cwd/generated/ 写真实磁盘(creview 二轮 #2)→ 同拒。display_file 不入列(交付原语)。 */
export const CHAT_HOST_DISK_HIDDEN: ReadonlySet<string> = new Set(['search_files', 'glob_files', 'generate_image']);

const EMPTY: ReadonlySet<string> = new Set();

/** work(preset 缺省)= 今天的行为,逐字节零变化。 */
const WORK: PresetSpec = {
  toolFace: { face: EMPTY, rejectHostMode: false, hostDiskHidden: EMPTY, deferred: EMPTY },
  persona: 'keep',
  persistence: true,
  noPreamble: false,
  sketch: true,
  skills: true,
  hostExtras: true,
  hostWorkspace: true,
  planMode: true,
  groupChat: true,
  externalTools: true,
};

export const PRESET_TABLE: Record<Preset, PresetSpec> = {
  coding: {
    toolFace: { face: EMPTY, rejectHostMode: false, hostDiskHidden: EMPTY, deferred: CODING_PRESET_DEFERRED },
    persona: 'suppress',
    persistence: true,
    noPreamble: true,
    sketch: true,
    skills: true,
    hostExtras: false,
    hostWorkspace: true,
    planMode: true,
    groupChat: true,
    externalTools: true,
    verbosity: 'low',
  },
  chat: {
    toolFace: {
      face: new Set([...CHAT_PRESET_RESIDENT, ...CHAT_PRESET_DEFERRED]),
      rejectHostMode: true,
      hostDiskHidden: CHAT_HOST_DISK_HIDDEN,
      deferred: CHAT_PRESET_DEFERRED,
    },
    persona: 'keep',
    persistence: false,
    noPreamble: false,
    sketch: true,
    skills: false,
    hostExtras: false,
    hostWorkspace: false,
    planMode: false,
    groupChat: false,
    externalTools: false,
    verbosity: 'low',
  },
};

/** 按 preset 取表行;缺省 = work。运行时非法值(any 调用方传 'bogus')同样回落 work,不返回 undefined 让下游解引用崩(creview 09-07 E9)。 */
export function presetOf(preset: Preset | undefined): PresetSpec {
  return (preset && PRESET_TABLE[preset]) || WORK;
}
