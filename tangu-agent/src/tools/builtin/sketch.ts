/**
 * sketch —— agent 在对话流里画一张可交互的 HTML 卡片(GUI 三端内联渲染)。
 * 载荷走工具**参数**:tool_calls 原样落 JSONB 不截断,前端从持久化参数 back-fill 重建
 * (exit_plan_mode 同款),零 schema 变更零迁移;result 只回短确认(display_file 同款)。
 * 渲染面契约(前端 SketchCard):sandbox iframe 仅 allow-scripts + 内层 CSP default-src 'none'
 * —— JS 可跑,无网络、无宿主 API、无导航;描述里必须把这个能力包络讲给模型。
 * 门禁:sketchEnabledFor 按 ctx.client 白名单(desktop|web)+ 排除子代理。CLI/TUI/自动化等无
 * client tag 的 run 不注册(default-deny);通道 run 可能带 Desktop 宿主 tag,故另由 channelSession
 * 明确排除(远程面只渲染纯文本)。
 * ⚠️移动端(Capacitor 原生 App,client=mobile/*)刻意排除:其 WebView 的 addJavascriptInterface
 * 原生桥(Filesystem/Preferences/Browser 插件)对子 iframe 可见,sandbox/CSP 拦不住 JS 桥对象——
 * 卡内脚本能直接删文件/清 token。渲染层(SketchCard)另有 Capacitor-native 拒渲染兜底(跨端看历史卡)。
 * ⚠️子代理排除:runSubAgent 展开父 ctx 会带上 client,但子代理的卡进不了主消息(画了用户看不见)。
 * ⚠️描述里的 --fs-* token 名与前端 `desktop/frontend/src/components/sketchWrapper.ts` 的
 * SKETCH_VARS **必须逐字一致**(跨仓两份,没有共享包;改一边就得改另一边,否则模型写的变量解析不出来)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';
import type { Tool } from '../../core/types.js';
import { presetOf } from '../../core/presetTable.js';

/** GUI 客户端面(routes/runs.ts CLIENT_TAG_RE 的子集;移动原生 App 见头注刻意排除)。 */
const GUI_CLIENT_RE = /^(desktop|web)\//;

/** 10-20 改名:模型读到的工具名、卡内脚本接口都换成 Intelligent UI 的说法(对用户本来就叫 Intelligent UI 卡)。
 *  引擎与客户端之间(上屏事件、落库的会话记录、卡里的 HTML)仍叫 sketch / forsionSketch:已发的客户端只认这套,而会话会在
 *  新旧两版之间来回打开 —— 按客户端分名会让跨版本看历史丢卡、旧客户端跑不动新接口名(Codex 10-20 评审)。
 *  所以只在两头换:模型产出 → 往外发(htmlCardToWire),历史 → 发给模型(withHtmlCardName)。旧名经 TOOL_NAME_ALIASES 照样能调。
 *  ponytail: 线上协议留旧名;旧客户端都升级之后再把这一层换掉。 */
export const HTML_CARD_TOOL = 'intelligent_ui_html';
export const LEGACY_HTML_CARD_TOOL = 'sketch';
const CARD_API = 'forsionIntelligentUi', LEGACY_CARD_API = 'forsionSketch';
export const isHtmlCardTool = (name: string): boolean => name === HTML_CARD_TOOL || name === LEGACY_HTML_CARD_TOOL;
type Call = { function: { name: string; arguments: string } };
const toModel = <C extends Call>(c: C): C => c.function?.name === LEGACY_HTML_CARD_TOOL
  ? { ...c, function: { ...c.function, name: HTML_CARD_TOOL, arguments: String(c.function.arguments ?? '').replaceAll(LEGACY_CARD_API, CARD_API) } } : c;
/** 模型产出的一次 HTML 卡调用改成线上的样子(原地改):工具名回 sketch,HTML 里的新接口名换成旧名(新渲染层两个名字是同一个对象)。
 *  ⚠️ tool_stream 的参数增量不换(接口名可能被切在两段之间):旧客户端的草稿卡里脚本可能报错,收口的那次 tool_call 是换过的。 */
