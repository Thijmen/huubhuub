FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4
# Tools the agent commonly shells out to.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl bash jq less openssh-client python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json bot.opencode.jsonc ./
COPY src ./src

ENV NODE_ENV=production \
    WORKSPACE_DIR=/workspace \
    DATA_DIR=/data \
    HOME=/data/home \
    XDG_CONFIG_HOME=/data/config \
    XDG_DATA_HOME=/data/share \
    XDG_CACHE_HOME=/data/cache \
    XDG_STATE_HOME=/data/state \
    SHELL=/bin/bash

RUN mkdir -p /workspace /data && chown -R bun:bun /workspace /data
USER bun
VOLUME ["/workspace", "/data"]
EXPOSE 8080

CMD ["bun", "src/index.ts"]
