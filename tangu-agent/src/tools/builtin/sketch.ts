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
import { presetOf } from '../../core/presetTable.js';

/** GUI 客户端面(routes/runs.ts CLIENT_TAG_RE 的子集;移动原生 App 见头注刻意排除)。 */
const GUI_CLIENT_RE = /^(desktop|web)\//;

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

Use \`sketch\` when seeing or manipulating a relationship materially helps the answer: compare
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

For stateful interactions, read \`window.forsionSketch.state\` at startup (null on first use), validate
its shape, then render. After user input call \`window.forsionSketch.setState(jsonValue)\` to replace
a snapshot up to 16 KiB. Store only choices needed to restore the view, not secrets or derived data.
This state is local to this card on this device; it does not reach the model or start a conversation.
Listen for \`forsion:themechange\` when canvas needs repainting; SVG CSS updates automatically.

The card renders progressively while you write it: put the headline and the markup first and every
\`<script>\` block last, so the structure is visible before the behavior arrives.

Buttons that change the answer: in a click handler call \`window.forsionSketch.ask("...")\` with the
follow-up the user would type ("explain the second stage", "show the pessimistic case"). It is sent as
the user's next visible message in this conversation, one per click; never call it on load or from a
timer. Use it for choices that need a new answer; keep recomputation that needs no new answer inside
the card. \`window.forsionSketch.copy(text)\` (also click-only) copies text such as a shopping list.

Before calling \`sketch\`, check that every control works, all queried elements exist, labels fit,
light/dark themes work, and the first render is useful. Afterwards give only the takeaway or caveat
not already visible. For complex charts or interactions, use the bundled \`visualize\` skill.`;

/** visuals=less 时追加在 SKETCH_SECTION 之后:常驻段仍在(用户点名要图时成品下限不变),但「不等用户说画」那条让位。 */
export const SKETCH_LESS_NOTE = `The user has set interface visuals to "less": call \`sketch\` only when they explicitly ask for a
chart, diagram, card, or interactive view in this turn; otherwise answer in prose.`;

export type SketchTurnSignal = {
  kind: 'explicit' | 'implicit';
  section: string;
};

const SKETCH_OPTOUT_RE = /(?:不要|不用|无需|别)(?:画|绘制|图表|可视化|\s*sketch)|(?:只要|仅)(?:用)?(?:文字|纯文字|代码)|\b(?:text[ -]?only|no (?:chart|diagram|visuals?|sketch))\b/i;
const SKETCH_EXPLICIT_RE = /(?:画|绘制|生成|做|给我|用)[^。！？\n]{0,48}(?:图|图表|示意图|架构图|流程图|时序图|关系图|时间线|看板|可视化|sketch)|(?:请|帮我)?可视化|\b(?:draw|visuali[sz]e|make|create|render|show)\b.{0,32}\b(?:chart|diagram|flowchart|timeline|wireframe|mockup|visual|sketch)\b|\b(?:diagram|flowchart|wireframe)\s+(?:this|it|the)\b/i;
const SKETCH_RELATION_RE = /(?:比较|对比|排名|趋势|变化|演变|分布|构成|前后|步骤|流程|架构|结构|层级|关系|状态机|生命周期|用户旅程|路线图|时间线|决策矩阵|布局|版式|配色)|\b(?:compare|comparison|versus|vs\.?|rank|ranking|trend|distribution|composition|before and after|steps?|flow|process|architecture|hierarchy|relationship|state machine|lifecycle|journey|roadmap|timeline|decision matrix|layout|palette)\b/i;
const SKETCH_INTERACTIVE_RE = /(?:计算器|滑块|筛选|过滤器|切换器|交互式)|\b(?:calculator|slider|filter|toggle|interactive)\b/i;
const SKETCH_ANALYZE_RE = /(?:分析|对比|比较|趋势|增长|下降|变化|数据|指标)|\b(?:analy[sz]e|compare|trend|growth|decline|change|data|metric)\b/i;
const SKETCH_CODE_FOCUS_RE = /(?:修复|改代码|重构|实现|写代码|编译|测试|报错)|\b(?:fix|refactor|implement|code|function|class|compile|typecheck|unit test|bug)\b|\.(?:[cm]?[jt]sx?|py|rs|go|java|swift)\b/i;

