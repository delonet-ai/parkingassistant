FROM node:22-bookworm-slim AS base

WORKDIR /app

ENV TZ=Europe/Moscow

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY package.json ./

RUN npm install --omit=dev

FROM base AS runtime

COPY --from=deps /app/node_modules /app/node_modules
COPY package.json /app/package.json
COPY apps /app/apps
COPY scripts /app/scripts

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-lc", "echo 'Replace runtime command in docker-compose or Dockerfile' && sleep infinity"]