export function htmlCardToWire(call: Call): void {
  if (!isHtmlCardTool(call.function.name)) return;
  call.function.name = LEGACY_HTML_CARD_TOOL;
  const raw = call.function.arguments;
  if (typeof raw !== 'string') return;
  // 按解码后的 html 换:模型可能把接口名写成 JSON 转义(forsion\u0049ntelligentUi),只换原文会漏(Codex 10-20)
  try {
    const args = JSON.parse(raw);
    if (args && typeof args.html === 'string' && args.html.includes(CARD_API)) call.function.arguments = JSON.stringify({ ...args, html: args.html.replaceAll(CARD_API, LEGACY_CARD_API) });
  } catch { call.function.arguments = raw.replaceAll(CARD_API, LEGACY_CARD_API); } // 截断的参数:原文照换,执行层会报错
}
/** 发给模型的历史反过来换成新名、新接口名(工具表里只有新名);Responses 原样回放的 providerItems 里的 function_call 一样。
 *  没有旧名时原样返回(不另造数组)。不改传入的对象。 */
export function withHtmlCardName<M extends { tool_calls?: Call[]; providerItems?: any[] }>(messages: M[]): M[] {
  const oldItem = (it: any): boolean => it?.type === 'function_call' && it.name === LEGACY_HTML_CARD_TOOL;
  const old = (m: M): boolean => !!m.tool_calls?.some((c) => c.function?.name === LEGACY_HTML_CARD_TOOL) || !!m.providerItems?.some(oldItem);
  if (!messages.some(old)) return messages;
  return messages.map((m) => !old(m) ? m : {
    ...m,
    ...(m.tool_calls ? { tool_calls: m.tool_calls.map(toModel) } : {}),
    ...(m.providerItems ? { providerItems: m.providerItems.map((it) => oldItem(it) ? { ...it, name: HTML_CARD_TOOL, arguments: String(it.arguments ?? '').replaceAll(LEGACY_CARD_API, CARD_API) } : it) } : {}),
  });
}

/** ponytail: 256K 字符上限(参数进上下文,模型自会节制;超了让它精简)。真需要大卡再谈外置存储。 */
const MAX_SKETCH_HTML_CHARS = 262_144;

/** 用户的「可视化多少」档位(对标 ChatGPT「Layout and visuals」):渲染端 UI_SETTINGS.visuals 随每次 run 的
 *  ui_settings 快照上送,模型也能经 set_ui_setting 改。auto=缺省;less=只在用户明确要图时画(本轮隐式信号与收尾
 *  补催都不触发,另注一句提示);off=工具与提示段一起撤下。未知值一律按 auto —— 老客户端不送这项不该少功能。 */
export type VisualsPref = 'auto' | 'less' | 'off';
export function visualsPrefOf(uiSettings?: Record<string, { value: string }> | null): VisualsPref {
  const v = uiSettings?.visuals?.value;
  return v === 'less' || v === 'off' ? v : 'auto';
}

/** 单一判定源:isEnabledFor 与 agentLoop 的 SKETCH_SECTION 注入共用,免两处条件漂移。
 *  结构化入参而非 ToolContext:agentLoop 拼系统提示时(第 3b 段)toolCtx 还没造出来。
 *  ⚠️planMode:计划模式有一道**集中的只读工具过滤**,sketch 本来就不在其白名单里 —— 这里跟着
 *  排除,是为了让「提示段在场 ⟺ 工具在场」这条不变式在计划模式下也成立(否则模型照着提示段
 *  去调一个不存在的工具,白烧一轮)。单测钉住两边配对。 */
export function sketchEnabledFor(ctx: Pick<ToolContext, 'client' | 'subAgentDepth' | 'planMode' | 'channelSession' | 'preset' | 'uiSettings' | 'visuals'>): boolean {
  // preset 位(PRESET_TABLE.sketch):chat 今天保留 sketch(D15),TTFT 验收线不达标时第一刀就是翻这一位——
  // 段与工具经同一判定一起关,不许只裁一头。visuals=off 同理:用户关了可视化,工具与段一起缺席。
  // ⚠️ 档位读 run 冻结的 ctx.visuals(agentLoop 拼提示时取一次),不读会被 set_ui_setting 回执就地改掉的 uiSettings:
  //    否则 run 中途 auto→off 会变成「提示段还在催画、工具执行却拒绝」。没冻结的调用方(子代理展开 / 老路径)才现算。
  return GUI_CLIENT_RE.test(ctx.client || '') && !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.planMode && !ctx.channelSession
    && presetOf(ctx.preset).sketch && (ctx.visuals ?? visualsPrefOf(ctx.uiSettings)) !== 'off';
}

