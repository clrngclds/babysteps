# syntax=docker/dockerfile:1
# Content pipeline image (SDD §8). One image, one CLI; the Cloud Run Job args pick the subcommand.
# Build from the repo root: docker build -f pipeline/Dockerfile .  (Cloud Build: pipeline/cloudbuild.yaml)

# Stage 1: bundle pipeline/src/cli.ts (and scripts/catalog-lib.ts, which it imports) into one ESM file.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx esbuild pipeline/src/cli.ts --bundle --platform=node --target=node22 --format=esm \
      --outfile=dist/pipeline.mjs \
      --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
 && chmod -R a+rX dist pipeline data

# Stage 2: runtime. Node built-ins plus the bundle; config files and seed data alongside.
FROM node:22-bookworm-slim
ENV NODE_ENV=production PIPELINE_ROOT=/app PIPELINE_CLI=1
WORKDIR /app
COPY --from=build --chown=root:root /app/dist/pipeline.mjs ./dist/pipeline.mjs
COPY --from=build --chown=root:root /app/pipeline/sources.yaml /app/pipeline/safety_rules.yaml ./pipeline/
COPY --from=build --chown=root:root /app/data ./data
USER node
ENTRYPOINT ["node", "dist/pipeline.mjs"]
CMD ["status"]
