# syntax=docker/dockerfile:1
# Stage 1: build the catalog + Next.js static export, then precompress text assets.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
# .env.production sets NEXT_PUBLIC_VISIT_URL=/api/visit for this build.
RUN npm run build && node server/precompress.mjs out

# Stage 2: runtime. Node built-ins only, so no node_modules are copied.
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/out
WORKDIR /app
COPY --from=build --chown=root:root /app/out ./out
COPY --from=build --chown=root:root /app/server ./server
COPY --from=build --chown=root:root /app/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "server/server.mjs"]