/**
 * 系统提示段:同时管「什么时候画」和「成品的下限」。经 agentLoop 直接注入(不进
 * promptSections.guidance——per-app promptGuidance 是整段替换,会静默丢掉),且与工具
 * 同门禁,CLI run 不注入。视觉语法是从 lieflat-charts 里抽出的「数据诚实 + 编辑部密度」,
 * 但不把整份 skill 塞进每轮上下文;沙箱也无法用 gallery 的外链图库,故在此给出可执行的内联 SVG 配方。
 */
export const SKETCH_SECTION = `## Visual cards

Use \`intelligent_ui_html\` when seeing or manipulating a relationship materially helps the answer: compare
options, explore a trend, explain a process, inspect a proposed interface, or try a small simulator.
Do not wait for the user to say "draw" when interaction would help. Use prose for a single fact,
Markdown for a requested table, and normal project/file tools when the deliverable is an app or file.
Never add a visualization just because an answer contains three values or steps.

### Composition contract

Decide the one question the card answers, then choose one visual grammar:
- comparison/ranking -> directly labelled horizontal bars, dots, or a compact comparison table
- change over time -> a line/area or milestone timeline with an honest scale and labelled extrema
- part to whole -> a 100-unit field or one stacked strip; show the denominator
- flow/process -> a left-to-right path with numbered stages and restrained connectors
- hierarchy/architecture -> aligned layers or a tree; make direction and boundaries unambiguous
- choice/decision -> a matrix with explicit criteria and one clearly explained emphasis

Choose the smallest useful composition. A chart needs a concise title, units, readable labels and
honest scales; a simulator needs compact controls and one dominant visual. Do not force every card
into a title/subtitle/metrics/source template. Put sources and assumptions in a short caption only
when needed. Keep the outer surface transparent; do not wrap plots in panels or add decorative KPI
rows. Use one accent for one measure, neutral guides and meaningful labels. Never invent data.

Compose from the built-in parts so every card looks like one family: \`fs-chart\` (bar or line),
\`fs-flow\` (process), \`fs-compare\` (options side by side, each with an optional follow-up button),
\`fs-choice\` (a question with answer buttons or checkboxes that send the pick as the user's next
message) and \`fs-checklist\` (tickable list, ticks persist on this device). Each takes one JSON
script; load the bundled \`visualize\` skill for the schemas. Prefer them over hand-built markup,
and never add inline \`style\` attributes, custom colors or your own button/checkbox styling: the host
owns typography, spacing, theme and responsive layout. Use custom SVG only for multi-series plots or
arbitrary graphs. When the content is a short list or one sentence, answer in prose instead.

Use the supplied \`.fs-*\` styles and \`--fs-*\` variables. Shared controls: \`fs-controls\`,
\`fs-field\` (wrapping label), \`fs-input\`, \`fs-select\`, \`fs-range\`, \`fs-check\` (wrapping label)
and \`fs-button\`. Put a range's current value in an \`output\` beside its label. Keep controls native,
labelled and keyboard accessible. \`fs-tabs[role="tablist"]\` with button[role="tab"], aria-selected,
aria-controls and matching role="tabpanel" elements has built-in click/arrow-key behavior.

Fit widths from 320px to about 700px: wrap controls, stack panels, keep supporting text at least
11px, and measure an SVG's actual container with ResizeObserver instead of shrinking a fixed
viewBox and its labels. Use role="img" and an accessible name on visual fields; use aria-live="polite"
for changed results. Essential actions must work without hover. Honor prefers-reduced-motion.

For stateful interactions, read \`window.forsionIntelligentUi.state\` at startup (null on first use), validate
its shape, then render. After user input call \`window.forsionIntelligentUi.setState(jsonValue)\` to replace
a snapshot up to 16 KiB. Store only choices needed to restore the view, not secrets or derived data.
This state is local to this card on this device; it does not reach the model or start a conversation.
Listen for \`forsion:themechange\` when canvas needs repainting; SVG CSS updates automatically.

The card renders progressively while you write it: put the headline and the markup first and every
\`<script>\` block last, so the structure is visible before the behavior arrives.

Buttons that change the answer: in a click handler call \`window.forsionIntelligentUi.ask("...")\` with the
follow-up the user would type ("explain the second stage", "show the pessimistic case"). It is sent as
the user's next visible message in this conversation, one per click; never call it on load or from a
timer. Use it for choices that need a new answer; keep recomputation that needs no new answer inside
the card. \`window.forsionIntelligentUi.copy(text)\` (also click-only) copies text such as a shopping list.

Before calling \`intelligent_ui_html\`, check that every control works, all queried elements exist, labels fit,
light/dark themes work, and the first render is useful. Afterwards give only the takeaway or caveat
not already visible. For complex charts or interactions, use the bundled \`visualize\` skill.`;

