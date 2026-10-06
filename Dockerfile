# ---- 构建阶段：原生 TypeScript + Vite，产物为纯静态文件 ----
FROM node:20-alpine AS build
WORKDIR /app

# 优先拷贝依赖清单以利用层缓存
COPY package.json package-lock.json* ./
RUN npm ci

# 拷贝源码并构建（类型检查由 build 脚本内的 tsc 完成）
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---- 运行阶段：fret 服务仅由 nginx 托管静态页面（离线，无外部请求） ----
FROM nginx:1.27-alpine AS fret
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=3s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
