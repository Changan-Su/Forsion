import { describe, expect, it } from 'vitest';
import { replayAssistantHistory, stepLlmResponse, STEP_ITEMS_MAX_BYTES, type ReplayStep } from './historyReplay.js';
import { assistantTurnOf } from './contextBudget.js';

const call = (id: string) => ({ id, type: 'function', function: { name: 'find_roots', arguments: '{"text":"Music"}' } });
describe('execution evidence survives a new run', () => {
  it('restores tool-only rows and matching results, including serialized database columns', () => {
    const row = { content: '', tool_calls: JSON.stringify([call('c')]), tool_results: JSON.stringify([{ tool_call_id: 'c', content: 'window @r1', isError: false }]) };
    expect(replayAssistantHistory(row)).toEqual([
      { role: 'assistant', content: '', tool_calls: [call('c')] },
      { role: 'tool', tool_call_id: 'c', content: 'window @r1' },
    ]);
  });
  it('preserves failed and missing outcomes without claiming success or replaying operations', () => {
    const rows = replayAssistantHistory({ content: 'checking', tool_calls: [call('a'), call('b')], tool_results: [{ tool_call_id: 'a', content: 'access denied', isError: true }] });
    // 失败结果**逐字**回放模型在线时见到的那串:executeOneToolCall 送进 workingMessages 的就是 capped
    // 正文本身,isError 只进 tool_result 事件。回放再拼一个 `[Tool failed]\n` = 模型当时没见过的字节,
    // 含失败工具的那一轮此后每个 run 都从这里 miss。
    expect(rows[1].content).toBe('access denied');
    expect(rows[2].content).toContain('unknown');
    expect(rows[2].content).toContain('partially executed');
  });
  it('ignores malformed calls, orphan results and duplicates while keeping normal text', () => {
    const rows = replayAssistantHistory({ content: 'text', tool_calls: [null, {}, call('c'), call('c')], tool_results: [{ tool_call_id: 'orphan', content: 'not trusted as a result' }] });
    expect(rows).toHaveLength(2);
    expect(rows[0].tool_calls).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('orphan');
    expect(replayAssistantHistory({ content: 'text', tool_calls: '{bad', tool_results: null })).toEqual([{ role: 'assistant', content: 'text' }]);
  });
  it('bounds large outputs and leaves the stored evidence unchanged', () => {
    const row = { content: '', tool_calls: [call('c')], tool_results: [{ tool_call_id: 'c', content: 'x'.repeat(200_000) + 'END' }] };
    const before = JSON.stringify(row);
    const rows = replayAssistantHistory(row);
    expect(String(rows[1].content).length).toBeLessThan(110_000);
    expect(String(rows[1].content)).toContain('END');
    expect(JSON.stringify(row)).toBe(before);
  });
});

