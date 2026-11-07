# Build stage: bundles the client. Dev dependencies stop here.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY scripts ./scripts
COPY client ./client
COPY shared ./shared
RUN node scripts/build.mjs

# Runtime stage: production dependencies, server source and the built client.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV DB_PATH=/data/tinkerlands.db
ENV PUBLIC_DIR=/app/dist/public
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
