FROM node:22-bookworm-slim AS base

WORKDIR /app

ENV TZ=Europe/Moscow

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates dumb-init \
  && rm -rf /var/lib/apt/lists/*

FROM base AS runtime

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-lc", "echo 'Replace admin-web runtime command in docker-compose or Dockerfile' && sleep infinity"]

