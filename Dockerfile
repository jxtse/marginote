# Build the publishable bundle, then ship only that.
#
# The runtime stage installs nothing: the release bundle carries its own dependencies, so
# there is no node_modules in the final image and no lockfile resolution at deploy time.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
COPY registry ./registry
COPY scripts ./scripts
COPY docs ./docs
COPY plugins ./plugins
COPY README.md README.zh-CN.md CHANGELOG.md LICENSE SECURITY.md ./
RUN npm ci && npm run build:release && node scripts/check-release.mjs

FROM node:24-alpine AS runtime
# git enables snapshots; ripgrep makes vault search fast (Marginote falls back without it).
RUN apk add --no-cache git ripgrep tini
WORKDIR /app
COPY --from=build /src/packages/cli/dist ./dist
COPY --from=build /src/packages/cli/web ./web
COPY --from=build /src/packages/cli/registry ./registry
COPY --from=build /src/packages/cli/docs ./docs
COPY --from=build /src/packages/cli/plugins ./plugins
COPY --from=build /src/packages/cli/package.json ./package.json

# Run as an unprivileged user. The vault is mounted, so it is the only thing writable.
RUN addgroup -S marginote && adduser -S marginote -G marginote && mkdir -p /vault && chown marginote:marginote /vault
USER marginote
VOLUME ["/vault"]
EXPOSE 4321

# tini reaps zombies, which matters because a vault can spawn git and ripgrep.
ENTRYPOINT ["/sbin/tini", "--"]
# 0.0.0.0 so the container is reachable. Marginote has no authentication, so only publish this
# port on a network you trust -- see SECURITY.md.
CMD ["node", "dist/marginote.js", "/vault", "--host", "0.0.0.0", "--port", "4321"]
