ARG NODE_BASE=ghcr.io/wkarts/argws-scout-node:24.21.0-bookworm-slim
FROM ${NODE_BASE}
ARG SCOUT_GIT_SHA=local
ARG SCOUT_CHANNEL=local
ENV SCOUT_BUILD_SHA=${SCOUT_GIT_SHA} SCOUT_BUILD_CHANNEL=${SCOUT_CHANNEL}

ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" NODE_ENV=production
# Ensure Prisma can discover system OpenSSL/libssl in the Debian slim runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm db:generate && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@argws/scout-api", "start"]
