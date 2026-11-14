/**
 * 外部引擎报「当前模型要 API key,而这台电脑上没有配」时,引擎写进 run 的那句失败原因。
 *
 * 一行,形如:
 *   engine_model_no_api_key {"engine":…,"model":…,"others":[…]}: <给人看的英文句子> [<引擎的原话>]
 * 开头的码只认整句开头;紧跟的 JSON 是界面要用的字段(引擎名、当前模型、可以换的模型),后面的英文句子给日志 / TUI 看,
 * 由同样的字段生成。界面认出码后换成界面语言的说法(desktop 的 humanizeRunError)。
 *
 * 拆的时候只走一遍(找 JSON 的结尾是线性扫描,后面是逐字比对),不用正则去切:原话来自外部进程,整句还会存进
 * 对话记录、每次打开对话都要拆 —— 带回溯的正则遇上构造过的长串会卡住界面。字段只从 JSON 里读,所以引擎名、
 * 模型名里写什么都不会被当成句子的结构。
 *
 * 拼和拆放在同一个文件里,引擎和界面各带一份(契约目录,纯 TS,不引任何别的模块)。测试在 engineModelError.test.ts。
 */

export const ENGINE_MODEL_NO_API_KEY = 'engine_model_no_api_key';
const PREFIX = `${ENGINE_MODEL_NO_API_KEY} {`;

export interface EngineModelNoApiKey {
  /** 引擎的显示名。 */
  engine: string;
  /** 当前模型的显示名;引擎没报模型清单时没有。 */
  model?: string;
  /** 引擎清单里可以换过去的模型的显示名(最多 MAX_OTHERS 个);空 = 没有可换的。 */
  others: string[];
  /** 引擎自己的报错原文,留给排查。 */
  raw: string;
}

/** 句子里最多点名几个可以换的模型:清单再长,这句话也不会长到没人看。 */
export const MAX_OTHERS = 5;
/** 超过这么长的不拆(正常的一句不到 1 KB;原话被截到这么长以内)。 */
export const MAX_LENGTH = 16_384;
const MAX_RAW = 4_000;

const quote = (name: string): string => JSON.stringify(name);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function sentence(info: Omit<EngineModelNoApiKey, 'raw'>): string {
  const what = `${info.engine} needs an API key for its current model${info.model ? ` (${quote(info.model)})` : ''} and none is set up.`;
  const next = info.others.length
    ? `Pick another model in the model menu and send again. Other models it offers include: ${info.others.map(quote).join(', ')}.`
    : `It offers no other model: sign in or add an API key in ${info.engine} itself, then send again.`;
  return `${what} ${next}`;
}

/** 界面先用它判断是不是这一类失败(拆不出细节时也要认得出)。只认整句开头。 */
export function isEngineModelNoApiKey(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(PREFIX);
}

export function formatEngineModelNoApiKey(info: EngineModelNoApiKey): string {
  const fields = { engine: oneLine(info.engine), ...(info.model ? { model: oneLine(info.model) } : {}), others: info.others.slice(0, MAX_OTHERS).map(oneLine) };
  const raw = oneLine(info.raw).slice(0, MAX_RAW);
  return `${ENGINE_MODEL_NO_API_KEY} ${JSON.stringify(fields)}: ${sentence(fields)} [${raw}]`;
}

/** 从 start(一个 '{')起找到与它配对的 '}' 的下标;一遍扫描,认 JSON 字符串里的引号和转义。找不到 → -1。 */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92 /* \ */) i++;
      else if (c === 34 /* " */) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 /* { */ || c === 91 /* [ */) depth++;
    else if (c === 125 /* } */ || c === 93 /* ] */) { depth--; if (depth === 0) return c === 125 ? i : -1; }
  }
  return -1;
}

/** 拆回去。句式对不上(被截断、改写过、太长)→ null,调用方退回不点名的说法。 */
export function parseEngineModelNoApiKey(text: unknown): EngineModelNoApiKey | null {
  if (typeof text !== 'string' || text.length > MAX_LENGTH || !text.startsWith(PREFIX)) return null;
  const open = PREFIX.length - 1;
  const close = objectEnd(text, open);
  if (close < 0) return null;
  let fields: any;
  try { fields = JSON.parse(text.slice(open, close + 1)); } catch { return null; }
  if (!fields || typeof fields !== 'object' || typeof fields.engine !== 'string' || !fields.engine) return null;
  if (fields.model !== undefined && typeof fields.model !== 'string') return null;
  if (!Array.isArray(fields.others) || fields.others.length > MAX_OTHERS || !fields.others.every((o: unknown) => typeof o === 'string')) return null;
  const info = { engine: fields.engine as string, ...(fields.model ? { model: fields.model as string } : {}), others: fields.others as string[] };
  const head = `: ${sentence(info)} [`;
  if (!text.startsWith(head, close + 1) || !text.endsWith(']')) return null;
  return { ...info, raw: text.slice(close + 1 + head.length, -1) };
}