/** visuals=less 时追加在 SKETCH_SECTION 之后:常驻段仍在(用户点名要图时成品下限不变),但「不等用户说画」那条让位。 */
export const SKETCH_LESS_NOTE = `The user has set interface visuals to "less": call \`intelligent_ui_html\` only when they explicitly ask for a
chart, diagram, card, or interactive view in this turn; otherwise answer in prose.`;

export type SketchTurnSignal = {
  /** explicit = 用户点名要图;implicit = 比较 / 流程 / 数据形状;actionable = 要照着做、逐项勾、从里面挑的回答(计划、清单、几样里选一个、做法);
   *  shape = 以上都没命中的普通消息:不替模型判断,只让它按「答案会长什么样」自己定(跟进句、没有关键词的问法都落在这儿)。 */
  kind: 'explicit' | 'implicit' | 'actionable' | 'shape';
  section: string;
};

const SKETCH_OPTOUT_RE = /(?:不要|不用|无需|别)(?:画|绘制|图表|可视化|\s*sketch)|(?:只要?|仅)(?:用)?(?:文字|纯文字|代码)|\b(?:text[ -]?only|no (?:chart|diagram|visuals?|sketch))\b/i;
const SKETCH_EXPLICIT_RE = /(?:画|绘制|生成|做|给我|用)[^。！？\n]{0,48}(?:图|图表|示意图|架构图|流程图|时序图|关系图|时间线|看板|可视化|sketch)|(?:请|帮我)?可视化|\b(?:draw|visuali[sz]e|make|create|render|show)\b.{0,32}\b(?:chart|diagram|flowchart|timeline|wireframe|mockup|visual|sketch)\b|\b(?:diagram|flowchart|wireframe)\s+(?:this|it|the)\b/i;
const SKETCH_RELATION_RE = /(?:比较|对比|排名|趋势|变化|演变|分布|构成|前后|步骤|流程|架构|结构|层级|关系|状态机|生命周期|用户旅程|路线图|时间线|决策矩阵|布局|版式|配色)|\b(?:compare|comparison|versus|vs\.?|rank|ranking|trend|distribution|composition|before and after|steps?|flow|process|architecture|hierarchy|relationship|state machine|lifecycle|journey|roadmap|timeline|decision matrix|layout|palette)\b/i;
const SKETCH_INTERACTIVE_RE = /(?:计算器|滑块|筛选|过滤器|切换器|交互式)|\b(?:calculator|slider|filter|toggle|interactive)\b/i;
const SKETCH_ANALYZE_RE = /(?:分析|对比|比较|趋势|增长|下降|变化|数据|指标)|\b(?:analy[sz]e|compare|trend|growth|decline|change|data|metric)\b/i;
// 没有「图」的字眼、但答案是一份要照着做 / 逐项勾 / 从里面挑的东西(2026-10-11 用户反馈:没明说就不出卡)。
// 只收指向明确的说法:「怎么做」「计划」这类在 agent 对话里天天出现的词不收(「接下来怎么做」「按计划继续」不是要一张卡)。
const SKETCH_ACTIONABLE_RE = /(?:行程|攻略|日程|安排|清单|采购|准备(?:些|点|哪些)?(?:什么|啥)|[带买](?:些|点|哪些)?(?:什么|啥)|哪(?:个|款|种|家|台|部|本)(?:更|好|比较|最|合适|值得|划算)|(?:选|买|用|换|去|学|订|建议|推荐)哪(?:个|款|种|家|台|部|本)|怎么选|如何选|纠结|值不值|要不要(?:买|换|选)|推荐|教我|做法|教程|食谱|菜谱)|\b(?:itinerary|checklist|packing list|shopping list|to-?do list|(?:meal|study|workout|travel|trip) plan|plan (?:a|an|my|our|the)|recipe|step[- ]by[- ]step|walk me through|pros and cons|which (?:one|should|is better|would you)|should i (?:buy|get|choose|pick|go)|recommend|what (?:do|should|will) (?:i|we) (?:need|bring|buy|pack|cook|make|prepare))\b/i;
// 两种消息不发 actionable:让我改 / 查 / 讲代码的(比下面那条窄 ——「主要写代码,买哪台笔记本」里的「写代码」不该把卡挡掉),
// 和让我处理一段现成文字的(翻译、润色、总结:命中的词多半在那段文字里,不是用户的请求)。「还是」不进词表:它多半是「仍然」的意思。
const SKETCH_ACTIONABLE_SKIP_RE = /(?:修复|改代码|重构|编译|报错|调试|翻译|译成|润色|改写|校对|总结|概括|摘要)|(?:解释|讲解|分析|看看|读)[^。！？\n]{0,12}(?:代码|函数|脚本)|\b(?:fix|refactor|compile|typecheck|unit test|bug|debug|translate|proofread|rewrite|rephrase|paraphrase|summari[sz]e)\b|\b(?:explain|review|walk me through|go through)\b[^.?!\n]{0,40}\b(?:code|function|class|script|diff|commit)\b|\.(?:[cm]?[jt]sx?|py|rs|go|java|swift)\b/i;
const SKETCH_CODE_FOCUS_RE = /(?:修复|改代码|重构|实现|写代码|编译|测试|报错)|\b(?:fix|refactor|implement|code|function|class|compile|typecheck|unit test|bug)\b|\.(?:[cm]?[jt]sx?|py|rs|go|java|swift)\b/i;

