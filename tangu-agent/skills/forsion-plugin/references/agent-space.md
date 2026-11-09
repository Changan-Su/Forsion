# Agent 自建 Space(2026-09-11 起)

> 2026-11-08 起 Muse 的 Space 不再走这条路(改成宿主画的「今日简报」,见 SKILL.md「Muse: Today's brief layout」);今天没有 agent 用它,接口留给以后自建 Space 的 agent。


一个 agent 自己的 Space = 它目录下的一个桌面插件:`<tangu>/agents/<slug>/Space/{manifest.json, main.js}`,与普通桌面插件**同一份契约**(manifest + main.js,`registerView` / `registerCommand` / `registerStatusItem` / `registerSetting` / `notify` / `loadData` 都能用),但有五条不同:

> ⚠️ **main.js 整个文件就是 `setup(ctx)` 的函数体**(宿主 `new Function('ctx', code)(ctx)`):`ctx` 已在作用域里,顶层直接写 `ctx.registerView({ id: 'home', … })`。**别**写成 `function setup(ctx) { … }` —— 没人调用它,求值只声明了一个函数,零注册、零报错。09-27 实机:Muse 的 Space 每一版都这么包,从首建起空白了 16 天,它自己还一直在「升级」。

1. **id 固定 `agent-<slug>`**,manifest 里的 `id` 被无视 —— 写别家的 id 也顶不掉真插件;
2. **主槽 = `registerView({ id: 'home', … })`**:桌面该 agent 的 Space 主区渲染这一个视图,其它视图照常 `ctx.openView` 开标签页;
3. `capabilities` / `fileExtensions` / `requiresApp` / `onboarding` / `events` 一律不生效(没有「用户点安装」这步授权),bundle 子目录(引擎插件/技能/agents/spaces)也**不生效**(引擎只认一个 bundle 根);
4. 纯 JS、无构建、无 CDN(CSP `default-src 'self'`);想用库就内联进 main.js;
5. **不监听文件**:桌面按引擎在你周期收尾时打的内容戳重载,所以一个周期里改完再收尾即可;加载失败(setup 抛错 / manifest 缺失、坏或被 apiVersion·minAppVersion 挡下 / 装上了却没注册 `home` / `home` 的 mount 抛错)会以 `[feedback]` 行回到你的日志,下个周期修。**没收到 feedback 不等于用户看到了你的 Space** —— 它只在桌面打开过 Muse Space / Muse 面板时才会发。

## `ctx.agent`:读写你自己的数据(2026-09-27 起,**只有 agent 自建 Space 有**)

Your Space renders your own status, TODOs, schedule and Library from `ctx.agent` instead of hardcoding them: the member table, the click-only `updateTodo` rule and an example are in [references/tangu-host-apis.md](references/tangu-host-apis.md), section `ctx.agent`. Read it before the Space shows any of that data.
