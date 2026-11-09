# 商店来源 / Store sources

> 从 SKILL.md 挪出(正文贴着 use_skill 12 万字符上限)。

不想每版都过审、或者东西很多(一套几十个技能)时,可以让插件在商店左栏「来源」分组里加一个条目,指向你维护的 `forsion-store.json`;用户也能自己点 + 贴地址。**来源只交目录**,卡片、下载、校验、安装、更新、卸载全是商店照常做,插件不画界面(`registerStoreView` 仍只给 Extend)。

- manifest:`"storeSources": [{ "id": "main", "title": { "zh": "…", "en": "…" }, "index": "github:owner/repo", "icon": "image" }]`,≤4 个,`id` 匹配 `^[a-z0-9][a-z0-9-]{0,31}$`。`index` 写 `github:owner/repo`(或 `https://github.com/owner/repo/tree/<ref>/<目录>`)、`npm:<包名>`(读 latest 包根的目录文件)、直接指向 JSON 的 `https://` 地址,或 `forsion-git:owner/repo`(Forsion Git 私有仓;`https://git.forsion.net/owner/repo/src/branch/<ref>/<目录>` 指定分支和子目录)。Forsion Git 由服务端按当前登录的账号去读,只读得到这个人有读权限的仓库;没登录时来源页给登录引导,读不到时报「仓库不存在或没有读权限」;私有目录的相对 `icon` 显示不出来,写完整 https 地址。插件停用 / 卸载,来源随之消失;装过的东西留着、不再自动更新。
- 目录 `{ "schema": 1, "title", "author", "description", "items": [...] }`;每条 `id`(`^[a-z0-9][a-z0-9-]{0,47}$`,**发出去别改**,本机身份 `src-<来源哈希>-<id>` 靠它)、`type`(同投稿类型)、`name`、`version`、`package`,可选 `summary` / `tags` / `icon` / `readme` / `minAppVersion` / `maxAppVersion` / `platforms` / `updatedAt`。
- `package` 四选一:`{ github, ref, path? }`、`{ npm, version, integrity? }`(version 必须等于条目 version)、`{ url, sha256 }`(必须带 sha256)、`{ forsionGit: 'owner/repo', ref, path? }`(服务端按装的人的账号下归档,装的人要登录且有读权限)。**换了包的出处(仓库 / npm 包名 / 下载域名)自动更新会停**,等用户手动点。
- 用户第一次从某个来源装、以及每个插件 / Agent / Space 第一次装前,商店在详情侧栏确认一次;来源条目标「未经 Forsion 审核」,没有评论区,`requiresPlugins` 的 `market` 认不到它们。完整格式见 Genesis 仓 `docs/customization/plugin-development.md`「商店来源」。