/**
 * 本轮视觉信号:常驻段负责通识,这里用很窄的语义启发式给当前请求一次额外提醒。
 * 不返回用户原文,不做 LLM 分类器,不因文中单个数字或代码里的 compare 误触发。
 */
export function sketchTurnSignalFor(message: string, visuals: VisualsPref = 'auto', nativeUi = false, computed = false): SketchTurnSignal | undefined {
  const tool = nativeUi ? '`intelligent_ui` or `intelligent_ui_html`' : '`intelligent_ui_html`';
  const text = String(message || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || SKETCH_OPTOUT_RE.test(text)) return undefined;

  if (SKETCH_EXPLICIT_RE.test(text)) {
    return {
      kind: 'explicit',
      section:
        '## Visual-first note for this turn\n' +
        `The user explicitly asked for a visual deliverable. Call ${tool} before finishing; do not substitute an ASCII diagram, a Markdown table, or a prose description unless the user also explicitly requested that format.`,
    };
  }
  // less:只认明确要求;隐式信号(比较 / 流程 / 数据形状)不再提醒,收尾补催也随之缺席(它只看这个信号)。
  if (visuals === 'less') return undefined;

  const relation = SKETCH_RELATION_RE.test(text);
  const interactive = SKETCH_INTERACTIVE_RE.test(text);
  const numbers = text.match(/(?:^|[^\p{L}\p{N}])[-+]?(?:\d{1,3}(?:[,_ ]\d{3})+|\d+)(?:\.\d+)?%?/gu)?.length ?? 0;
  const dataShape = numbers >= 3 && SKETCH_ANALYZE_RE.test(text);
  if ((relation || interactive || dataShape) && !(SKETCH_CODE_FOCUS_RE.test(text) && !interactive)) {
    return {
      kind: 'implicit',
      section:
        '## Visual-first note for this turn\n' +
        `This request contains a comparison, sequence, structure, data shape, or interaction that is faster to understand visually even though the user may not have said "draw". Default to calling ${tool} as part of the answer. Skip only if closer inspection shows that the relationship is trivial or the actual deliverable is code/a file rather than an explanation.` +
        (nativeUi && computed ? ' A calculator, converter, budget, step guide or quiz is a computed `intelligent_ui` document (version 2); keep `intelligent_ui_html` for charts, diagrams and animations.' : ''),
    };
  }
  const skip = SKETCH_ACTIONABLE_SKIP_RE.test(text);
  if (!SKETCH_ACTIONABLE_RE.test(text) || skip) {
    // 改 / 查 / 讲代码的、处理现成文字的、和「继续」「好的」这种三个字以内的应答不发:它们在 agent 对话里天天出现,答案不会是一份可读的东西。
    return nativeUi && !skip && !SKETCH_CODE_FOCUS_RE.test(text) && [...text].length >= 4 ? { kind: 'shape', section: computed ? SHAPE_NOTE_COMPUTED : SHAPE_NOTE } : undefined;
  }
  return {
    kind: 'actionable',
    section:
      '## Visual-first note for this turn\n' +
      'The answer to this request is something the user will follow, tick off or choose from (a plan or itinerary, things to prepare or buy, a pick among options, a procedure), even though they did not ask for a card. ' +
      (nativeUi
        ? 'Default to answering with `intelligent_ui`: inputs for what they can adjust (people, days, the option picked), a checklist for things to do, bring or buy, a comparison for the options, disclosures for longer explanations. ' + (computed ? COMPUTED_SHAPES + ' ' : '') + VIEW_IS_THE_ANSWER
        : 'Default to answering with an `intelligent_ui_html` card built from `fs-checklist`, `fs-compare` or `fs-choice`. Keep the prose around it to a short takeaway.') +
      ' Skip the card only if the complete answer is a sentence or two, or the user wants something carried out (code or files changed, a task or calendar entry created) rather than an answer to read.',
  };
}

