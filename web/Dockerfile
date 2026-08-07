# =====================================================
# Forsion Web(内部代号 Tangu Web)— 独立前端(React19 + Vite + Nginx),连 Forsion server /api → tangu worker。
# 镜像同 AI Studio 套路;区别:web 经 vite 别名复用 desktop/frontend/src,故
# 构建上下文必须是 Forsion-Genesis/(含 web/ 与 desktop/frontend/),而非 web/。
#
#   docker build -f web/Dockerfile -t tangu-web .        # 在 Forsion-Genesis/ 下执行
#   docker run -p 8090:80 -e BACKEND_URL=http://host.docker.internal:3001 tangu-web
# (.dockerignore 用同目录 web/Dockerfile.dockerignore:放行 desktop/frontend、排除 node_modules/dist)
# =====================================================

# ---- Build stage ----
FROM node:22-alpine AS builder
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
# changelog.ts 经 `?raw` 内联 desktop 根的 CHANGELOG.md(关于页用),frontend/ 之外唯一外部引用。
COPY desktop/CHANGELOG.md ./desktop/CHANGELOG.md
COPY web ./web
RUN cd web && npm run build   # vite 经 /app/node_modules 解析全部依赖 → /app/web/dist(base '/')

# ---- Production stage (Nginx) ----
FROM nginx:alpine AS production
RUN apk add --no-cache gettext
COPY web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY web/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=builder /app/web/dist /usr/share/nginx/html
EXPOSE 80
CMD ["/docker-entrypoint.sh"]
