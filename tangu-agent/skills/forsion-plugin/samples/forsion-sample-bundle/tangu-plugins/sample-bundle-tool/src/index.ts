/**
 * 捆绑包内嵌引擎插件示例:与独立引擎插件(forsion-sample-plugin)**完全同构**——同一 manifest
 * (tangu-plugin.json)、同一构建纪律(对核心仅 `import type`,dist/ 已提交)。唯一区别是住在
 * Forsion 插件的 tangu-plugins/ 子目录里,由引擎经 bundle 搜索根原地发现(tangu-agent bundles.ts),
 * 并随父插件在桌面统一插件页里级联启停。
 */
import type { TanguPlugin, PluginMeta, ToolProvider, ToolContext, AppProfile } from '@forsion/tangu-agent';

const ID = 'sample-bundle-tool';

const plugin: TanguPlugin = {
  activate(ctx) {
    const store = ctx.sdk.pluginStore;
    // 工具门禁:插件启用才对模型可见(父 Forsion 插件启停会级联写这个开关)。
    const gate = (_profile: AppProfile, _c: ToolContext): boolean => store.isPluginEnabledSync(ID);

    const toolProvider: ToolProvider = {
      id: 'plugin:sample-bundle-tool',
      tools: () => [
        {
          name: 'sample_bundle_echo',
          mode: 'both',
          isEnabledFor: gate,
          capabilities: { sideEffect: 'none', parallel: true },
          definition: {
            type: 'function',
            function: {
              name: 'sample_bundle_echo',
              description: 'Echo a message back. Demo tool from the sample bundle (an engine plugin embedded inside a Forsion plugin).',
              parameters: {
                type: 'object',
                properties: { message: { type: 'string', description: 'Text to echo back' } },
                required: ['message'],
              },
            },
          },
          execute: (args, _c: ToolContext) => `echo: ${String(args.message ?? '')}`,
        },
      ],
    };

    const meta: PluginMeta = {
      id: ID,
      name: '示例捆绑工具',
      nameEn: 'Sample Bundle Tool',
      description: '捆绑包模板的内嵌引擎插件:演示 bundle 里的工具贡献。',
      descriptionEn: 'Engine plugin embedded in the sample bundle: demonstrates a bundled tool contribution.',
      scopes: ['global'],
      // 捆绑语义:随包即用;父 Forsion 插件禁用时经级联把本开关一并关掉。
      defaultEnabled: true,
      settings: { fields: [] },
      toolProvider,
    };

    ctx.registerPlugin(meta);
    ctx.log('sample-bundle-tool activated');
  },
  deactivate() { /* 本插件无外部资源,无需清理 */ },
};

export default plugin;