// 没命中任何词表的普通消息(2026-10-13,对标 ChatGPT 的 18 句同题:该出的 13 条只出 5 条,跟进 4 条只出 1 条)。
// 词表只读得到最后一句话的字面,「那四次挥手呢」「预算一千五以内呢」「晚饭吃什么」里没有可抓的词;这里不再猜,
// 把判断交给看得见整段对话的模型:按答案的形状定,并写明什么时候不出。只在原生文档可用时发(sketch 卡太重,不值得为清单起一张)。
// ⚠️「先写一段话、再调用工具」这种说法别再用:真模型第 1 次(10-13)里 GPT-6 Luna 有一半写完那段话(「下面的清单可以逐项勾选」)就收尾了,卡没出。
//    开头那段结论放进文档当第一个文字块 —— 整条回答是一份文档,模型只做一次调用,文字块先于其他区块上屏。
const VIEW_IS_THE_ANSWER = 'The view IS the answer: make the call first, without announcing it in chat text. Its first block is a `text` block (no title) with your conclusion or recommendation and what you assumed; when an assumption would change the answer, give it a choice input and end the document with one model action that redoes the answer for the picked values (each input sits in exactly one controls block; inputs that only feed that action go in a controls block right before it). A view needs at least one block that is not text: an answer that would be text blocks only is plain chat text. After the call, stop: add one short line only for a caveat the view does not contain, and never restate the conclusion.';
const SHAPE_NOTE = `## Answer-shape note for this turn
Choose the form of this answer from what the answer will contain, not from the wording of the request. A short follow-up ("what about the other one", "make day two lighter") continues the subject of the earlier turns and keeps their form.
- The whole answer is a sentence or two, a piece of writing the user asked for (an email, a message, a translation), code, or something to carry out (change files, run a command, create a task or event): answer or act as usual, with no view.
- Part of the answer is things to tick off, bring or buy, options to compare or pick among (an "A or B?" question included), a plan, schedule or procedure to follow, amounts that follow a number the user may change, or a recommendation that hinges on a preference you had to guess: answer with one \`intelligent_ui\` call that carries those parts as native blocks, with \`text\` blocks for the reasoning between them. ${VIEW_IS_THE_ANSWER}
- The answer walks through a whole mechanism, sequence or structure, several stages or parts of it and not one detail, that is easier to see than to read: load the \`visualize\` skill if you have not, call \`intelligent_ui_html\` for one diagram built from its parts (\`<fs-flow>\` for a sequence or process), then explain in prose.
A follow-up that changes one part gets a view of that part only.`;
// 10-20 计算层 live 第 3 跑:背单词、「一步一步来」被这两段的「a checklist for things to do」带成了 v1 清单。v2 客户端多一句。
const COMPUTED_SHAPES = 'This client renders version 2: numbers that follow values the user may change are derived values shown in stats or a table, and anything gone through one item at a time (flashcards, one step after another, quiz questions) keeps its items and position in state and moves on with set buttons.';
const SHAPE_NOTE_COMPUTED = SHAPE_NOTE.replace('\nA follow-up that changes one part', `\n- ${COMPUTED_SHAPES}\nA follow-up that changes one part`);