// ── A2(Token/缓存评审 §五 A 档):回放保真的两条不变式 —— 前缀不变 + in-run 交错(B3 已落地)。──
describe('replay keeps the cache prefix honest', () => {
  const turn = (i: number) => ({ content: `turn ${i}`, tool_calls: [call(`c${i}`)], tool_results: [{ tool_call_id: `c${i}`, content: `out ${i}` }] });
  /** 上游缓存看的是**字节前缀**,不是「消息数组等价」,所以这里按序列化后的字节判。 */
  const bytes = (rows: unknown[]) => rows.map((m) => JSON.stringify(m)).join('\n');

  it('appending a turn within a run does not change the prefix', () => {
    const before = [turn(1), turn(2)].flatMap(replayAssistantHistory);
    const after = [turn(1), turn(2), turn(3)].flatMap(replayAssistantHistory);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(bytes(after).startsWith(bytes(before))).toBe(true);
  });

  // B3(§五 B 档「回放保真(扁平修复)」)已落地:replayAssistantHistory(row, steps, { apiModelId }) 收
  // agent_steps 的按轮记录 { step_no, llm_response: { content, outputItems, outputItemsModel }, tool_calls },
  // 重建在线时的交错,并把 outputItems 原样挂成 providerItems(同模型才挂,见下面那个 describe)。
  // 结果一律取自行(row.tool_results),步骤里的同名字段忽略。
  it('replay rebuilds the in-run interleave (assistant/tool/providerItems)', () => {
    const flat = {
      content: 'first\n\nsecond',
      tool_calls: [call('c1'), call('c2')],
      tool_results: [{ tool_call_id: 'c1', content: 'out 1' }, { tool_call_id: 'c2', content: 'out 2' }],
    };
    const items = (i: number) => [
      { type: 'reasoning', id: `rs_${i}` },
      { type: 'function_call', call_id: `c${i}`, name: 'find_roots', arguments: '{"text":"Music"}' },
    ];
    const steps = [
      { step_no: 0, llm_response: { content: 'first', outputItems: items(1), outputItemsModel: { apiModelId: 'm' } }, tool_calls: [call('c1')], tool_results: [{ tool_call_id: 'c1', content: 'out 1' }] },
      { step_no: 1, llm_response: { content: 'second', outputItems: items(2), outputItemsModel: { apiModelId: 'm' } }, tool_calls: [call('c2')], tool_results: [{ tool_call_id: 'c2', content: 'out 2' }] },
    ];
    const rows = (replayAssistantHistory as any)(flat, steps, { apiModelId: 'm' });
    expect(rows.map((r: any) => r.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(rows[2].content).toBe('second'); // 第二轮正文必须落在第一轮 tool 结果**之后**
    expect(rows[0].providerItems).toEqual(items(1));
  });
});

// ── B3(§五 B 档):跨 run 回放 = 在线时的那串字节。一个 run 的真实形状是「两轮工具 + 末轮收尾」,
// 下面两侧(在线 workingMessages / 落库后回放)都从**同一份** fixture 造,才证得了「同一串字节」。──
describe('B3 — cross-run replay reproduces the in-run interleave', () => {
  const bytes = (rows: unknown[]) => rows.map((m) => JSON.stringify(m)).join('\n');
  // 第二轮**故意是失败结果**(isError:true):在线与回放的 tool 正文必须逐字相同,不许回放侧多出
  // `[Tool failed]\n`。整个 describe 只有这一处 isError,断言 fail 时能一眼定位到前缀那条纪律。
  const fixture = [
    { text: 'looking', call: call('c1'), out: 'out 1', isError: false },
    { text: 'then', call: call('c2'), out: 'out 2', isError: true },
  ];
  const finalText = 'done';
  /** 在线侧:每轮 assistantTurnOf(...) + executeOneToolCall 的 tool 消息。末轮正文只进 finalContent,
   *  从不入 workingMessages —— 所以在线这串比回放**少**最后一条。 */
  const inRun = fixture.flatMap((t) => [
    assistantTurnOf({}, t.text, [t.call] as any),
    { role: 'tool', content: t.out, tool_call_id: t.call.id },
  ]);
  /** 落库侧:chat_messages 行(content 由 appendFinal 累积;tool_calls 带 ui_content_offset 戳)。 */
  const row = {
    content: [...fixture.map((t) => t.text), finalText].join('\n\n'),
    tool_calls: fixture.map((t, i) => ({ ...t.call, ui_content_offset: i * 9 })),
    tool_results: fixture.map((t) => ({ tool_call_id: t.call.id, name: 'find_roots', content: t.out, isError: t.isError, elapsedMs: 3 })),
  };
  /** agent_steps:每轮一行,末轮(无工具调用)也落一行。 */
  const steps: ReplayStep[] = [
    ...fixture.map((t, i) => ({ step_no: i, llm_response: { content: t.text, usage: { prompt_tokens: 1 } }, tool_calls: [t.call] })),
    { step_no: fixture.length, llm_response: { content: finalText, usage: { prompt_tokens: 2 } } },
  ];

  it('replays a multi-iteration run as assistant→tool→assistant→tool→assistant(final)', () => {
    const rows = replayAssistantHistory(row, steps);
    expect(rows.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(rows[2].content).toBe('then'); // 第二轮正文在第一轮结果之后
    expect(rows[4].content).toBe(finalText); // 末轮正文(只存在于落库那侧)排最后,一个字节不丢
    expect((rows[0] as any).tool_calls).toEqual([call('c1')]); // ui_content_offset 是 UI 用的戳,不上 wire
    // 交错那支的 tool 消息键序对齐在线时的 executeOneToolCall(与扁平那支不同,见下面那条)
    expect(JSON.stringify(rows[1])).toBe('{"role":"tool","content":"out 1","tool_call_id":"c1"}');
  });

  // 额度不足 / 截断耗尽那两条出口 break 前没有 appendStep,末轮正文只在行里。闸②的尾巴正是为它们留的。
  it('keeps the final text when the last iteration never got a step row', () => {
    const rows = replayAssistantHistory(row, steps.slice(0, 2));
    expect(rows.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(rows[4].content).toBe(finalText);
  });

  // 负对照就在 fixture 里:第二个工具结果 isError:true。回放侧一旦给它拼 `[Tool failed]\n`,
  // 这条(和下面那条扁平的)立刻红 —— 这才是「字节同形」这句话真正被证过的地方。
  it('replayed bytes start with the in-run bytes for the same run, failed tool results included', () => {
    const replayed = replayAssistantHistory(row, steps);
    expect(bytes(replayed).startsWith(bytes(inRun))).toBe(true);
    expect(replayed.slice(inRun.length)).toEqual([{ role: 'assistant', content: finalText }]);
    expect(replayed[3].content).toBe('out 2'); // isError 的那条,字节 === 在线那条
  });

  it('orders by step_no, not by array order', () => {
    expect(replayAssistantHistory(row, [steps[2], steps[1], steps[0]])).toEqual(replayAssistantHistory(row, steps));
  });

  it('an old row with no steps still replays flat (pre-B3 rows keep working)', () => {
    const flat = [
      { role: 'assistant', content: row.content, tool_calls: [call('c1'), call('c2')] },
      { role: 'tool', content: 'out 1', tool_call_id: 'c1' },
      { role: 'tool', content: 'out 2', tool_call_id: 'c2' },
    ];
    expect(replayAssistantHistory(row)).toEqual(flat);
    expect(replayAssistantHistory(row, [])).toEqual(flat); // 步骤丢失 ≠ 半截证据
    // 键序也钉住:直连 chat-completions 时消息对象可能原样透传上 wire,退不了交错的行(旧行 /
    // steer 拆段 / 毒化行 / thin worker)字节必须与 B3 之前**逐字**相同,连一次性失配都不该有。
    expect(JSON.stringify(replayAssistantHistory(row)[1])).toBe('{"role":"tool","tool_call_id":"c1","content":"out 1"}');
  });

  it('a poisoned row (over the single-message cap) is not split, keeping the old truncation ceiling', () => {
    // 每轮 60k 字符:**单条**都不超帽(100k),拼起来 180k 超帽。不设闸⓪的话拆开回放会原样吐 180k,
    // 等于把「单条巨型消息永久毒化会话」那道防线捅开 —— 这类行必须维持整行截一次的老行为。
    const huge = ['x', 'y', 'z'].map((ch) => ch.repeat(60_000));
    const big = {
      content: huge.join('\n\n'),
      tool_calls: huge.map((_, i) => call(`h${i}`)),
      tool_results: huge.map((_, i) => ({ tool_call_id: `h${i}`, content: `out ${i}` })),
    };
    const bigSteps: ReplayStep[] = huge.map((text, i) => ({ step_no: i, llm_response: { content: text }, tool_calls: [call(`h${i}`)] }));
    const rows = replayAssistantHistory(big, bigSteps);
    expect(rows).toEqual(replayAssistantHistory(big)); // 退回扁平
    expect(JSON.stringify(rows).length).toBeLessThan(10_000); // 整行只截一次(~2.5k),而非三段 60k
  });

  // ── 负对照:三道闸各自失守时,必须整体退回扁平(宁可维持旧行为,绝不吐半截证据)。──
  it('NEGATIVE CONTROL: steps that do not account for the row fall back to flat', () => {
    const flat = replayAssistantHistory(row);
    // 少一个工具轮(步骤写了一半的 run)
    expect(replayAssistantHistory(row, steps.slice(0, 1))).toEqual(flat);
    // 多出本行没有的调用(运行时转向把一个 run 拆成两条 assistant 消息,却查出整个 run 的步骤)
    expect(replayAssistantHistory(row, [...steps, { step_no: 9, llm_response: { content: '' }, tool_calls: [call('c9')] }])).toEqual(flat);
    // 正文对不上(纠错轮等:正文进了在线消息却没进 finalContent)
    expect(replayAssistantHistory(row, steps.map((s, i) => (i ? s : { ...s, llm_response: { content: 'DIVERGED' } })))).toEqual(flat);
  });

});

// ── providerItems 的落库(stepLlmResponse)与回放(模型 + 协议绑定闸)。文件头 ①②③ 是这几条的正典。──
describe('providerItems cross the run boundary only for the model and protocol that signed them', () => {
  const M = { apiModelId: 'gpt-5.6-luna', provider: 'openai', protocol: 'openai-responses' };
  /** 回放侧的「本 run 身份」:与写侧同一个模型、同一个协议。 */
  const SAME = { apiModelId: M.apiModelId, protocol: M.protocol };
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' };
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'looking' }] };
  const fc = (id: string) => ({ type: 'function_call', call_id: id, name: 'find_roots', arguments: '{"text":"Music"}' });
  const row = { content: 'looking\n\ndone', tool_calls: [call('c1')], tool_results: [{ tool_call_id: 'c1', content: 'out 1' }] };
  const stepsWith = (llm: any): ReplayStep[] => [
    { step_no: 0, llm_response: llm, tool_calls: [call('c1')] },
    { step_no: 1, llm_response: { content: 'done' } },
  ];
  /** 在线时 assistantTurnOf 原样挂在 assistant 轮上的那一组(Responses 流的 output_item.done 顺序)。 */
  const inRunGroup = [reasoning, message, fc('c1')];
  /** 读侧拿到的 step 必须是**写侧真正产出的那个形状**(outputItemsJson 字符串),不是手搓的数组。 */
  const withItems = stepsWith(stepLlmResponse({ content: 'looking', usage: { prompt_tokens: 1 }, outputItems: inRunGroup }, M));

  /** PostgreSQL 的 jsonb 会重排对象键(等价、但**不同字节**)。生产上 llm_response 就是 jsonb,而本仓
   *  测试跑在 SQLite 的 TEXT 列上、天然保序 —— 不显式模拟这一步,这条纪律就永远是假绿。
   *  这里用「键名升序」代替 PG 的具体规则:结论只取决于「键序会变」,不取决于变成哪一种序。 */
  const jsonbNormalize = (v: any): any => {
    if (Array.isArray(v)) return v.map(jsonbNormalize);
    if (v && typeof v === 'object') {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = jsonbNormalize(v[k]);
      return out;
    }
    return v;
  };
  /** 一次生产往返:写侧产物 → 列里(JSON.stringify)→ jsonb 归一化 → 读回来。 */
  const roundTrip = (llm: any): any => jsonbNormalize(JSON.parse(JSON.stringify(llm)));

  it('write side persists the in-run group verbatim (message items included), bound to the producing model', () => {
    const persisted = stepLlmResponse({ content: 'looking', usage: { prompt_tokens: 1 }, outputItems: inRunGroup }, M);
    // 逐字同序 —— message 项照落(文件头 ③):不落它,回放该轮时 preamble 正文不上 wire,
    // 字节前缀在原 message 项的位置分叉,此后每个 run 都从那里 miss。
    expect(persisted.outputItemsJson).toBe(JSON.stringify(inRunGroup));
    expect(persisted.outputItems).toBeUndefined(); // 不再同时存一份解析好的副本(没人读它)
    expect(persisted.outputItemsModel).toEqual(M); // 模型 + 协议 + provider 三件都落
    expect(persisted.content).toBe('looking');
    expect(persisted.usage).toEqual({ prompt_tokens: 1 });
    // 白名单:上游将来新增的 item 类型一律不落(未知字段绝不回灌上 wire)
    expect(stepLlmResponse({ content: '', outputItems: [{ type: 'web_search_call', id: 'ws' }] }, M).outputItemsJson).toBeUndefined();
    // 没有模型绑定 → 回放判不了同不同源,逐字仍是升级前的 { content, usage }
    expect(stepLlmResponse({ content: 'x', usage: { a: 1 }, outputItems: [reasoning] })).toEqual({ content: 'x', usage: { a: 1 } });
  });

  it('write side drops the whole set past the per-step cap and leaves a marker', () => {
    const fat = { type: 'reasoning', id: 'rs_big', encrypted_content: 'E'.repeat(STEP_ITEMS_MAX_BYTES + 4_096) };
    const persisted = stepLlmResponse({ content: 'looking', usage: {}, outputItems: [fat, fc('c1')] }, M);
    expect(persisted.outputItemsJson).toBeUndefined(); // 整组丢,绝不存半组(半组回灌 = 上游 400)
    expect(persisted.outputItemsDropped).toEqual({ reason: 'size', bytes: expect.any(Number) });
    expect(persisted.outputItemsDropped.bytes).toBeGreaterThan(STEP_ITEMS_MAX_BYTES);
    // 刚好不超帽的那一组照常落库(帽子不是「有 encrypted_content 就丢」)
    expect(stepLlmResponse({ content: '', outputItems: [reasoning, fc('c1')] }, M).outputItemsJson)
      .toBe(JSON.stringify([reasoning, fc('c1')]));
  });

  it('replays the persisted items when the new run uses the same model and protocol', () => {
    const rows = replayAssistantHistory(row, withItems, SAME);
    expect(rows.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant']);
    // 回放挂上的这一组 === 在线时那一组(含 message 项、同序):Responses 路径整组替代,
    // 只有逐字相等,下个 run 的字节前缀才不在这一轮分叉。
    expect((rows[0] as any).providerItems).toEqual(inRunGroup);
    // Anthropic 形态(thinking + signature,没有 function_call 项)同样回放 —— 那条路径是块相加的
    const think = { type: 'thinking', thinking: 'COT', signature: 'SIG' };
    const AM = { apiModelId: 'claude-sonnet-9', provider: 'anthropic', protocol: 'anthropic-messages' };
    const anthropic = stepsWith(stepLlmResponse({ content: 'looking', outputItems: [think] }, AM));
    expect((replayAssistantHistory(row, anthropic, { apiModelId: AM.apiModelId, protocol: AM.protocol })[0] as any).providerItems).toEqual([think]);
    // 托管面(两侧都没有协议)也照常挂:归一成 '' 后仍然相等,不能因为「没有协议」就一律不挂。
    const hosted = stepsWith(stepLlmResponse({ content: 'looking', outputItems: inRunGroup }, { apiModelId: 'hosted-x' }));
    expect((replayAssistantHistory(row, hosted, { apiModelId: 'hosted-x' })[0] as any).providerItems).toEqual(inRunGroup);
    // 升级前那批行(outputItems 存的是解析好的数组)读侧仍认,只是不享受下面那条字节保真。
    const legacy = stepsWith({ content: 'looking', outputItems: inRunGroup, outputItemsModel: M });
    expect((replayAssistantHistory(row, legacy, SAME)[0] as any).providerItems).toEqual(inRunGroup);
  });

  // 生产是 jsonb:键序会被规范化。items 以**字符串**落库正是为了这条 —— 存数组的话下面第二条会红。
  it('items survive PostgreSQL jsonb key normalization byte for byte', () => {
    const persisted = roundTrip(stepLlmResponse({ content: 'looking', usage: {}, outputItems: inRunGroup }, M));
    const rows = replayAssistantHistory(row, stepsWith(persisted), SAME);
    expect(JSON.stringify((rows[0] as any).providerItems)).toBe(JSON.stringify(inRunGroup));
  });

  it('NEGATIVE CONTROL: the jsonb normalizer really does reorder keys (so the test above is not vacuous)', () => {
    // 同一组 items 以数组形态存进 jsonb:对象仍等价,**字节已经变了** —— 那一轮上 wire 就分叉。
    const asArray = roundTrip({ outputItems: inRunGroup }).outputItems;
    expect(asArray).toEqual(inRunGroup);
    expect(JSON.stringify(asArray)).not.toBe(JSON.stringify(inRunGroup));
    // 正对照:字符串字段一个字节不动。
    expect(roundTrip(stepLlmResponse({ content: '', outputItems: inRunGroup }, M)).outputItemsJson)
      .toBe(JSON.stringify(inRunGroup));
  });

  // 负对照:模型绑定闸失守的三种形态。都必须**只丢 items**,交错本身一个字节不变 —— 绑定闸
  // 不是第四道「退回扁平」的闸(交错与模型无关,思考态才与模型有关)。
  it('NEGATIVE CONTROL: another model, an empty model or no model replays the interleave without providerItems', () => {
    const match = replayAssistantHistory(row, withItems, SAME);
    const stripped = match.map((m) => { const c: any = { ...(m as any) }; delete c.providerItems; return c; });
    for (const other of [{ apiModelId: 'claude-sonnet-9', protocol: M.protocol }, { apiModelId: '', protocol: M.protocol }, undefined]) {
      const rows = replayAssistantHistory(row, withItems, other);
      expect((rows[0] as any).providerItems).toBeUndefined();
      expect(rows).toEqual(stripped);
    }
    // 正对照:同一个模型时 items 确实在(否则上面全绿只说明断言写反了)
    expect((match[0] as any).providerItems).toEqual(inRunGroup);
  });

  // 负对照(评审 2026-09-15 #2 的原场景):同一个 apiModelId,上一 run 思考开 → tuneOpenAiDirectPayload
  // 动态改道 /v1/responses 并落下 items;这一 run 思考关 → 退回 /chat/completions。只比模型 ID 的话
  // 这组 Responses 私有 item 会原样挂回 assistant 消息,严格网关见到未知键直接 400。
  it('NEGATIVE CONTROL: items signed on one protocol never replay into a run on another', () => {
    const chat = replayAssistantHistory(row, withItems, { apiModelId: M.apiModelId }); // 无协议 = chat-completions
    expect((chat[0] as any).providerItems).toBeUndefined();
    expect(chat.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant']); // 交错照旧,只丢 items
    expect(chat).toEqual(replayAssistantHistory(row, withItems, SAME)
      .map((m) => { const c: any = { ...(m as any) }; delete c.providerItems; return c; }));
    // 反向也一样:chat-completions 落的行不许挂进 Responses run(协议名不同即不同源)。
    const other = stepsWith(stepLlmResponse({ content: 'looking', outputItems: inRunGroup }, { ...M, protocol: 'anthropic-messages' }));
    expect((replayAssistantHistory(row, other, SAME)[0] as any).providerItems).toBeUndefined();
    // 正对照:协议对上,items 立刻回来。
    expect((replayAssistantHistory(row, withItems, SAME)[0] as any).providerItems).toEqual(inRunGroup);
  });

  // 负对照:只剩 message 项的那一轮 —— 它照样触发 openaiToResponsesBody 的「整组替代」,本轮
  // tool_calls 随之消失,紧随其后的 function_call_output 找不到父项。itemsCoverCalls 必须把它
  // 也拦下(闭集认 Anthropic、其余按 Responses 过闸),而不是只拦「有 reasoning / function_call」的那些。
  it('NEGATIVE CONTROL: a message-only group for a turn that has calls is dropped whole', () => {
    const only = stepsWith(stepLlmResponse({ content: 'looking', outputItems: [message] }, M));
    const rows = replayAssistantHistory(row, only, SAME);
    expect(rows.map((r) => r.role)).toEqual(['assistant', 'tool', 'assistant']); // 交错照旧,只丢 items
    expect((rows[0] as any).providerItems).toBeUndefined();
    expect((rows[0] as any).tool_calls.map((c: any) => c.id)).toEqual(['c1']); // 调用还在 → 不会 400
    // 正对照:补上本轮的 function_call 项,items 立刻回来
    const full = stepsWith(stepLlmResponse({ content: 'looking', outputItems: [message, fc('c1')] }, M));
    expect((replayAssistantHistory(row, full, SAME)[0] as any).providerItems)
      .toEqual([message, fc('c1')]);
  });

  // 负对照:Responses 形态的 items 没覆盖本轮全部调用 → 整组作废。回灌半组会让紧随其后的
  // function_call_output 找不到父项,上游 400,而且此后该会话每个 run 都炸。
  it('NEGATIVE CONTROL: Responses items that miss one of the turn calls are dropped whole', () => {
    const twoRow = { content: 'looking\n\ndone', tool_calls: [call('c1'), call('c2')], tool_results: [{ tool_call_id: 'c1', content: 'o1' }, { tool_call_id: 'c2', content: 'o2' }] };
    const twoSteps = (items: any[]): ReplayStep[] => [
      { step_no: 0, llm_response: stepLlmResponse({ content: 'looking', outputItems: items }, M), tool_calls: [call('c1'), call('c2')] },
      { step_no: 1, llm_response: { content: 'done' } },
    ];
    const missing = replayAssistantHistory(twoRow, twoSteps([reasoning, fc('c1')]), SAME);
    expect(missing.map((r) => r.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']); // 交错照旧
    expect((missing[0] as any).providerItems).toBeUndefined();
    // 正对照:补齐 c2 的 function_call 项,items 立刻回来
    const full = replayAssistantHistory(twoRow, twoSteps([reasoning, fc('c1'), fc('c2')]), SAME);
    expect((full[0] as any).providerItems).toEqual([reasoning, fc('c1'), fc('c2')]);
  });
});
