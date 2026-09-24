# Install stage: bun install and its cache stay here.
FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Final stage: the locked dependencies and the sources, run as the image's non-root `bun` user.
FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY . .
ENV NODE_ENV=production
USER bun
EXPOSE 3000
# The image has no curl, so Bun makes the request.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}${process.env.PREFIX ?? ''}/health/live`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Replaces the base image's entrypoint script: run the project directly.
ENTRYPOINT ["bun", "index.ts"]