const SKETCH_DEFINITION: Tool = {
  type: 'function',
  function: {
    name: HTML_CARD_TOOL,
    // E1 三段式(§五):何时用 → 策略 → 何时别用。构图/视觉语法**不重复**在这里 ——
    // 它们是 SKETCH_SECTION 的正文,而段与工具同门禁(sketchEnabledFor),工具在场 ⟺ 段在场。
    // ponytail: 上限≈1.6KB(10-09 二轮加 PARTS / copy 后靠删 fs-eyebrow / fs-chip / fs-panel / 折叠那句抵回来)。`--fs-*` 变量表与
    //           `fs-*` 类名表留全(§六 P08:SKETCH_SECTION 里没有这两张表,SKETCH_SECTION 反过来让模型「从工具描述取 .fs-* 类」)。
    //           报了 intelligent-ui-libs.v1 的客户端那份再多 ~420 字符(随包库那句,见下方 WITH_LIBS),知情超过,只发给能用库的客户端。
    description:
      'Draw a visual card inline in the chat from self-contained HTML: charts, diagrams, comparisons, ' +
      'timelines, layouts, small interactive widgets. The "Visual cards" section of your instructions ' +
      'covers when to draw and how to compose.\n' +
      'SANDBOX: JavaScript runs, but there is NO network, host API or navigation. Inline all CSS/JS, ' +
      'embed images as data: URIs, no external scripts/styles/fonts or charting libraries (draw with ' +
      'inline SVG or divs), no eval/new Function. Links and form submits do nothing.\n' +
      'THEME: use the injected CSS variables, never hardcode colors — they track the live theme: ' +
      '--fs-bg (transparent card canvas), --fs-surface, --fs-text, --fs-muted, --fs-faint, --fs-border, ' +
      '--fs-rule (hairline for gridlines/axes), --fs-accent, --fs-accent-soft, --fs-green, --fs-danger, ' +
      '--fs-radius, --fs-font, --fs-mono, and the series ramp --fs-s1..--fs-s5 (s1 = accent for the focus ' +
      'value; s2..s5 fade for context). body inherits background/color/font.\n' +
      'PARTS: fs-chart, fs-flow, fs-compare, fs-choice, fs-checklist (JSON-driven, see the visualize ' +
      'skill); classes fs-header, fs-title, fs-subtitle, fs-plot, fs-source, fs-stat-grid, fs-stat, fs-value, ' +
      'fs-label, fs-row, fs-grid, fs-actions, fs-callout, fs-bar-track; no inline style attributes.\n' +
      'SIZE: ~700px wide, auto height. It streams in while you write (markup first, scripts last). ' +
      'Each call appends a NEW card; the result is only a confirmation, the user sees the card.\n' +
      'INTERACTION: click handlers may call window.forsionIntelligentUi.ask(text) (sends that follow-up as ' +
      'the user\'s next message) or .copy(text).\n' +
      'Not for source code, files, or one-number answers — those stay in prose.',
    parameters: {
      type: 'object',
      properties: {
        html: {
          type: 'string',
          description: 'Self-contained HTML for the card (body content; the host wraps it in a sandboxed document with a strict CSP and the theme variables).',
        },
        title: {
          type: 'string',
          description: 'Optional short label for the card, e.g. "Revenue chart".',
        },
      },
      required: ['html'],
    },
  },
};
const SKETCH_WIDGETS = 'charts, diagrams, comparisons, timelines, layouts, small interactive widgets.';
const SKETCH_COMPUTED_DEFINITION: Tool = { ...SKETCH_DEFINITION, function: { ...SKETCH_DEFINITION.function, description: SKETCH_DEFINITION.function.description!.replace(SKETCH_WIDGETS, 'charts, diagrams, timelines, layouts, animated simulations and games; calculators, step guides and other cards that only compute from inputs are intelligent_ui documents.') } };
/** intelligent-ui.v2 without importing intelligentUi.ts (it imports this file). */
const intelligentUiComputedFor = (ctx: ToolContext): boolean => !!ctx.clientCapabilities?.includes('intelligent-ui.v1') && !!ctx.clientCapabilities?.includes('intelligent-ui.v2');
// 随包库(10-28):客户端随包带了 three / d3 / chart.js / gsap(仍然断网;桌面 forsion-iui:,网页本站 /iui-lib/,
// importmap 在 desktop/frontend/src/components/sketchWrapper.ts,两边列的库要一致)才报这个能力;只换说明里的一句,不加新段落。
// 占位那句给旧客户端:它们取不到库,那块至少还剩一行字。
// 「3D 用 three、别手算投影」是 10-28 live 量出来的:只写「use them for 3D」时 7 次里 3 次模型在 canvas / SVG 里自己算投影。
// 力导图那半句同理:只写「d3 suits force layouts」时 3 次全是 SVG + requestAnimationFrame 手写力模拟。
// 不再写「canvas/WebGL 颜色用 getComputedStyle 取 --fs-*」:17 次里模型照做的 4 次全没用 three(改走 canvas 2D / SVG),
// 用了 three 的 13 次一次没照做 —— 只拉偏、没收益。主题色仍由下面 THEME 那句管。
export const IUI_LIBS_CAP = 'intelligent-ui-libs.v1';
const NO_LIBS = 'no external scripts/styles/fonts or charting libraries (draw with inline SVG or divs)';
const WITH_LIBS = 'no external scripts/styles/fonts. Bundled libraries (still no network): a <script type="module"> may import ' +
  "three (and 'three/addons/…', e.g. controls/OrbitControls.js), d3, chart.js/auto and gsap. 3D scenes use three — never " +
  "hand-project 3D into canvas or SVG; force-directed graphs use d3's forceSimulation — never hand-write the physics; " +
  'chart.js suits dense charts, gsap choreographed motion; simple charts ' +
  'stay inline SVG or the parts below. Put a one-line text fallback in ' +
  "a library's container for your script to replace";
