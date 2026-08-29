# 随包字体

| 文件 | 用途 | 许可 |
|---|---|---|
| `DancingScript-Bold-latin.woff2` | 主页那句标志性标题「Forsion is All You Need」 | SIL OFL 1.1(`DancingScript-OFL.txt`) |

只取 **latin 子集**(25KB):这句标题是纯拉丁字母,拉丁扩展/越南语两个子集用不上。
`@font-face` 写在 `frontend/src/views/homepage.css`,随视图懒载,不进首屏包。

放 `src/assets/` 而不是 `public/`:让 Vite 接管哈希与 URL 重写 —— 生产是 `file://` 加载,
`public/` 里的绝对路径 `/fonts/…` 会 404(同 index.html 里那条注释的坑)。

⚠️ 不走 Google Fonts 网络链接:Genesis 要能离线跑,网络字体在断网时会静默回落到系统 cursive,
那句标题就不是「同一个」标题了。
