FROM golang:1.22-alpine AS agent
WORKDIR /src
COPY infra-sentinel-agent/ ./
RUN set -e; \
    for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do \
      os="${target%/*}"; arch="${target#*/}"; \
      CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -ldflags "-s -w" -o "dist/infra-sentinel-agent-$os-$arch" .; \
    done

FROM node:22-alpine AS build
ARG PNPM_VERSION=10.17.0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /app
COPY infra-sentinel-api/package.json infra-sentinel-api/pnpm-lock.yaml infra-sentinel-api/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY infra-sentinel-api/ ./
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    LOG_FORMAT=json \
    AGENT_DIR=/app/agent
WORKDIR /app
RUN addgroup -S sentinel && adduser -S sentinel -G sentinel
COPY --from=build --chown=sentinel:sentinel /app/node_modules ./node_modules
COPY --from=build --chown=sentinel:sentinel /app/dist ./dist
COPY --from=build --chown=sentinel:sentinel /app/package.json ./package.json
COPY --from=agent --chown=sentinel:sentinel /src/dist ./agent/dist
COPY --chown=sentinel:sentinel infra-sentinel-agent/install.sh ./agent/install.sh
USER sentinel
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main"]
