#!/bin/sh
# 注入运行时变量到 nginx 配置:
# - BACKEND_URL:Forsion server 地址(/api、/auth 等代理到这里)。
# - NGINX_RESOLVER:nginx 变量式 proxy_pass 需要 resolver;取容器实际 resolv.conf 的 nameserver
#   → 默认桥接网(docker run)与 compose 用户网(127.0.0.11)都可用。硬编码 127.0.0.11 在默认桥接网会
#   "Connection refused" 导致 /api 502。
set -e
export BACKEND_URL=${BACKEND_URL:-http://host.docker.internal:3001}
# /etc/hosts 里的主机名(extra_hosts 写入的 host.docker.internal 等)预解析成 IP:
# nginx 变量式 proxy_pass 只问 DNS resolver,Docker 内嵌 DNS 不服务 /etc/hosts 条目 →
# Linux 上 "host not found" 502(mac 的 Docker Desktop 在 VM 层能解析,故本地测不出)。
# 公网域名不在 /etc/hosts → 不动,仍走 resolver(保留 DNS 轮换/延迟解析语义)。
BK_HOST=$(echo "$BACKEND_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##')
BK_IP=$(awk -v h="$BK_HOST" '$0 !~ /^#/ { for (i=2; i<=NF; i++) if ($i == h) { print $1; exit } }' /etc/hosts)
if [ -n "$BK_IP" ] && [ "$BK_IP" != "$BK_HOST" ]; then
  export BACKEND_URL=$(echo "$BACKEND_URL" | sed "s#//$BK_HOST#//$BK_IP#")
  echo "[entrypoint] BACKEND_URL 主机 $BK_HOST 命中 /etc/hosts → $BACKEND_URL"
fi
export NGINX_RESOLVER=${NGINX_RESOLVER:-$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)}
export NGINX_RESOLVER=${NGINX_RESOLVER:-127.0.0.11}
# PORT:容器内 nginx 监听端口(默认 80)。改这个记得同步 docker 端口映射 -p <host>:<PORT>。
export PORT=${PORT:-80}
case "${WEB_ENTRY_MODE:-unit}" in
  unit) web_template=/etc/nginx/templates/unit.conf.template ;;
  legacy) web_template=/etc/nginx/templates/default.conf.template ;;
  *) echo '[entrypoint] WEB_ENTRY_MODE must be unit or legacy' >&2; exit 1 ;;
esac
envsubst '$BACKEND_URL $NGINX_RESOLVER $PORT' < "$web_template" > /etc/nginx/conf.d/default.conf
exec nginx -g "daemon off;"
