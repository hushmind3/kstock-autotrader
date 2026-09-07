FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS engine
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /var/lib/kstock && chown node:node /var/lib/kstock && chmod 700 /var/lib/kstock
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/trading-engine/package.json ./trading-engine/package.json
COPY --from=build /app/trading-engine/dist ./trading-engine/dist
USER node
EXPOSE 3210
CMD ["node", "trading-engine/dist/index.js"]

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/web/package.json ./web/package.json
COPY --from=build /app/web/next.config.ts ./web/next.config.ts
COPY --from=build /app/web/scripts ./web/scripts
COPY --from=build /app/web/.next ./web/.next
USER node
EXPOSE 3100
CMD ["node", "web/scripts/next-run.mjs", "start"]
