# syntax=docker/dockerfile:1
#
# MCP server image.
#
# The runtime stage installs the packed tarballs rather than copying the build tree,
# so the image contains exactly the artifact `pnpm pack` publishes and
# `scripts/verify-package.mjs` checks. If publishing is broken, this image is broken
# too, which is the correct coupling.
#
# sharp is installed in the runtime stage so its prebuilt native binary is chosen for
# the image platform rather than the build host.
#
# The server speaks MCP over stdio, so there is no port and no HEALTHCHECK worth
# writing: readiness is "the process is up and answering initialize", which the
# client establishes on connect. It must be run with stdin attached (`docker run -i`).
#
# Build from the repository root:
#   docker build -f packages/mcp/Dockerfile -t perfectvector/mcp:0.1.0 .

FROM node:24-bookworm-slim AS builder

RUN npm install --global pnpm@11.1.2

WORKDIR /src

# Manifests first so dependency installation is cached independently of sources.
# Every workspace manifest has to be present or --frozen-lockfile rejects the tree,
# even though only two of the packages are being built.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY apps/web/package.json apps/web/

# `@perfectvector/mcp...` pulls in its workspace dependencies and nothing else, which
# keeps Next.js and the browser-test tooling out of the build.
# --ignore-scripts keeps this identical to every other install in the project; see the
# comment in pnpm-workspace.yaml. sharp's native binary is a prebuilt optional package,
# so nothing here needs a build step.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@perfectvector/mcp..."

COPY packages/core packages/core
COPY packages/mcp packages/mcp

RUN pnpm --filter @perfectvector/core build \
 && pnpm --filter @perfectvector/mcp build

# pnpm, not npm: npm leaves `"@perfectvector/core": "workspace:*"` in the manifest,
# which no registry can resolve.
RUN mkdir -p /pack \
 && cd packages/core && pnpm pack --pack-destination /pack \
 && cd ../mcp && pnpm pack --pack-destination /pack


FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="PerfectVector MCP server" \
      org.opencontainers.image.description="Raster to clean SVG vectorization over the Model Context Protocol" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

WORKDIR /app

COPY --from=builder /pack/*.tgz /tmp/pack/

RUN npm install --omit=dev --no-audit --no-fund \
      /tmp/pack/perfectvector-core-0.1.0.tgz \
      /tmp/pack/perfectvector-mcp-0.1.0.tgz \
 && rm -rf /tmp/pack /root/.npm \
 && chown -R node:node /app

# Images the server is asked to convert are mounted here; declaring it makes the
# intended usage explicit and gives the unprivileged user somewhere writable.
RUN mkdir -p /work && chown node:node /work
VOLUME ["/work"]
WORKDIR /work

USER node

ENTRYPOINT ["node", "/app/node_modules/@perfectvector/mcp/dist/server.js"]
