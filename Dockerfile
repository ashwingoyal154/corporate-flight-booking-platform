# Multi-stage: build with dev dependencies, ship without them.
FROM node:20-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build

# ---- runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The JSON store lives here. On an ephemeral filesystem this resets on redeploy,
# which for a demo is a feature: every deploy starts from clean seeded data.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Do not run as root.
USER node

EXPOSE 3000
ENV PORT=3000

# Seed on boot if the store is empty, then serve. `|| true` because a populated
# store is a normal state, not an error.
CMD ["sh", "-c", "node dist/server/store/seed.js || true; node dist/server/api/server.js"]
