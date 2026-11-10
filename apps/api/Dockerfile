# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD curl -fsS http://localhost:3000/ready || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
# Migrimet ekzekutohen para nisjes; janë të bllokuara me advisory lock, kështu që disa replika nuk përplasen.
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
