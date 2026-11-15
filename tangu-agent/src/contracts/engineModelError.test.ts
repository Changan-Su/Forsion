/** 「当前模型缺 API key」那句话:引擎拼、界面拆。两半在同一个文件里,这里钉住拼出来的拆得回去,拆不该拆的不出错、不卡。 */
import { describe, expect, it } from 'vitest';
import { MAX_LENGTH, MAX_OTHERS, formatEngineModelNoApiKey, isEngineModelNoApiKey, parseEngineModelNoApiKey } from './engineModelError.js';

// DSH 0.2.2-rc.3 实测到的报错原文(只用账号登录、没有 API key 时,session/prompt 的回包)
const DSH_RAW = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';

describe('formatEngineModelNoApiKey / parseEngineModelNoApiKey', () => {
  it('有别的模型可换:一行,开头是码 + 字段,后面是给人看的英文,原话在最后;拆回去一样', () => {
    const info = { engine: 'DeepSeek Harness', model: 'deepseek-v4-flash', others: ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro'], raw: DSH_RAW };
    const text = formatEngineModelNoApiKey(info);
    expect(text).toBe(
      'engine_model_no_api_key {"engine":"DeepSeek Harness","model":"deepseek-v4-flash","others":["DeepSeek-V4.1-Flash","DeepSeek-V4-Pro"]}: '
      + 'DeepSeek Harness needs an API key for its current model ("deepseek-v4-flash") and none is set up. '
      + 'Pick another model in the model menu and send again. Other models it offers include: "DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro". '
      + `[${DSH_RAW}]`,
    );
    expect(text.includes('\n')).toBe(false);
    expect(isEngineModelNoApiKey(text)).toBe(true);
    expect(parseEngineModelNoApiKey(text)).toEqual(info);
  });

  it('没有别的模型:说去引擎那边登录或填 key,不叫人换模型', () => {
    const info = { engine: 'DeepSeek Harness', model: 'deepseek-v4-flash', others: [], raw: DSH_RAW };
    const text = formatEngineModelNoApiKey(info);
    expect(text).toContain('It offers no other model: sign in or add an API key in DeepSeek Harness itself, then send again.');
    expect(text).not.toContain('Pick another model');
    expect(parseEngineModelNoApiKey(text)).toEqual(info);
  });

  it('引擎没报当前模型:句子里不带括号,拆回去没有 model', () => {
    const text = formatEngineModelNoApiKey({ engine: 'X', others: ['A'], raw: 'r' });
    expect(text).toContain('X needs an API key for its current model and none is set up.');
    expect(parseEngineModelNoApiKey(text)).toEqual({ engine: 'X', others: ['A'], raw: 'r' });
  });

  it('名字里有引号、逗号、方括号、花括号、反斜杠也拆得回去;换行压成空格', () => {
    const info = { engine: 'My "Odd", [Engine] {x}', model: 'a "b", c\\d}', others: ['x, "y"', '[z]'], raw: 'line one [a] {b} "c"]' };
    expect(parseEngineModelNoApiKey(formatEngineModelNoApiKey(info))).toEqual(info);
    expect(parseEngineModelNoApiKey(formatEngineModelNoApiKey({ ...info, raw: 'one\ntwo' }))?.raw).toBe('one two');
  });

  it('引擎名里塞一整句假的句式,拆出来的仍是真字段(字段只从 JSON 读)', () => {
    const engine = 'E needs an API key for its current model ("fake") and none is set up. Pick another model in the model menu and send again. Other models it offers include: "Wrong". [injected';
    const info = { engine, model: 'real', others: ['Actual'], raw: 'r' };
    expect(parseEngineModelNoApiKey(formatEngineModelNoApiKey(info))).toEqual(info);
  });

  it(`可以换的模型最多点名 ${MAX_OTHERS} 个`, () => {
    const many = Array.from({ length: MAX_OTHERS + 4 }, (_, i) => `M${i}`);
    const back = parseEngineModelNoApiKey(formatEngineModelNoApiKey({ engine: 'E', model: 'm', others: many, raw: 'r' }));
    expect(back?.others).toEqual(many.slice(0, MAX_OTHERS));
  });

  it('句式对不上(被截断、被改写、字段不对、不是这一类)→ 拆不出来', () => {
    const text = formatEngineModelNoApiKey({ engine: 'E', model: 'm', others: ['A'], raw: DSH_RAW });
    expect(parseEngineModelNoApiKey(text.slice(0, 120))).toBeNull();
    expect(isEngineModelNoApiKey(text.slice(0, 120))).toBe(true); // 开头还在,仍认得出是这一类
    expect(parseEngineModelNoApiKey(text.replace('Pick another', 'Choose another'))).toBeNull();
    expect(parseEngineModelNoApiKey('engine_model_no_api_key {"engine":"E","others":"A"}: x [y]')).toBeNull();
    expect(parseEngineModelNoApiKey('engine_model_no_api_key {"engine":1,"others":[]}: x [y]')).toBeNull();
    expect(parseEngineModelNoApiKey(DSH_RAW)).toBeNull();
    expect(parseEngineModelNoApiKey(null)).toBeNull();
  });

  it('码只认整句开头:别的报错里引到这几个字不算', () => {
    expect(isEngineModelNoApiKey('Internal error: failed to read configuration field "engine_model_no_api_key:"')).toBe(false);
    expect(isEngineModelNoApiKey(`Error: ${formatEngineModelNoApiKey({ engine: 'E', others: [], raw: 'r' })}`)).toBe(false);
    expect(isEngineModelNoApiKey(DSH_RAW)).toBe(false);
    expect(isEngineModelNoApiKey(undefined)).toBe(false);
  });

  it('构造过的长串、反复的残句:不卡(一遍扫描),超长的直接不拆', () => {
    const piece = formatEngineModelNoApiKey({ engine: 'E', model: 'm', others: [], raw: '' }).slice(0, -1);
    const hostile = [
      piece.repeat(300),
      `engine_model_no_api_key {${'"a":"\\"'.repeat(5_000)}`,
      `engine_model_no_api_key {"engine":"E","others":[]}: ${'E needs an API key for its current model and none is set up. '.repeat(200)}`,
      `engine_model_no_api_key ${'{'.repeat(MAX_LENGTH - 30)}`,
    ];
    const t0 = performance.now();
    for (const s of hostile) { expect(parseEngineModelNoApiKey(s)).toBeNull(); expect(isEngineModelNoApiKey(s)).toBe(true); }
    expect(performance.now() - t0).toBeLessThan(200);
    expect(parseEngineModelNoApiKey(`${formatEngineModelNoApiKey({ engine: 'E', others: [], raw: '' }).slice(0, -1)}${'x'.repeat(MAX_LENGTH)}]`)).toBeNull();
  });

  it('原话太长时只留前一段,整句不超过拆的上限', () => {
    const text = formatEngineModelNoApiKey({ engine: 'E', model: 'm', others: ['A'], raw: 'x'.repeat(50_000) });
    expect(text.length).toBeLessThan(MAX_LENGTH);
    expect(parseEngineModelNoApiKey(text)?.others).toEqual(['A']);
  });
});
