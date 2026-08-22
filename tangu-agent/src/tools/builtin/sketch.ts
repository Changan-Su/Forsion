/**
 * sketch —— agent 在对话流里画一张可交互的 HTML 卡片(GUI 三端内联渲染)。
 * 载荷走工具**参数**:tool_calls 原样落 JSONB 不截断,前端从持久化参数 back-fill 重建
 * (exit_plan_mode 同款),零 schema 变更零迁移;result 只回短确认(display_file 同款)。
 * 渲染面契约(前端 SketchCard):sandbox iframe 仅 allow-scripts + 内层 CSP default-src 'none'
 * —— JS 可跑,无网络、无宿主 API、无导航;描述里必须把这个能力包络讲给模型。
 * 门禁:sketchEnabledFor 按 ctx.client 白名单(desktop|web)+ 排除子代理。CLI/TUI/通道/自动化 run
 * 无 client tag → 不注册(default-deny),满足「CLI 不注册」且天然覆盖 external 后端模式。
 * ⚠️移动端(Capacitor 原生 App,client=mobile/*)刻意排除:其 WebView 的 addJavascriptInterface
 * 原生桥(Filesystem/Preferences/Browser 插件)对子 iframe 可见,sandbox/CSP 拦不住 JS 桥对象——
 * 卡内脚本能直接删文件/清 token。渲染层(SketchCard)另有 Capacitor-native 拒渲染兜底(跨端看历史卡)。
 * ⚠️子代理排除:runSubAgent 展开父 ctx 会带上 client,但子代理的卡进不了主消息(画了用户看不见)。
 * ⚠️描述里的 --fs-* token 名与前端 `desktop/frontend/src/components/sketchWrapper.ts` 的
 * SKETCH_VARS **必须逐字一致**(跨仓两份,没有共享包;改一边就得改另一边,否则模型写的变量解析不出来)。
 */
import type { ToolProvider } from '../toolRegistry.js';
import type { ToolContext } from '../toolTypes.js';

/** GUI 客户端面(routes/runs.ts CLIENT_TAG_RE 的子集;移动原生 App 见头注刻意排除)。 */
const GUI_CLIENT_RE = /^(desktop|web)\//;

/** ponytail: 256K 字符上限(参数进上下文,模型自会节制;超了让它精简)。真需要大卡再谈外置存储。 */
const MAX_SKETCH_HTML_CHARS = 262_144;

/** 单一判定源:isEnabledFor 与 agentLoop 的 SKETCH_SECTION 注入共用,免两处条件漂移。
 *  结构化入参而非 ToolContext:agentLoop 拼系统提示时(第 3b 段)toolCtx 还没造出来。
 *  ⚠️planMode:计划模式有一道**集中的只读工具过滤**,sketch 本来就不在其白名单里 —— 这里跟着
 *  排除,是为了让「提示段在场 ⟺ 工具在场」这条不变式在计划模式下也成立(否则模型照着提示段
 *  去调一个不存在的工具,白烧一轮)。单测钉住两边配对。 */
export function sketchEnabledFor(ctx: Pick<ToolContext, 'client' | 'subAgentDepth' | 'planMode' | 'channelSession'>): boolean {
  return GUI_CLIENT_RE.test(ctx.client || '') && !((ctx.subAgentDepth ?? 0) >= 1) && !ctx.planMode && !ctx.channelSession;
}

/**
 * 系统提示段:同时管「什么时候画」和「成品的下限」。经 agentLoop 直接注入(不进
 * promptSections.guidance——per-app promptGuidance 是整段替换,会静默丢掉),且与工具
 * 同门禁,CLI run 不注入。视觉语法是从 lieflat-charts 里抽出的「数据诚实 + 编辑部密度」,
 * 但不把整份 skill 塞进每轮上下文;沙箱也无法用 gallery 的外链图库,故在此给出可执行的内联 SVG 配方。
 */