/**
 * 本轮视觉信号:常驻段负责通识,这里用很窄的语义启发式给当前请求一次额外提醒。
 * 不返回用户原文,不做 LLM 分类器,不因文中单个数字或代码里的 compare 误触发。
 */
export function sketchTurnSignalFor(message: string, visuals: VisualsPref = 'auto'): SketchTurnSignal | undefined {
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
        'The user explicitly asked for a visual deliverable. Call `sketch` before finishing; do not substitute an ASCII diagram, a Markdown table, or a prose description unless the user also explicitly requested that format.',
    };
  }
  // less:只认明确要求;隐式信号(比较 / 流程 / 数据形状)不再提醒,收尾补催也随之缺席(它只看这个信号)。
  if (visuals === 'less') return undefined;

  const relation = SKETCH_RELATION_RE.test(text);
  const interactive = SKETCH_INTERACTIVE_RE.test(text);
  const numbers = text.match(/(?:^|[^\p{L}\p{N}])[-+]?(?:\d{1,3}(?:[,_ ]\d{3})+|\d+)(?:\.\d+)?%?/gu)?.length ?? 0;
  const dataShape = numbers >= 3 && SKETCH_ANALYZE_RE.test(text);
  if (!(relation || interactive || dataShape)) return undefined;
  if (SKETCH_CODE_FOCUS_RE.test(text) && !interactive) return undefined;

  return {
    kind: 'implicit',
    section:
      '## Visual-first note for this turn\n' +
      'This request contains a comparison, sequence, structure, data shape, or interaction that is faster to understand visually even though the user may not have said "draw". Default to calling `sketch` as part of the answer. Skip only if closer inspection shows that the relationship is trivial or the actual deliverable is code/a file rather than an explanation.',
  };
}

export const sketchProvider: ToolProvider = {
  id: 'builtin:sketch',
  tools: () => [
    {
      name: 'sketch',
      mode: 'both',
      isEnabledFor: (_profile, ctx) => sketchEnabledFor(ctx),
      capabilities: { sideEffect: 'none', parallel: false, defaultTimeoutMs: 5_000 },
      definition: {
        type: 'function',
        function: {
          name: 'sketch',
          // E1 三段式(§五):何时用 → 策略 → 何时别用。构图/视觉语法**不重复**在这里 ——
          // 它们是 SKETCH_SECTION 的正文,而段与工具同门禁(sketchEnabledFor),工具在场 ⟺ 段在场。
          // ponytail: 上限≈1.6KB(10-09 二轮加 PARTS / copy 后靠删 fs-eyebrow / fs-chip / fs-panel / 折叠那句抵回来)。`--fs-*` 变量表与
          //           `fs-*` 类名表留全(§六 P08:SKETCH_SECTION 里没有这两张表,SKETCH_SECTION 反过来让模型「从工具描述取 .fs-* 类」)。
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
            'INTERACTION: click handlers may call window.forsionSketch.ask(text) (sends that follow-up as ' +
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
      },
      execute: (args): string => {
        const html = typeof args.html === 'string' ? args.html : '';
        if (!html.trim()) return 'Error: html is required';
        if (html.length > MAX_SKETCH_HTML_CHARS) {
          return `Error: html too large (${html.length} chars, max ${MAX_SKETCH_HTML_CHARS}). Slim the card down or split it into multiple sketch calls.`;
        }
        // 渲染发生在前端:tool_result 事件(done 且非 Error)触发 SketchCard 从本调用的参数取 HTML 画卡。
        return 'Sketch card rendered in the conversation.';
      },
    },
  ],
};
