const id = 'health-reader';
const name = 'read_health_summary';
const description =
  "Read the signed-in user's authorized Mi Fitness summaries for seven calendar days ending on endDate. Returns steps, sleep minutes, workout counts and seconds by day. Null means unavailable. Use for questions about the user's own measured activity or sleep.";
export default {
  activate(ctx) {
    if (!ctx.cloud) return;
    const tool = {
      name,
      mode: 'both',
      capabilities: { sideEffect: 'read', parallel: false, defaultTimeoutMs: 45000 },
      isEnabledFor: () => ctx.sdk.pluginStore.isPluginEnabledSync(id),
      definition: {
        type: 'function',
        function: {
          name,
          description,
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              endDate: {
                type: 'string',
                description: 'Inclusive YYYY-MM-DD. Defaults to today in the specified timezone.',
              },
              timezone: {
                type: 'string',
                description: 'IANA timezone such as Europe/London. Defaults to the local runtime timezone.',
              },
            },
          },
        },
      },
      async execute(args, context) {
        const { endDate, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone } = args ?? {};
        const result = await ctx.cloud.request({
          path: '/api/wellness/agent/summary',
          method: 'POST',
          body: { endDate, timezone },
          signal: context?.signal,
          timeoutMs: 40000,
        });
        if (result.status === 200) return JSON.stringify(result.json);
        return JSON.stringify({
          error: result.json?.code || result.error || 'health_unavailable',
          status: result.status,
        });
      },
    };
    ctx.registerPlugin({
      id,
      name: '健康',
      nameEn: 'Health',
      description: '读取用户授权的健康摘要。',
      descriptionEn: description,
      defaultEnabled: true,
      scopes: ['global'],
      settings: { fields: [] },
      toolProvider: { id: 'plugin:' + id, tools: () => [tool] },
    });
  },
};