export const SKETCH_SECTION = `## Visual cards

The \`sketch\` tool is a first-class answer medium, not a special effect. Do not wait for the user to
say "draw". Default to a visual card when the essential relationship is easier to see than to read:
- 3+ values, options, or categories to compare, rank, or scan
- 3+ steps, states, dates, layers, nodes, or branches whose order or structure matters
- a trend, distribution, composition, before/after, architecture, journey, timeline, or decision matrix
- a proposed layout, palette, interface, or a small calculator/filter/toggle the user can manipulate

If the user explicitly asks for text only, the deliverable is source code/a file rather than an
explanation, or the answer is one fact or one number, stay in prose. Otherwise, when in doubt about a
genuinely spatial relationship, draw. Make the card before the short explanation; after it, say only
the takeaway or caveat that is not already visible.

### Composition contract

Decide the one question the card answers, then choose one visual grammar:
- comparison/ranking -> directly labelled horizontal bars, dots, or a compact comparison table
- change over time -> a line/area or milestone timeline with an honest scale and labelled extrema
- part to whole -> a 100-unit field or one stacked strip; show the denominator
- flow/process -> a left-to-right path with numbered stages and restrained connectors
- hierarchy/architecture -> aligned layers or a tree; make direction and boundaries unambiguous
- choice/decision -> a matrix with explicit criteria and one clearly explained emphasis

Every finished card needs four parts: (1) a conclusion-led title, not a chart-type label; (2) a short
subtitle stating measure, unit, scope, and time when relevant; (3) the visual field; (4) a compact
source, assumption, or method line. Use the built-in \`.fs-*\` classes from the tool description so
typography and spacing start polished. For charts, prefer responsive inline SVG with a viewBox,
direct labels, hairline guides, and small contextual annotations. For diagrams, avoid a soup of equal
rounded boxes: establish one reading direction, 2-3 hierarchy levels, consistent alignment, and
quiet connectors. Use whitespace and rules to create useful density; decoration must never pretend
to be data.

One well-made card beats several thin cards. Keep one color system, one focal accent, honest numeric
proportions, readable labels, and meaningful interaction only. Before calling \`sketch\`, mentally
check: the main point is visible in three seconds; labels do not collide; nothing relies on hover;
dark/light themes work; and the card still makes sense without color.`;

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
export function sketchTurnSignalFor(message: string): SketchTurnSignal | undefined {
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
          description:
            'Draw a visual card inline in the conversation, rendered from self-contained HTML. ' +
            'Use it to show the USER charts, diagrams, tables, comparisons, timelines, proposed layouts, ' +
            'or small interactive widgets directly in the chat flow, instead of describing them in prose.\n' +
            'SANDBOX: the card renders in a sandboxed frame — JavaScript runs, but there is NO network access, ' +
            'NO host API, and NO navigation. Inline all CSS/JS, embed images as data: URIs, never reference ' +
            'external scripts/styles/fonts/URLs (charting libraries and web fonts are unavailable — draw charts ' +
            'with inline SVG or divs), and do not use eval/new Function. Links and form submissions do nothing; ' +
            'handle interactions with inline JS.\n' +
            'THEME: the host injects its live theme as CSS variables — use them and never hardcode colors, ' +
            'or the card will clash in dark mode and on other skins. Available: ' +
            '--fs-bg (transparent card canvas), --fs-surface (subtle fill), --fs-text, --fs-muted, --fs-faint, ' +
            '--fs-border, --fs-rule (hairline for gridlines/axes), --fs-accent, --fs-accent-soft, ' +
            '--fs-green, --fs-danger, --fs-radius, --fs-font, --fs-mono, and a 5-step data series ramp ' +
            '--fs-s1..--fs-s5 (s1 is the accent, s2..s5 fade — use s1 for the value in focus and the rest for context). ' +
            'The canvas stays transparent so it inherits whichever chat surface is behind it; the other variables ' +
            'update live when the user switches theme, and body already inherits background/color/font.\n' +
            'FOUNDATION: the wrapper includes polished responsive classes; use them instead of rebuilding basic ' +
            'typography every time: fs-header, fs-eyebrow, fs-title, fs-subtitle, fs-plot, fs-caption/fs-source, ' +
            'fs-stat-grid, fs-stat, fs-value, fs-label, fs-panel, fs-row, fs-chip, fs-bar-track, and fs-bar-fill. ' +
            'The four-part default is <header class="fs-header">title + subtitle</header>, ' +
            '<figure class="fs-plot">visual</figure>, then <footer class="fs-source">source/method</footer>.\n' +
            'STYLE: editorial and restrained — conclusion-led hierarchy, real data units over decoration, useful ' +
            'density, generous whitespace, hairline guides over boxes and fills, and one focal accent per card. ' +
            'Labels, units and a source/caption line are mandatory chart parts. Prefer direct labels on the data ' +
            'over a separate legend. Add quiet structure (guides, ticks, annotations, alignment) so sparse data does ' +
            'not look unfinished. No gradients, no shadows, no emoji as data marks, at most 5 categorical series.\n' +
            'SIZE: the card is ~700px wide and auto-sizes to its content height. Anything taller than about half ' +
            'the chat area is folded behind an expand toggle, so put the headline number or the point of the card ' +
            'at the top. Each call appends a NEW card (cards cannot be updated — call again with revised HTML). ' +
            'The result is only a confirmation; the user sees the rendered card.',
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
