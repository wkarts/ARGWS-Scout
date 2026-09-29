ARG NODE_BASE=node:24.21.0-bookworm-slim
FROM ${NODE_BASE}

ENV PNPM_HOME="/pnpm" PATH="/pnpm:$PATH" NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm db:generate && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@argws/scout-api", "start"]
