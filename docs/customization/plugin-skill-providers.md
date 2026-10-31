# 引擎插件的外部技能来源

[English](plugin-skill-providers.en.md) · [插件开发](plugins.md)

引擎插件在 `activate(ctx)` 中注册实时、只读的技能来源。宿主把它接入原生技能列表、技能载入和 `use_skill`，不复制进用户目录。静态随包技能仍可放在 bundle 的 `skills/` 中。

```js
if (typeof ctx.registerSkillProvider === 'function') {
  ctx.registerSkillProvider({
    id: 'external',
    async list({ cwd, signal }) {
      const rows = await source.list({ cwd, signal });
      return rows.filter(row => row.enabled).map(row => ({
        id: row.slug, name: row.name, description: row.description,
        content: row.instructions,
        ...(row.absoluteDir ? { dir: row.absoluteDir } : {}),
      }));
    },
  });
}
```

`source` 代表插件自己的数据适配器。正式类型在 `tangu-agent/plugin-api/tangu-agent.d.ts`；运行时能力从 `ctx` 获取，不能值导入引擎包。旧宿主先做能力检测，此新增能力不改变 `apiVersion: 1`。

## 身份与读取

- provider 的 `id` 与每项的 `id` 都必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。同一激活实例重复注册相同 provider 会报错；无效条目被忽略。
- 宿主强制生成 `local:plugin/<engineId>/<providerId>/<entryId>`。`engineId` 是宿主实际安装身份（包括市场隔离身份），插件不能指定他人的命名空间。同名用户技能、不同插件和不同 provider 互不覆盖。
- `name` 与 `content` 非空，`description` 为字符串；`content` 是不含 YAML frontmatter 的 Markdown 正文。可选 `dir` 必须为绝对路径，用于资源相对定位；它不授予文件访问权限。
- `cwd` 在当前运行有工作目录时提供。宿主始终提供 `signal`，单次调用 5 秒超时或注册撤销时触发。来源应响应取消，避免后台工作继续占用资源。
- 每次列表/单项读取重新调用来源，包括原生 `use_skill`。仅返回源端已启用且允许模型调用的项；正文变化、禁用和删除会在下次读取生效。单项读取只查询归属 provider。

## 生命周期与管理边界

来源异常、超时或返回无效内容时，只忽略该来源，不影响文件技能和其他来源。宿主不把失败写回源端。插件停用、卸载、替换或激活失败时自动撤销来源，进行中的读取也不能返回旧项；再次启用时会重新执行 `activate`，应在其中重新注册。

来源只读。单技能启停、编辑和删除由源系统管理；用户目录的文件管理接口不列出或修改这些项。`/agent/skills` 摘要保留 `source: 'plugin'`、`origin: null`、`readOnly: true`、`sourcePluginId` 和 `sourceProviderId`。使用这些字段标识归属，不能把它们显示成可写的用户目录文件。发现外部技能不会跳过会话技能选择或工具审批。

## 验证

`src/skills/pluginSkills.test.ts` 覆盖命名、异常、超时和撤销竞态；`pluginSkills.native.test.ts` 覆盖真实 list/get/loadout/use_skill 链、正文更新、删除及同名用户文件隔离；`src/plugins/lifecycle.test.ts` 的 `plugin skill sources` 覆盖市场实例隔离、停用、再启用、卸载和激活失败。`src/routes/assets.origin.test.ts` 校验 HTTP 摘要归属。
