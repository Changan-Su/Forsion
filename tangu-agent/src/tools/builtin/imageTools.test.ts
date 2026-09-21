/** generate_image 的生图模型解析:必须把「云端目录不可达」与「目录在但没开生图模型」分开
 *  —— 两者用户动作不同(重新登录 vs 去设置页开模型),混成一句会把掉线用户支错方向。 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

const brainWith = (models: any) => ({ host: {} as any, billing: {} as any, brain: { models } as any });

describe('firstImageModelId', () => {
  let configureTangu: any, createTanguProfile: any, firstImageModelId: any;
  beforeAll(async () => {
    ({ configureTangu } = await import('../../seams/runtime.js'));
    ({ createTanguProfile } = await import('../../profiles/index.js'));
    ({ firstImageModelId } = await import('./imageTools.js'));
  });
  const setup = (models: any) =>
    configureTangu({ ...brainWith(models), profile: createTanguProfile({ sandboxMode: 'none' }) } as any);

  it('admin 的 app 级生图默认槽优先', async () => {
    setup({ listModelsForProject: async () => ({ models: [], imageModelId: 'gpt-image-2-c' }) });
    expect(await firstImageModelId('tangu')).toEqual({ id: 'gpt-image-2-c' });
  });

  it('无默认槽 → 目录里第一个 image_gen', async () => {
    setup({ listModelsForProject: async () => ({ models: [{ id: 'a', modelType: 'llm' }, { id: 'b', modelType: 'image_gen' }], imageModelId: null }) });
    expect(await firstImageModelId('tangu')).toEqual({ id: 'b' });
  });

  it('目录在、没有生图模型、也无直连 → cloudEmpty=false(去设置页开模型)', async () => {
    setup({ listModelsForProject: async () => ({ models: [{ id: 'a', modelType: 'llm' }], imageModelId: null }) });
    expect(await firstImageModelId('tangu')).toEqual({ id: null, cloudEmpty: false });
  });

  it('目录一条都没有(401/断网被 httpBrain 降级成空数组) → cloudEmpty=true(提示重新登录)', async () => {
    setup({ listModelsForProject: async () => ({ models: [], imageModelId: null }) });
    expect(await firstImageModelId('tangu')).toEqual({ id: null, cloudEmpty: true });
  });

  it('reachable 在场就信它:目录非空但 reachable=false 仍算不可达', async () => {
    setup({ listModelsForProject: async () => ({ models: [{ id: 'a', modelType: 'llm' }], imageModelId: null, reachable: false }) });
    expect(await firstImageModelId('tangu')).toEqual({ id: null, cloudEmpty: true });
  });

  it('reachable=true 的空目录 = admin 真没授权,不该叫人重新登录', async () => {
    setup({ listModelsForProject: async () => ({ models: [], imageModelId: null, reachable: true }) });
    expect(await firstImageModelId('tangu')).toEqual({ id: null, cloudEmpty: false });
  });

  it('目录调用抛错也算不可达,且不冒泡', async () => {
    setup({ listModelsForProject: async () => { throw new Error('401'); } });
    expect(await firstImageModelId('tangu')).toEqual({ id: null, cloudEmpty: true });
  });

  it('云端无果 → 回落直连 provider 的 imageModelIds', async () => {
    setup({
      listModelsForProject: async () => ({ models: [], imageModelId: null }),
      listDirectProviders: () => [{ providerId: 'p', modelIds: ['m'] }, { providerId: 'q', imageModelIds: ['q-img'] }],
    });
    expect(await firstImageModelId('tangu')).toEqual({ id: 'q-img' });
  });
});

describe('generate_image 解不出模型时的文案', () => {
  const run = async (models: any) => {
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    const { imageGenProvider } = await import('./imageTools.js');
    configureTangu({
      host: {} as any, billing: {} as any,
      brain: { models, images: { generate: async () => ({ images: [] }) } } as any,
      profile: createTanguProfile({ sandboxMode: 'none' }),
    } as any);
    const tool = imageGenProvider.tools()[0];
    return tool.execute({ prompt: 'a cat' }, { appId: 'tangu', displayFile: () => {} } as any);
  };

  it('云端目录空 → 支去重新登录,而不是设置页', async () => {
    const out = await run({ listModelsForProject: async () => ({ models: [], imageModelId: null }) });
    expect(out).toContain('重新登录');
    expect(out).not.toContain('设置 → 模型');
  });

  it('目录在但没开生图模型 → 支去设置页', async () => {
    const out = await run({ listModelsForProject: async () => ({ models: [{ id: 'a', modelType: 'llm' }], imageModelId: null }) });
    expect(out).toContain('设置 → 模型');
    expect(out).not.toContain('重新登录');
  });
});

/** 这轮改动的**主诉求**就是「失败要进诊断包」——诊断包只收 console。
 *  没有这条,以后谁把 console.warn 删了,上面的测试照样全绿。 */
