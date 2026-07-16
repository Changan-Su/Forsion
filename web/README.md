# Forsion Web

浏览器端云客户端(内部代号 **Tangu Web**,镜像/容器名 `tangu-web`)。经 vite 别名**复用 `desktop/frontend/src` 渲染层**,打包成一个纯前端站点,由自带 nginx 托管;运行时把 `/api`、`/auth` 等反代到已部署的 **Forsion server**(→ tangu worker)。

> **它不挂在 server 的路由下**,是独立部署的 app(和 AI Studio / Echo 同套路):自己的容器、自己的 nginx、自己的域名。server 只当后端网关用。

```
浏览器 ──▶ Forsion Web(nginx :80)
             ├─ /            静态 SPA(dist/)
             └─ /api /auth … 反代 ──▶ Forsion server(:3001) ──▶ tangu worker
```

---

## 本地开发

连一个本地在跑的 Forsion server(默认 `http://localhost:3001`)。

```bash
cd Forsion-Genesis/web
npm install
npm run dev            # vite dev server，默认 http://localhost:5273
```

- 端口默认 **5273**、`strictPort`(占用即报错,不静默漂移)。撞端口就在 `web/.env` 里设 `PORT=`。
- dev 阶段 vite 把 `/api /auth /account /shared /oauth /shop /pay /legal` 反代到 `TANGU_DEV_PROXY`(默认 `http://localhost:3001`),前端同源、免 CORS。
- 配置从 `web/.env` 读(见 [`.env.example`](./.env.example));复制一份即可:`cp .env.example .env`。

---

## 生产部署(Docker)

⚠️ **构建上下文必须是 `Forsion-Genesis/`,不是 `web/`。** 因为 web 复用了上层 `desktop/frontend`、`desktop/shared`、`lcl` 的源码,构建时要一起 COPY 进镜像。在 `web/` 下 build 会因找不到这些目录而失败。

### 方式一:docker compose(推荐)

```bash
cd Forsion-Genesis
BACKEND_URL=http://host.docker.internal:3001 \
  docker compose -f web/docker-compose.yml up -d --build
```

站点默认发布在宿主机 **`:8090`**(`WEB_PORT` 可改)。

### 方式零:服务器免构建(推荐,CI 出镜像只管 pull)

**小内存服务器别现场 `--build`**:vite 打包吃内存,2G 机器会 swap 卡死(实测 25min+ 出不来)。GitHub Actions `build-web` 在 `web/**` 推 main 时自动构建并推 `ghcr.io/changan-su/forsion-web:latest`(desktop 渲染层/lcl 改了想吃到新代码:GitHub → Actions → build-web → Run workflow)。

```bash
cd Forsion-Genesis
docker compose -f web/docker-compose.yml pull
BACKEND_URL=... docker compose -f web/docker-compose.yml up -d --no-build
```

首次注意:ghcr 的 package 默认 private——要么去 GitHub → 头像 → Packages → forsion-web → Package settings 把 visibility 改 public(之后服务器免登录),要么服务器 `docker login ghcr.io -u <用户名> -p <有 read:packages 的 PAT>`。想钉住版本:`WEB_IMAGE=ghcr.io/changan-su/forsion-web:<commit-sha>`。

### 方式二:docker build / run

```bash
cd Forsion-Genesis
docker build -f web/Dockerfile -t tangu-web .
docker run -d --name tangu_web -p 8090:80 \
  --add-host=host.docker.internal:host-gateway \
  -e BACKEND_URL=http://host.docker.internal:3001 \
  tangu-web
```

镜像是两段式:`node:22-alpine` 构建 → `nginx:alpine` 托管。容器启动时 `docker-entrypoint.sh` 用 `envsubst` 把 `BACKEND_URL` / `NGINX_RESOLVER` / `PORT` 注入 nginx 配置(见 [`nginx.conf.template`](./nginx.conf.template))。

---

## 环境变量

| 变量 | 层 | 默认 | 说明 |
|---|---|---|---|
| `PORT` | dev | `5273` | vite dev server 端口(`strictPort`) |
| `TANGU_DEV_PROXY` | dev | `http://localhost:3001` | dev 反代目标 = Forsion server |
| `VITE_API_URL` | 运行时 | 空 = `location.origin + /api` | 仅「前端与后端不同源」时才设(如直连远端 `https://api.forsion.net/api`)。须 `VITE_` 前缀才进 bundle |
| `WEB_PORT` | prod(compose) | `8090` | 宿主机映射端口 |
| `BACKEND_URL` | prod(容器) | `http://host.docker.internal:3001` | nginx 把 `/api` `/auth` 等反代到的 server 地址 |
| `PORT` | prod(容器) | `80` | 容器内 nginx 监听端口(改了要同步 `-p <host>:<PORT>`) |
| `NGINX_RESOLVER` | prod(容器) | 取容器 `resolv.conf`,兜底 `127.0.0.11` | 变量式 `proxy_pass` 所需 DNS |

`BACKEND_URL` 取值示例:
- 同机 server:`http://host.docker.internal:3001`(compose 已配 `extra_hosts`,Linux 也能解析)
- 局域网:`http://192.168.1.100:3001`
- 已上线后端:`https://api.forsion.net`

---

## 域名 / HTTPS / 登录回跳

生产建议在容器前再套一层反代(Caddy / nginx / Traefik)做 TLS:`https://app.forsion.net` → 容器 `:8090`。

**登录流程**:web 无 token 时跳同源 `/auth`(由容器 nginx 反代到 server 的登录页),登录成功带 `?token` 回跳本站。所以只要 `/auth` 能正常反代到 server,跨域名部署也不需要额外配置。

**Amadeus 分享/邀请链接**:桌面端生成的邀请链接指向 web 应用域名。若同时部署了桌面共享功能,需在 **server 端**设 `AMADEUS_WEB_ORIGIN` = 本站公网地址(如 `https://app.forsion.net`),否则邀请链接会 404。

---

## 三个坑(已在配置里处理,排障时对照)

1. **build context** — 必须在 `Forsion-Genesis/` 下 build(见上)。`web/Dockerfile.dockerignore` 专门放行 `desktop/frontend`(根 `.dockerignore` 默认排除整个 `desktop`)。
2. **nginx resolver** — 变量式 `proxy_pass` 需要 `resolver`。entrypoint 取容器**实际** `resolv.conf` 的 nameserver;硬编码 `127.0.0.11` 在默认桥接网会 `Connection refused` → `/api` 502。
3. **React 单实例** — web 与 desktop 各有 `node_modules/react`,跨目录复用会加载两份 React → hooks 报 `Cannot read properties of null (reading 'useState')` + 白屏。`vite.config.ts` 里 `dedupe: ['react','react-dom']` 强制单实例。

---

## 排障

```bash
docker compose -f web/docker-compose.yml logs -f   # 看容器日志
curl -I http://localhost:8090/                     # 站点是否起来(healthcheck 同款)
curl -I http://localhost:8090/api/health           # /api 反代是否通(通=后端 server 正常)
```

- **白屏 + 控制台 useState null** → React 两份,查 `dedupe`。
- **`/api` 502** → `BACKEND_URL` 不可达,或 resolver 问题;Linux 上 `host.docker.internal` 不解析要确认 `extra_hosts` / `--add-host`。
- **登录跳转打不开** → `/auth` 没反代到 server,查 `BACKEND_URL` 与 nginx `location ~ ^/(auth|account|shared|oauth)`。
