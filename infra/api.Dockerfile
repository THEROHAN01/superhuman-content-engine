# Multi-stage build for the API and workers (same image, different command).
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/workers/package.json apps/workers/
COPY apps/bot/package.json apps/bot/
COPY packages/utils/package.json packages/utils/
COPY packages/schemas/package.json packages/schemas/
COPY packages/db/package.json packages/db/
COPY packages/prompts/package.json packages/prompts/
COPY packages/adapters/package.json packages/adapters/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
# Never run as root; the app needs no write access to its own files.
USER node
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/db/migrations ./packages/db/migrations
EXPOSE 8080
CMD ["node", "dist/api/server.js"]