const withLibs = (t: Tool): Tool => ({ ...t, function: { ...t.function, description: t.function.description!.replace(NO_LIBS, WITH_LIBS) } });
const SKETCH_LIBS_DEFINITION = withLibs(SKETCH_DEFINITION);
const SKETCH_COMPUTED_LIBS_DEFINITION = withLibs(SKETCH_COMPUTED_DEFINITION);

export const sketchProvider: ToolProvider = {
  id: 'builtin:sketch',
  tools: () => [
    {
      name: HTML_CARD_TOOL,
      mode: 'both',
      isEnabledFor: (_profile, ctx) => sketchEnabledFor(ctx),
      capabilities: { sideEffect: 'none', parallel: false, defaultTimeoutMs: 5_000 },
      definition: SKETCH_DEFINITION,
      // A client that renders computed Intelligent UI documents gets calculators routed there.
      definitionFor: (ctx) => {
        const libs = !!ctx.clientCapabilities?.includes(IUI_LIBS_CAP);
        if (intelligentUiComputedFor(ctx)) return libs ? SKETCH_COMPUTED_LIBS_DEFINITION : SKETCH_COMPUTED_DEFINITION;
        return libs ? SKETCH_LIBS_DEFINITION : SKETCH_DEFINITION;
      },
      execute: (args): string => {
        const html = typeof args.html === 'string' ? args.html : '';
        if (!html.trim()) return 'Error: html is required';
        if (html.length > MAX_SKETCH_HTML_CHARS) {
          return `Error: html too large (${html.length} chars, max ${MAX_SKETCH_HTML_CHARS}). Slim the card down or split it into multiple intelligent_ui_html calls.`;
        }
        // 渲染发生在前端:tool_result 事件(done 且非 Error)触发 SketchCard 从本调用的参数取 HTML 画卡。
        return 'HTML card rendered in the conversation.';
      },
    },
  ],
};
