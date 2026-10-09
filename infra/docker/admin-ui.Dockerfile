# Two stages: the first builds the SPA, the second serves it.
#
# The build needs the Vision UI tarballs in vendor/ — they come from an internal registry and
# are deliberately not in git (this repository is public), so they are placed on the host once,
# the same way staging/env/app.env is. A build without them fails loudly at npm install rather
# than producing a styleless bundle.
#
# The runtime stage carries no node_modules on purpose: apps/admin-ui/server.js is node
# builtins only — static files, the floor-plan images and the same-origin /api proxy.

FROM node:22-bookworm-slim AS build

WORKDIR /build

ENV TZ=Europe/Moscow

COPY vendor /build/vendor
COPY apps/admin-ui/package.json apps/admin-ui/package-lock.json /build/apps/admin-ui/
COPY apps/admin-ui/scripts /build/apps/admin-ui/scripts

WORKDIR /build/apps/admin-ui

RUN npm ci --no-audit --no-fund

COPY apps/admin-ui/index.html apps/admin-ui/vite.config.js /build/apps/admin-ui/
COPY apps/admin-ui/src /build/apps/admin-ui/src

RUN npm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV TZ=Europe/Moscow

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY apps/admin-ui/package.json /app/package.json
COPY apps/admin-ui/server.js apps/admin-ui/multipart.js /app/
COPY --from=build /build/apps/admin-ui/dist /app/dist

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
