/**
 * 外部引擎报「当前模型要 API key,而这台电脑上没有配」时,引擎写进 run 的那句失败原因。
 *
 * 一行英文(日志、TUI 原样看得懂),开头是一个固定的码。界面认出这个码之后把引擎名、当前模型、可以换的模型拆出来,
 * 换成界面语言的说法(desktop 的 humanizeRunError)。拼和拆放在同一个文件里,引擎和界面各带一份(契约目录,纯 TS,
 * 不引任何别的模块):改句式时拆的那半跟着改,两边不会各说各的。测试在 engineModelError.test.ts。
 */

export const ENGINE_MODEL_NO_API_KEY = 'engine_model_no_api_key';

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

const quote = (name: string): string => JSON.stringify(name);
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const SENTENCE = new RegExp(
  `${ENGINE_MODEL_NO_API_KEY}: (.+?) needs an API key for its current model(?: \\((${QUOTED})\\))? and none is set up\\. `
  + `(?:Pick another model in the model menu and send again\\. Other models it offers include: (${QUOTED}(?:, ${QUOTED})*)\\.`
  + `|It offers no other model: sign in or add an API key in .+? itself, then send again\\.)`
  + ` \\[([\\s\\S]*)\\]$`,
);

/** 界面先用它判断是不是这一类失败(句式对不上、拆不出细节时也要认得出)。 */
export function isEngineModelNoApiKey(text: unknown): boolean {
  return typeof text === 'string' && text.includes(`${ENGINE_MODEL_NO_API_KEY}:`);
}

export function formatEngineModelNoApiKey(info: EngineModelNoApiKey): string {
  const others = info.others.slice(0, MAX_OTHERS);
  const what = `${info.engine} needs an API key for its current model${info.model ? ` (${quote(info.model)})` : ''} and none is set up.`;
  const next = others.length
    ? `Pick another model in the model menu and send again. Other models it offers include: ${others.map(quote).join(', ')}.`
    : `It offers no other model: sign in or add an API key in ${info.engine} itself, then send again.`;
  return `${ENGINE_MODEL_NO_API_KEY}: ${what} ${next} [${info.raw}]`;
}

/** 拆回去。句式对不上(被别处截断、改写过)→ null,调用方退回不点名的说法。 */
export function parseEngineModelNoApiKey(text: unknown): EngineModelNoApiKey | null {
  if (typeof text !== 'string') return null;
  const m = SENTENCE.exec(text);
  if (!m) return null;
  try {
    const names = (list: string | undefined): string[] => (list ? (list.match(new RegExp(QUOTED, 'g')) || []).map((q) => String(JSON.parse(q))) : []);
    const model = m[2] ? String(JSON.parse(m[2])) : undefined;
    return { engine: m[1], ...(model ? { model } : {}), others: names(m[3]), raw: m[4] };
  } catch {
    return null;
  }
}
