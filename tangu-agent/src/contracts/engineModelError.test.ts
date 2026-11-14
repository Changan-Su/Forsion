/** 「当前模型缺 API key」那句话:引擎拼、界面拆。两半在同一个文件里,这里钉住拼出来的拆得回去。 */
import { describe, expect, it } from 'vitest';
import { ENGINE_MODEL_NO_API_KEY, MAX_OTHERS, formatEngineModelNoApiKey, isEngineModelNoApiKey, parseEngineModelNoApiKey } from './engineModelError.js';

// DSH 0.2.2-rc.3 实测到的报错原文(只用账号登录、没有 API key 时,session/prompt 的回包)
const DSH_RAW = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';

describe('formatEngineModelNoApiKey / parseEngineModelNoApiKey', () => {
  it('有别的模型可换:一行英文,开头是固定的码,拆回去一样', () => {
    const info = { engine: 'DeepSeek Harness', model: 'deepseek-v4-flash', others: ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro'], raw: DSH_RAW };
    const text = formatEngineModelNoApiKey(info);
    expect(text).toBe(
      'engine_model_no_api_key: DeepSeek Harness needs an API key for its current model ("deepseek-v4-flash") and none is set up. '
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

  it('名字里有引号、逗号、方括号、反斜杠也拆得回去;原文里有方括号和换行也一样', () => {
    const info = { engine: 'My "Odd", [Engine]', model: 'a "b", c\\d', others: ['x, "y"', '[z]'], raw: 'line one [a]\nline two "b"]' };
    expect(parseEngineModelNoApiKey(formatEngineModelNoApiKey(info))).toEqual(info);
  });

  it(`可以换的模型最多点名 ${MAX_OTHERS} 个`, () => {
    const many = Array.from({ length: MAX_OTHERS + 4 }, (_, i) => `M${i}`);
    const back = parseEngineModelNoApiKey(formatEngineModelNoApiKey({ engine: 'E', model: 'm', others: many, raw: 'r' }));
    expect(back?.others).toEqual(many.slice(0, MAX_OTHERS));
  });

  it('句式对不上(被截断、被改写、不是这一类)→ 拆不出来;只要码在,仍认得出是这一类', () => {
    const text = formatEngineModelNoApiKey({ engine: 'E', model: 'm', others: ['A'], raw: DSH_RAW });
    const cut = text.slice(0, 120);
    expect(parseEngineModelNoApiKey(cut)).toBeNull();
    expect(isEngineModelNoApiKey(cut)).toBe(true);
    expect(parseEngineModelNoApiKey(`${ENGINE_MODEL_NO_API_KEY}: something else entirely`)).toBeNull();
    expect(parseEngineModelNoApiKey(DSH_RAW)).toBeNull();
    expect(isEngineModelNoApiKey(DSH_RAW)).toBe(false);
    expect(isEngineModelNoApiKey(undefined)).toBe(false);
    expect(parseEngineModelNoApiKey(null)).toBeNull();
  });
});