describe('generate_image 失败必须留日志', () => {
  const runWith = async (brain: any) => {
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    const { imageGenProvider } = await import('./imageTools.js');
    configureTangu({ host: {} as any, billing: {} as any, brain, profile: createTanguProfile({ sandboxMode: 'none' }) } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await imageGenProvider.tools()[0].execute({ prompt: 'a cat' }, { appId: 'tangu', displayFile: () => {} } as any);
      return { out, logged: warn.mock.calls.map((c) => c.join(' ')).join('\n') };
    } finally { warn.mockRestore() }
  };

  it('解不出模型', async () => {
    const { logged } = await runWith({ models: { listModelsForProject: async () => ({ models: [], imageModelId: null, reachable: false }) }, images: {} });
    expect(logged).toMatch(/未解析到生图模型.*cloudEmpty=true/);
  });

  it('后端未接入生图', async () => {
    const { out, logged } = await runWith({ models: {} });
    expect(out).toContain('未接入生图后端');
    expect(logged).toMatch(/未注入 images/);
  });

  it('生图调用抛错', async () => {
    const { logged } = await runWith({
      models: { listModelsForProject: async () => ({ models: [], imageModelId: 'img-1', reachable: true }) },
      images: { generate: async () => { throw new Error('402 quota'); } },
    });
    expect(logged).toMatch(/生图失败\(model=img-1\).*402 quota/s);
  });

  it('后端返回 0 张图', async () => {
    const { out, logged } = await runWith({
      models: { listModelsForProject: async () => ({ models: [], imageModelId: 'img-1', reachable: true }) },
      images: { generate: async () => ({ images: [] }) },
    });
    expect(out).toContain('生图未返回图片');
    expect(logged).toMatch(/返回 0 张图\(model=img-1\)/);
  });
});

/** 档位(quality)必须原样到达 brain,且只放白名单里的六档 —— 模型编一个 'ultra' 出来就是上游 400。 */
describe('generate_image 的 quality 档位', () => {
  const sent = async (args: Record<string, unknown>) => {
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    const { imageGenProvider } = await import('./imageTools.js');
    let seen: any = null;
    configureTangu({
      host: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }),
      brain: {
        models: { listModelsForProject: async () => ({ models: [], imageModelId: 'img-1', reachable: true }) },
        images: { generate: async (req: any) => { seen = req; return { images: [{ b64: 'AA==', mime: 'image/png' }] } } },
      } as any,
    } as any);
    await imageGenProvider.tools()[0].execute({ prompt: 'a cat', ...args }, { appId: 'tangu', displayFile: () => {} } as any);
    return seen;
  };

  it('六档原样透传', async () => {
    for (const tier of ['low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
      expect((await sent({ quality: tier })).quality).toBe(tier);
    }
  });

  it('不传就不发(让上游用自己的缺省,不替用户选贵档)', async () => {
    expect((await sent({})).quality).toBeUndefined();
  });

  it('编出来的档位当没传', async () => {
    expect((await sent({ quality: 'ultra' })).quality).toBeUndefined();
    expect((await sent({ quality: 'BEST' })).quality).toBeUndefined();
  });

  it('大小写/空格归一', async () => {
    expect((await sent({ quality: ' XHigh ' })).quality).toBe('xhigh');
  });
});

/** Seedream 回 JPEG:落盘扩展名与展示 mime 必须跟字节走,否则 edit_image 拿它当参考图时字节校验会拒收。 */
describe('生图结果的 mime 跟字节走', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]).toString('base64');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');

  it('imageMimeOf 认 PNG / JPEG / WebP,未知回落 PNG', async () => {
    const { imageMimeOf } = await import('../../seams/cloudBrain.js');
    expect(imageMimeOf(PNG)).toBe('image/png');
    expect(imageMimeOf(JPEG)).toBe('image/jpeg');
    expect(imageMimeOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64'))).toBe('image/webp');
    expect(imageMimeOf('AAAA')).toBe('image/png');
  });

  it('JPEG 结果 → .jpg 文件名 + image/jpeg dataUrl', async () => {
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    const { imageGenProvider } = await import('./imageTools.js');
    configureTangu({
      host: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }),
      brain: {
        models: { listModelsForProject: async () => ({ models: [], imageModelId: 'seedream', reachable: true }) },
        images: { generate: async () => ({ images: [{ b64: JPEG, mime: 'image/jpeg' }] }) },
      } as any,
    } as any);
    const shown: any[] = [];
    await imageGenProvider.tools()[0].execute({ prompt: 'x' }, { appId: 'tangu', displayFile: (f: any) => shown.push(f) } as any);
    expect(shown[0].name).toMatch(/\.jpg$/);
    expect(shown[0].mime).toBe('image/jpeg');
    expect(shown[0].dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});
