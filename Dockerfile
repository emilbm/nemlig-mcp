# syntax=docker/dockerfile:1

# Login is a plain HTTP POST now, so there is no browser and no Playwright base
# image — just Node. This keeps the image around ~200 MB instead of ~3.6 GB.

# ---------------------------------------------------------------- build ----
FROM node:24-slim AS build
WORKDIR /app

# Manifests first so the dependency layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src src
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Stamped by CI so a running instance can say which build it is.
ARG NEMLIG_MCP_VERSION=dev
ENV NEMLIG_MCP_VERSION=$NEMLIG_MCP_VERSION

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist dist

# The data volume holds only non-secret session metadata (the credential stays in
# memory); it is here so a session id keeps working across a restart.
ENV NEMLIG_DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
