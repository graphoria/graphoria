ARG BUN_VERSION=1.3.6

FROM oven/bun:${BUN_VERSION} AS base
WORKDIR /app

# ============================================
# Development dependencies
# ============================================
FROM base AS install-dev
RUN mkdir -p /temp/dev

# Copy root package.json, lockfile, and workspace config
COPY package.json bun.lock /temp/dev/

# Copy ALL workspace package.json files (required for lockfile integrity)
COPY packages/server/package.json /temp/dev/packages/server/
COPY packages/react/package.json /temp/dev/packages/react/

# Install all dependencies (dev + prod)
RUN cd /temp/dev && bun install --frozen-lockfile

# ============================================
# Production dependencies
# ============================================
FROM base AS install-prod
RUN mkdir -p /temp/prod

# Copy root package.json, lockfile, and workspace config
COPY package.json bun.lock /temp/prod/

# Copy ALL workspace package.json files (required for lockfile integrity)
COPY packages/server/package.json /temp/prod/packages/server/
COPY packages/react/package.json /temp/prod/packages/react/

# Install production dependencies only
RUN cd /temp/prod && bun install --frozen-lockfile --production

# ============================================
# Development target
# ============================================
FROM base AS dev

# Preserve workspace structure - copy entire install directory
COPY --from=install-dev /temp/dev/node_modules ./node_modules
COPY --from=install-dev /temp/dev/packages ./packages

# Copy source code into workspace
COPY packages/server/src ./packages/server/src
COPY packages/server/tsconfig.json ./packages/server/

# Keep root package.json and tsconfig.json for workspace resolution
COPY package.json tsconfig.json ./

WORKDIR /app/packages/server

ENV NODE_ENV=development

EXPOSE 3000/tcp
CMD ["bun", "run", "--watch", "src/index.ts"]

# ============================================
# Production build
# ============================================
FROM base AS build

# Preserve workspace structure
COPY --from=install-dev /temp/dev/node_modules ./node_modules
COPY --from=install-dev /temp/dev/packages ./packages

# Copy source
COPY packages/server/src ./packages/server/src
COPY packages/server/tsconfig.json ./packages/server/
COPY package.json tsconfig.json ./

WORKDIR /app/packages/server

ENV NODE_ENV=production

# Type check
RUN bun run type-check

# ============================================
# Production release
# ============================================
FROM base AS release

# Preserve workspace structure with prod deps
COPY --from=install-prod /temp/prod/node_modules ./node_modules
COPY --from=install-prod /temp/prod/packages ./packages

# Copy built source
COPY --from=build /app/packages/server/src ./packages/server/src
COPY package.json .

WORKDIR /app/packages/server

ENV NODE_ENV=production

USER bun
EXPOSE 3000/tcp
ENTRYPOINT ["bun", "run", "src/index.ts"]