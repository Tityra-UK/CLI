# Node's official multi-platform manifest, verified 2026-10-30.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build

RUN apk upgrade --no-cache \
    && npm install --global npm@11.21.1 \
    && rm -rf /opt/yarn* /usr/local/lib/node_modules/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack \
      /usr/local/bin/pnpm /usr/local/bin/pnpx

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime

LABEL org.opencontainers.image.title="Tityra CLI" \
      org.opencontainers.image.source="https://github.com/Tityra-UK/CLI" \
      org.opencontainers.image.description="Customer-scoped Tityra account command-line client" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOME=/home/node \
    XDG_CONFIG_HOME=/home/node/.config

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/LICENSE /app/NOTICE ./
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
      /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && mkdir -p /home/node/.config/tityra \
    && chown -R node:node /home/node/.config

USER node
VOLUME ["/home/node/.config/tityra"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["--help"]
