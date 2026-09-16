# syntax=docker/dockerfile:1

# The base image already carries the browsers, matched to the Playwright version
# in package.json. Bump both together — a mismatch makes Playwright re-download
# Chromium at runtime, into a layer that is not there.
ARG PLAYWRIGHT_VERSION=1.63.0

# ---------------------------------------------------------------- build ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Manifests first so the dependency layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src src
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Stamped by CI so a running instance can say which build it is.
ARG NEMLIG_MCP_VERSION=dev
ENV NEMLIG_MCP_VERSION=$NEMLIG_MCP_VERSION

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist dist

# Session tokens live on a mounted volume so a restart does not mean a new
# browser login. The file is written 0600 — it is effectively the credentials.
ENV NEMLIG_DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
VOLUME /data

USER pwuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
