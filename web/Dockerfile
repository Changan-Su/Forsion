# =====================================================
# Forsion Web(内部代号 Tangu Web)— 独立前端(React19 + Vite + Nginx),连 Forsion server /api → tangu worker。
# 独立 nginx 前端镜像;web 经 vite 别名复用 desktop/frontend/src,故
# 构建上下文必须是 Forsion-Genesis/(含 web/ 与 desktop/frontend/),而非 web/。
#
#   docker build -f web/Dockerfile -t tangu-web .        # 在 Forsion-Genesis/ 下执行
#   docker run -p 8090:80 -e BACKEND_URL=http://host.docker.internal:3001 tangu-web
# (.dockerignore 用同目录 web/Dockerfile.dockerignore:放行 desktop/frontend、排除 node_modules/dist)
# =====================================================

# 基础镜像从哪个仓库拉。缺省 Docker Hub:本地 / 服务器现场 build 照旧,daemon 里配的 registry-mirrors 继续生效。
# CI(build-web.yml)传 public.ecr.aws/docker/library —— Docker 官方镜像在 ECR Public 上的同一份(清单摘要逐字相同):
# GitHub 公共 runner 匿名向 Docker Hub 要清单会被限流(429),2026-10-09 连着红了六次。
ARG BASE_REGISTRY=docker.io/library

# ---- Build stage ----
FROM ${BASE_REGISTRY}/node:22-alpine AS builder
WORKDIR /app
# 依赖装在公共祖先 /app(web/ 与 desktop/frontend/ 都在其下):node 解析裸 import 向上找 node_modules,
# 故被别名复用的 desktop 源里的 react/lucide-react/… 也能从 /app/node_modules 解析。
# (本地能直接 build 是因为 desktop/node_modules 兜底;容器里没拷它,必须装到公共祖先。)
COPY web/package.json web/package-lock.json* ./
RUN npm ci
# 被别名复用的 desktop 渲染源(仅源码)+ web 自身
COPY desktop/frontend ./desktop/frontend
COPY desktop/shared ./desktop/shared
COPY lcl ./lcl
# 手机视口经 `@mobile` 别名装载 Mobile 壳(web/src/main.tsx 动态 import),源码必须在场;
# 其裸依赖(framer-motion/zustand/react…)同样从 /app/node_modules 解析,已在 web 的 lock 里。
COPY mobile/src ./mobile/src
# changelog.ts 经 `?raw` 内联 desktop 根的 CHANGELOG.md 与英文版 CHANGELOG.en.md(关于页按语言取),frontend/ 之外唯二的外部引用。
COPY desktop/CHANGELOG.md desktop/CHANGELOG.en.md ./desktop/
# 白板引擎的自托管副本由这支脚本从 node_modules 现生成(web 的 `npm run build` 会先跑 prepare-board)。
# ⚠️ 副本本身**不入库**,所以绝不能指望 COPY desktop/frontend 把它带进来 —— CI 里那个目录是空的。
COPY desktop/build/copy-excalidraw-assets.cjs ./desktop/build/copy-excalidraw-assets.cjs
# 同理:UI 字体预设的裁剪脚本(web 的 prepare-fonts 调它,产物 public/fonts 也不入库)。
COPY desktop/build/gen-fonts.cjs ./desktop/build/gen-fonts.cjs
# web/vite.config.ts 顶层 import '../unit/releasePolicy.mjs'(Unit 发行时校验打包输入;镜像里不启用,但顶层 import 照样求值,
# 缺了它 vite 连配置都加载不了 → 整个 build 红)。只拷这一个文件,别把 unit/ 整目录带进上下文。
COPY unit/releasePolicy.mjs ./unit/releasePolicy.mjs
# 会话图标校验与引擎共用一份:desktop 的 appStore / deviceSessionsStore 直接 import 引擎这个无依赖的纯函数文件。
# 同上,只拷这一个文件,别把 tangu-agent/ 带进上下文。
COPY tangu-agent/src/core/sessionEmoji.ts ./tangu-agent/src/core/sessionEmoji.ts
# Intelligent UI 的文档格式与应用卡片 id 校验也与引擎共用:渲染层(IntelligentUi.tsx / IntelligentAppCard.tsx)直接 import 这两个
# 无依赖的纯函数文件(intelligentUi.ts 只引 ./intelligentCards.js)。同上,只拷文件,别把 tangu-agent/ 带进上下文。
COPY tangu-agent/src/shared/intelligentUi.ts ./tangu-agent/src/shared/intelligentUi.ts
COPY tangu-agent/src/shared/intelligentCards.ts ./tangu-agent/src/shared/intelligentCards.ts
# desktop/shared/product.ts(Unit 分支起共享的产品档案)静态 import ../products/forsion.json;main 上旧的 frontend/product.ts
# 是把回退档案写死在源码里的,所以以前不需要这一层。三个 json 都拷,products.test.ts 无害。
COPY desktop/products ./desktop/products
COPY web ./web
RUN cd web && npm run build   # vite 经 /app/node_modules 解析全部依赖 → /app/web/dist(base '/')

# ---- Production stage (Nginx) ----
FROM ${BASE_REGISTRY}/nginx:alpine AS production
RUN apk add --no-cache gettext
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=builder /app/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["/docker-entrypoint.sh"]
