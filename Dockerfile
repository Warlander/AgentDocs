FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
RUN npm ci
COPY . .
RUN npm run build -w web

FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production \
    VAULT_DIR=/vault \
    WEB_DIST=/app/packages/web/dist \
    HOST=0.0.0.0
EXPOSE 3000 3001
ENTRYPOINT ["./docker-entrypoint.sh"]
