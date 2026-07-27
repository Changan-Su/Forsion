# forsion-sample-bundle — 捆绑包(bundle)开发模板

**捆绑包 = 一个 Forsion 桌面插件目录,内嵌引擎侧/跨域内容,装一处全就位。**
解决的痛点:此前「插件 + Agent + 技能 + Space」要分装三四处目录、靠 install 脚本铺;
现在整包拷进 `~/.forsion/plugins/<id>/`(或市场一键装)即可。
2026-07-25 起,捆绑包是新扩展的**默认推荐形态** —— 只发一类内容也可以用此布局,之后加层零迁移。

## 结构(全部子目录可选,按标志文件识别)

```
sample-bundle/
├── manifest.json                 ← bundle 标志 = 普通 Forsion 插件 manifest(无新增字段)
├── main.js                       ← UI 部分(可省:纯捆绑包无 UI 也合法,宿主按 no-op 处理)
├── check.mjs                     ← 宿主同构自检(node check.mjs)
├── tangu-plugins/                ← 内嵌引擎插件(标志:tangu-plugin.json)
│   └── sample-bundle-tool/
│       ├── tangu-plugin.json
│       ├── src/index.ts          ← 对核心仅 import type;运行时全走 ctx.sdk
│       ├── types/tangu-agent.d.ts ← 类型契约(与 forsion-sample-plugin 同一份,勿改)
│       └── dist/index.js         ← 已提交的构建产物(装包免构建)
├── agents/                       ← 内嵌 Agent(标志:config.toml)
│   └── sample-bundle-agent/
│       ├── config.toml
│       ├── SOUL.md
│       └── skills/sample-bundle-skill/SKILL.md   ← agent 级技能,随 Agent 播种
├── spaces/                       ← 内嵌 Space(标志:space.json)
│   └── sample-bundle-space/space.json
└── README.md / CHANGELOG.md      ← 设置详情页会渲染
```

## 宿主怎么识别(零注册表,全靠标志文件)

| 内容 | 谁识别 | 机制 |
|---|---|---|
| 根 manifest.json + main.js | Forsion 桌面 | 与普通 Forsion 插件完全一致 |
| `tangu-plugins/<pid>/` | Tangu 引擎 | 追加进插件搜索根,**原地加载**(优先级最低:顶不掉首方/用户手装的同 id) |
| `skills/<slug>/`(包根,本模板未用) | Tangu 引擎 | 追加进全局技能扫描根(内置 < bundle < 用户,同 id 用户胜) |
| `agents/<slug>/` | Tangu 引擎 | 启动/重扫时**播种一次**到 `tangu/agents/`(已存在永不覆盖) |
| `spaces/<slug>/` | Forsion 桌面 | spaces:list 汇入,随插件启停显隐(用户目录同 id 优先) |

## 两种生命周期(务必理解再发包)

- **随包**(引擎插件、Space):父插件禁用 → 内嵌引擎插件被级联关闭、Space 收起;卸载父插件 → 一并消失。
- **播种一次**(Agent,含其 skills/):首次发现拷入引擎成为**活体**(有自己的 MEMORY/LOG);
  包升级**不覆盖**用户已改的 SOUL/记忆,卸载包也**保留** agent(用户可在 Agents 页手动删)。
  因此 onboarding 里**不要**再 recommends 自家已内嵌的 agent/skill(会引导去市场重复装)。

## 开发循环

1. 改代码。内嵌引擎插件构建:`cd tangu-plugins/sample-bundle-tool && npm i && npm run build`;
   没有本地 node_modules 时可借 Genesis:`../../../../Forsion-Genesis/tangu-agent/node_modules/.bin/tsc -p .`。
2. 自检:`node check.mjs`(UI 部分)+ 引擎部分 `tsc --noEmit`。
3. 整目录拷到 `~/.forsion-dev/plugins/sample-bundle/`,重启 desktop(引擎插件/Agent 变更需重启引擎;
   纯 UI 改动「重新加载」即可)。
4. 真机点验:统一插件页看捆绑徽章与级联启停;Agents 页看播种;ribbon 看 Space。

## 发布

zip 整个目录(单顶层文件夹)上架市场 **amadeus-plugin** 类;桌面安装路由按包内 manifest 实测
(最浅的 manifest.json 优先),bundle 自然落到 `~/.forsion/plugins/<slug>/`。
真实范例:`Forsion-Instrumentality-Project/bluebird/`(视频分析四件套的捆绑化)。
