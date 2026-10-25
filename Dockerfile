FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
  # The opencode binary is copied into @opencode/cli by its postinstall; the image is glibc, so drop the musl build.
  && rm -rf node_modules/@opencode/cli-*-musl

FROM oven/bun:1.4
# Tools the agent commonly shells out to, faad for voice notes from the phone app (AAC), plus the GitHub CLI
# from GitHub's own apt repo.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl bash jq less openssh-client python3 faad \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json bot.opencode.jsonc ./
COPY bin ./bin
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
EXPOSE 8080 8081 4196

CMD ["bun", "src/index.ts"]
