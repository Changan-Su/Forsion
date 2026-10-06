# tangu-sample-theme

Forsion Desktop **磁盘主题包**模板 —— 两个文件就是一个主题：`theme.json`（清单）+ `theme.css`（样式）。

## 先理解双轴模型（最重要的一件事）

Forsion 的主题分两根正交的轴：

- **设计语言**（`data-theme`，即本主题包）：只管**结构**——圆角、字体、阴影、面板布局；
- **配色**（`data-skin`，应用内置 cream/coral/teal/lavender/custom）：管全部**颜色** token。

所以正确的主题包**不定义颜色**：`--bg`、`--bg-card`、`--accent`、`--border`、`--glow` 等颜色 token 只「消费」不「定义」，这样你的语言配任何配色都成立。若你执意在语言里定颜色：light 块定义了哪些颜色变量，`.dark[data-theme=…]` 暗色块就必须**逐一同名镜像**，否则暗色模式会继承亮色残值。

## 快速开始

```bash
git clone https://github.com/Changan-Su/tangu-sample-theme
```

把文件夹拷到 `~/.forsion/themes/sample-theme/`（**文件夹名必须等于 theme.json 的 `id`**，kebab-case，`lovable` 是保留字），然后在 设置 → 主题 点「重新加载主题」——你的主题卡片立即出现在「设计语言」区。改 CSS 后再点一次重载即热更新，无需重启。

## 契约速查

- `theme.json` 必填：`id`（=目录名）、`name`、`description`、`version`（商店更新检查读它）、`supportsDarkMode`、`preview.background`（可 light/dark 双值）、`preview.accent`。可选：`author`、`tags`、`panelGap`（>0 时外壳给停靠面板留间距做浮卡）、`fonts.google`（激活时懒加载，务必写本地字体兜底）、`preview.swatches/tagline/title`。
- `theme.css` 全局注入**不隔离**——每条规则都要挂 `[data-theme='<id>']` 前缀，否则泄漏到其他主题。暗色块用 `.dark[data-theme='<id>']`；建议尊重扁平开关 `[data-theme='<id>'][data-flat='1']`（清空阴影）。
- 参考实现：应用首启种子的 `~/.forsion/themes/soft/`（渐变舞台 + 浮卡结构的完整案例）。

## 发布到 Forsion 商店

把 `theme.json` + `theme.css` 打包成 zip（俩文件在 zip 根或单层文件夹内均可，安装器会自动重定根），在 Forsion 个人中心 → 投稿 选「主题」提交；或推成 GitHub 公开仓（发 release）。注意：**上架名称的 slug 会成为安装目录名**，须是合法主题 id（kebab，非 `lovable`）。

---

## English (short)

A Forsion Desktop disk theme = `theme.json` + `theme.css` in `~/.forsion/themes/<id>/`. Themes are the *structure* axis (radius/font/shadow); colors come from the built-in *skin* axis — consume color tokens, don't define them (or mirror every color var in the `.dark[data-theme=…]` block). Scope every rule under `[data-theme='<id>']`. Reload live via Settings → Theme → Reload themes.

MIT © Changan Su
