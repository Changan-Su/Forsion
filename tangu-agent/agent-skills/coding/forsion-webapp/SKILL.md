---
name: Forsion 网页构建约定
description: 在 Forsion 的 Coding Space 里构建网页/前端应用时**必须先读**。讲清本环境的即时预览规则——importmap + esm.sh 拉任意 npm 包、可直接写 JSX/TSX(预览端自动转译)、无构建步骤、无 npm install、多文件结构、index.html 入口。写任何 web 代码前遵循本约定。
version: 1.0.0
category: Forsion
---

# Forsion 网页构建约定

Coding Space 的预览 = 一个本地 dev-server:把项目目录整挂到 `http://127.0.0.1`,用 `<iframe>` 展示。它像 Vite dev 一样**按需转译 `.ts/.tsx/.jsx`**(逐文件、不打包、不 typecheck),裸依赖(`react` 等)由页面 importmap 从 CDN 解析。

**因此:不要 `npm install`、不要写构建脚本、不要 `package.json` 依赖当真实依赖装。** 你产出的是浏览器可直接跑的文件,写完即时刷新预览。

## 铁律

1. **入口永远是项目根的 `index.html`**。它声明 importmap(列出你用到的每个 npm 包)+ 加载入口模块。
2. **像真实项目一样多文件**:拆成 `index.tsx` / `App.tsx` / `components/*.tsx` / `styles.css`,用**相对路径**互相 import。别把所有东西塞进一个文件。
3. **用包,别从头写**:React 以及任意 npm 库(状态、路由、图表、动画、UI 组件、图标、日期…)都经 importmap → `https://esm.sh/<包名>@<版本>` 引入。
4. **可自由写 JSX / TSX / TypeScript**——预览端会转译。React 自动 JSX 运行时要求 importmap **必须含 `react/jsx-runtime`**。
5. **CSS 用 `<link rel="stylesheet">` 挂在 index.html**,不要在 JS 里 `import "./x.css"`(那不是合法 ESM)。
6. 每次 `write_file` / `edit_file` 后预览自动刷新;迭代就直接改文件。

## 最小 React 起步模板

`index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="./styles.css" />
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@18",
          "react-dom/client": "https://esm.sh/react-dom@18/client",
          "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime"
        }
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./index.tsx"></script>
  </body>
</html>
```

`index.tsx`:

```tsx
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
createRoot(document.getElementById('root')!).render(<App />)
```

`App.tsx`:

```tsx
export default function App() {
  return <h1>Hello Forsion</h1>
}
```

## 加一个 npm 包

只需在 importmap 里加一行,再正常 import:

```html
<script type="importmap">
  { "imports": {
    "react": "https://esm.sh/react@18",
    "react-dom/client": "https://esm.sh/react-dom@18/client",
    "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime",
    "zustand": "https://esm.sh/zustand@4",
    "lucide-react": "https://esm.sh/lucide-react@0.400.0?deps=react@18"
  }}
</script>
```

```tsx
import { create } from 'zustand'
import { Heart } from 'lucide-react'
```

- 有 peer 依赖(如 `lucide-react` 依赖 react)时,用 `?deps=react@18` 让 esm.sh 复用同一份 React,避免「两个 React 实例」报错。
- 版本尽量写死(`@18`、`@4`),别用裸包名不带版本。

## 不用纯 React 时

原生多文件也行:`index.html` + `app.js`(`<script type="module" src="./app.js">`)+ `styles.css`。同样可 import ESM 包与相对模块。

## 常见坑

- **白屏**:多半是 importmap 少了某个裸依赖(含 `react/jsx-runtime`),或包有 peer 依赖没加 `?deps=`。先看预览控制台报错。
- **`import "./x.css"`** 报错:CSS 不能当模块 import,改用 `<link>`。
- **需要打包/Node API 的包**(fs、原生插件、只发 CommonJS 且 esm.sh 转不了的)在本环境跑不了;换纯浏览器可用的等价库。
- 别依赖 `package.json` / `node_modules`:预览不读它们,写了也不会被安装。
